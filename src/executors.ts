import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

import type {
  CredentialBundle,
  ProjectConfig,
  SupadrumConfig
} from "./config.js";
import type { ExecutionResult, Job } from "./domain.js";
import {
  LiveSupabaseExecutor,
  resolveExecutable
} from "./live-executor.js";
import {
  MissingCredentialsError,
  type CredentialProvider,
  type Executor,
  type ResolvedCredentials
} from "./runner.js";

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runProcess(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly stdin?: string;
  } = {}
): Promise<ProcessResult> {
  const [program, ...args] = argv;
  if (!program) throw new Error("Command argv cannot be empty");

  return new Promise((resolveProcess, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolveProcess({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    child.stdin.end(options.stdin);
  });
}

export function redactSecrets(
  text: string,
  secrets: readonly string[]
): string {
  return [...new Set(secrets)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      text
    );
}

export class DryRunCredentialProvider implements CredentialProvider {
  async resolve(): Promise<ResolvedCredentials> {
    return {
      secret_key: "[dry-run]",
      management_token: "[dry-run]",
      database_access: "[dry-run]"
    };
  }
}

export class ProjectModeCredentialProvider implements CredentialProvider {
  readonly #dryRun = new DryRunCredentialProvider();
  readonly #live: CredentialProvider | null;

  constructor(live: CredentialProvider | null) {
    this.#live = live;
  }

  async resolve(
    project: string,
    config: ProjectConfig
  ): Promise<ResolvedCredentials> {
    if (config.target === "local") {
      return {
        secret_key: "[local]",
        management_token: "[local]",
        database_access: "[local]"
      };
    }
    if (config.mode === "dry-run") {
      return this.#dryRun.resolve();
    }
    if (!this.#live) {
      throw new Error(
        `Live project ${project} requires vault_command`
      );
    }
    return this.#live.resolve(project, config);
  }
}

export class VaultCommandCredentialProvider implements CredentialProvider {
  readonly #command: readonly string[];

  constructor(command: readonly string[]) {
    if (command.length === 0) throw new Error("Vault command cannot be empty");
    this.#command = command;
  }

  async resolve(
    _project: string,
    config: ProjectConfig
  ): Promise<ResolvedCredentials> {
    const resolved = {} as ResolvedCredentials;
    for (const name of Object.keys(config.credentials) as Array<
      keyof CredentialBundle
    >) {
      const reference = config.credentials[name];
      if (reference === undefined) continue;
      try {
        resolved[name] = await this.resolveReference(reference);
      } catch {
        throw new MissingCredentialsError([name]);
      }
    }
    return resolved;
  }

  async resolveReference(reference: string): Promise<string> {
    const result = await runProcess(this.#command, {
      env: process.env,
      stdin: `${reference}\n`
    });
    const value = result.stdout.trim();
    if (result.exitCode !== 0 || value.length === 0) {
      throw new Error("Vault reference is not configured");
    }
    return value;
  }
}

export class DryRunExecutor implements Executor {
  async mount(
    _project: string,
    _config: ProjectConfig,
    _credentials: ResolvedCredentials
  ): Promise<void> {}

  async drain(): Promise<void> {}

  async unmount(): Promise<void> {}

  async execute(
    job: Job,
    config: ProjectConfig
  ): Promise<ExecutionResult> {
    return {
      output: {
        mode: "dry-run",
        project: job.project,
        project_ref: config.project_ref,
        operation: job.operation,
        payload: job.payload,
        repo_sha: job.repo_sha
      },
      verification: {
        credential_refs_resolved: false,
        external_process_started: false,
        ok: true
      }
    };
  }
}

export class CommandExecutor implements Executor {
  readonly #baseDirectory: string;

  constructor(baseDirectory: string) {
    this.#baseDirectory = baseDirectory;
  }

  async mount(
    _project: string,
    _config: ProjectConfig,
    _credentials: ResolvedCredentials
  ): Promise<void> {}

  async drain(): Promise<void> {}

  async unmount(): Promise<void> {}

  async execute(
    job: Job,
    config: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    if (job.operation === "session.open") {
      throw new Error("Session opening is handled by the runner");
    }
    const template = config.commands?.[job.operation];
    if (!template) {
      throw new Error(`No command configured for ${job.operation}`);
    }
    const cwd = template.cwd
      ? resolve(this.#baseDirectory, template.cwd)
      : config.repo ?? this.#baseDirectory;
    let repositoryVerified = false;
    if (template.verify_repo_sha) {
      const git = await runProcess(["git", "-C", cwd, "rev-parse", "HEAD"]);
      const actual = git.stdout.trim();
      if (git.exitCode !== 0 || !actual.startsWith(job.repo_sha)) {
        throw new Error(
          `Repository SHA mismatch for ${job.project}: expected ${job.repo_sha}, got ${actual || "unavailable"}`
        );
      }
      repositoryVerified = true;
    }

    const childEnvironment: NodeJS.ProcessEnv = { ...process.env };

    // Chi decide verso quale progetto si spedisce e' la config del broker, non
    // un file nel repository. Senza queste due variabili la CLI Vercel leggerebbe
    // `.vercel/project.json` dalla cartella di lavoro: il target dichiarato qui
    // sarebbe decorativo, e un repository collegato altrove spedirebbe altrove
    // senza che nulla lo segnali. La CLI dà loro la precedenza sulla cartella.
    const deployTarget = config.deploy_target;
    if (deployTarget?.provider === "vercel") {
      childEnvironment.VERCEL_ORG_ID = deployTarget.org_id;
      childEnvironment.VERCEL_PROJECT_ID = deployTarget.project_id;
    }

    for (const [environmentName, credentialName] of Object.entries(
      template.env
    )) {
      const value = credentials[credentialName];
      // A chamber that does not carry this credential must stop here and say
      // which one is missing. Passing an unset variable through would fail
      // inside the tool instead, where the reason is unrecognisable.
      if (value === undefined) {
        throw new MissingCredentialsError([credentialName]);
      }
      childEnvironment[environmentName] = value;
    }

    const steps = template.steps ?? [{ argv: template.argv ?? [] }];
    const values = Object.values(credentials).filter(
      (value): value is string => typeof value === "string"
    );

    let lastExitCode = 0;
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];

    for (const step of steps) {
      const argv = step.argv.map((argument) =>
        renderArgument(argument, job, config)
      );
      const stepCwd = step.cwd
        ? resolve(this.#baseDirectory, step.cwd)
        : cwd;
      const result = await runProcess(argv, {
        cwd: stepCwd,
        env: childEnvironment
      });
      // Steps are labelled so a three-command deploy reads as three commands
      // in the job output, not as one undifferentiated wall of text.
      const label = steps.length > 1 ? `$ ${argv.join(" ")}\n` : "";
      stdoutParts.push(`${label}${result.stdout}`);
      if (result.stderr) stderrParts.push(`${label}${result.stderr}`);
      lastExitCode = result.exitCode;
      // Stop at the first failure: a deploy whose build failed must not ship.
      if (result.exitCode !== 0) break;
    }

    const stdout = redactSecrets(stdoutParts.join(""), values);
    const stderr = redactSecrets(stderrParts.join(""), values);
    if (lastExitCode !== 0) {
      throw new Error(
        `Command failed with exit code ${lastExitCode}: ${stderr.trim()}`
      );
    }

    return {
      output: {
        exit_code: lastExitCode,
        stdout,
        stderr
      },
      verification: {
        exit_code: lastExitCode,
        repo_sha_verified: repositoryVerified
      }
    };
  }
}

export class ProjectModeExecutor implements Executor {
  readonly #dryRun: Executor;
  readonly #live: Executor;
  readonly #command: Executor | null;
  #mounted: Executor | null = null;

  constructor(dryRun: Executor, live: Executor, command?: Executor) {
    this.#dryRun = dryRun;
    this.#live = live;
    this.#command = command ?? null;
  }

  #for(config: ProjectConfig): Executor {
    return config.mode === "live" ? this.#live : this.#dryRun;
  }

  /**
   * Deploys have no built-in adapter, deliberately: the broker does not embed a
   * hosting client, it runs the argv the operator declared. So a live
   * `deploy.*` job goes to the command path instead of the Supabase one, which
   * would only answer "no live adapter" — and the Supabase executor stays what
   * its name says it is.
   */
  #executorFor(job: Job, config: ProjectConfig): Executor {
    if (
      config.mode === "live" &&
      job.operation.startsWith("deploy.") &&
      this.#command
    ) {
      return this.#command;
    }
    return this.#for(config);
  }

  async mount(
    project: string,
    config: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<void> {
    const executor = this.#for(config);
    await executor.mount(project, config, credentials);
    this.#mounted = executor;
  }

  async drain(): Promise<void> {
    await this.#mounted?.drain();
  }

  async unmount(): Promise<void> {
    await this.#mounted?.unmount();
    this.#mounted = null;
  }

  execute(
    job: Job,
    config: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    return this.#executorFor(job, config).execute(
      job,
      config,
      credentials
    );
  }
}

function renderArgument(
  argument: string,
  job: Job,
  config: ProjectConfig
): string {
  return argument.replace(
    /\{\{(project_ref|deploy_project_id|deploy_org_id|repo_sha|payload\.[a-zA-Z0-9_.-]+)\}\}/g,
    (_match, variable: string) => {
      if (variable === "project_ref") return config.project_ref;
      if (variable === "repo_sha") return job.repo_sha;
      // Gli id di deploy vengono dalla config, non dal payload: un job non deve
      // poter scegliere verso quale progetto Vercel spedire.
      if (
        variable === "deploy_project_id" ||
        variable === "deploy_org_id"
      ) {
        const target = config.deploy_target;
        if (!target) {
          throw new Error(
            `Project has no deploy target for ${variable}`
          );
        }
        return variable === "deploy_project_id"
          ? target.project_id
          : target.org_id;
      }
      const path = variable.slice("payload.".length).split(".");
      let value: unknown = job.payload;
      for (const part of path) {
        if (value === null || typeof value !== "object") {
          throw new Error(`Missing command variable: ${variable}`);
        }
        value = (value as Record<string, unknown>)[part];
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(`Command variable must be scalar: ${variable}`);
      }
      return String(value);
    }
  );
}

export function createRuntime(config: SupadrumConfig): {
  readonly credentials: CredentialProvider;
  readonly executor: Executor;
} {
  const liveCredentials = config.vault_command
    ? new VaultCommandCredentialProvider(config.vault_command)
    : null;
  const hasLiveProject = Object.values(config.projects).some(
    (project) => project.mode === "live"
  );
  const liveExecutor = new LiveSupabaseExecutor({
    executables: {
      git: hasLiveProject ? resolveExecutable("git") : "git",
      supabase: hasLiveProject
        ? resolveExecutable("supabase")
        : "supabase",
      psql: hasLiveProject ? resolveExecutable("psql") : "psql"
    },
    ...(liveCredentials
      ? {
          resolveReference: (reference: string) =>
            liveCredentials.resolveReference(reference)
        }
      : {})
  });
  return {
    credentials: new ProjectModeCredentialProvider(liveCredentials),
    executor: new ProjectModeExecutor(
      new DryRunExecutor(),
      liveExecutor,
      new CommandExecutor(dirname(config.config_path))
    )
  };
}

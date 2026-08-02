#!/usr/bin/env node

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { installCodexAgentSetup } from "./agent-setup.js";
import {
  inspectProject,
  loadConfig,
  type SupadrumConfig
} from "./config.js";
import {
  formatCredentialSetup,
  formatCredentialSecurityNotice,
  formatDatabaseAccessGuide,
  formatManagementTokenGuide,
  formatSecretKeyGuide,
  formatProjectAdded,
  formatProjectDoctor
} from "./cli-output.js";
import {
  isBundledKeychainCommand,
  setupProjectCredentials,
  type CredentialName,
  type SecretPrompt
} from "./credential-setup.js";
import { isEntrypoint } from "./entrypoint.js";
import {
  DryRunCredentialProvider,
  DryRunExecutor
} from "./executors.js";
import { databasePassword } from "./live-executor.js";
import {
  addLocalProject,
  addProject,
  discoverProject,
  discoverProjectRepository,
  doctorProject,
  projectProfiles,
  resolveOperatorConfigPath,
  setMigrationDriver,
  setMigrationOwner,
  setProjectMode,
  setProjectRepository,
  shareProjectChamber,
  type ProjectProfile
} from "./projects.js";
import { Runner } from "./runner.js";
import { readMaskedSecret } from "./secret-prompt.js";
import { SqliteStore } from "./store.js";
import {
  MacOsKeychainBackend,
  nodeProcessRunner
} from "./vault-cli.js";
import type { VaultBackend } from "./vault.js";

export const exampleConfig = `version: 1
database: .supadrum/queue.sqlite
executor: dry-run
approval_mode: automatic
projects:
  example:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/example/secret
      management_token: vault://supabase/example/management
      database_access: vault://supabase/example/postgres
    capabilities:
      - data-api
      - auth-admin
      - storage
      - realtime
      - edge-functions
      - secrets
      - migrations
      - schema-inspection
      - sql
      - project-management
`;

interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface CliRuntime {
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly question: (prompt: string) => Promise<string>;
  readonly defaultVaultCommand: readonly string[] | undefined;
  readonly codexAgentSetup?: {
    readonly skillSource: string;
    readonly mcpCommand: string;
    readonly mcpArgs: readonly string[];
    readonly mcpCwd: string;
  };
  readonly promptSecret: SecretPrompt;
  readonly keychain: () => VaultBackend;
}

/*
 * The default bindings to the real process — its streams, its terminal, its
 * keychain. Tests reach runCli through injected substitutes precisely so none
 * of this runs, which is the point of the seam rather than a gap in it: there
 * is no assertion to make about `process.stdout.write` that would not just be
 * restating it. Excluded on the same grounds as the entrypoint block below.
 */
/* v8 ignore start */
const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

const processRuntime: CliRuntime = {
  cwd: process.cwd(),
  homeDirectory: homedir(),
  environment: process.env,
  question: async (prompt) => {
    const input = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    try {
      return await input.question(prompt);
    } finally {
      input.close();
    }
  },
  defaultVaultCommand:
    process.platform === "darwin"
      ? [
          process.execPath,
          fileURLToPath(new URL("./vault-cli.js", import.meta.url)),
          "keychain",
          "resolve"
        ]
      : undefined,
  codexAgentSetup: {
    skillSource: fileURLToPath(
      new URL(
        "../plugins/supadrum/skills/supadrum",
        import.meta.url
      )
    ),
    mcpCommand: process.execPath,
    mcpArgs: [
      fileURLToPath(new URL("./mcp.js", import.meta.url))
    ],
    mcpCwd: dirname(
      fileURLToPath(new URL("../package.json", import.meta.url))
    )
  },
  promptSecret: {
    read: (label) => readMaskedSecret(label)
  },
  keychain: () => new MacOsKeychainBackend()
};
/* v8 ignore stop */

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requireArgument(value: string | undefined, usage: string): string {
  // A missing positional otherwise swallows the flag that followed it, and
  // the caller is told their job or project does not exist rather than that
  // they left an argument out.
  if (!value || value.startsWith("--")) throw new Error(`Usage: ${usage}`);
  return value;
}

function openConfiguredStore(
  args: readonly string[],
  runtime: CliRuntime
) {
  const configPath = resolveOperatorConfigPath({
    args,
    environment: runtime.environment,
    cwd: runtime.cwd,
    homeDirectory: runtime.homeDirectory
  });
  const config = loadConfig(configPath);
  return {
    config,
    store: new SqliteStore(
      config.database_path,
      undefined,
      config.approval_mode
    )
  };
}

async function runDemo(io: CliIo): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "supadrum-demo-"));
  const databasePath = join(directory, "queue.sqlite");
  const config: SupadrumConfig = {
    version: 1,
    database: databasePath,
    database_path: databasePath,
    config_path: join(directory, "supadrum.yml"),
    executor: "dry-run",
    approval_mode: "automatic",
    chambers: {
      demo: {
        project_ref: "demo-ref",
        credentials: {
          secret_key: "vault://supabase/demo/secret",
          management_token: "vault://supabase/demo/management",
          database_access: "vault://supabase/demo/postgres"
        }
      }
    },
    projects: {
      demo: {
        chamber: "demo",
        project_ref: "demo-ref",
        credentials: {
          secret_key: "vault://supabase/demo/secret",
          management_token: "vault://supabase/demo/management",
          database_access: "vault://supabase/demo/postgres"
        },
        capabilities: ["migrations"],
        mode: "dry-run",
        migrations: "owner",
        migration_driver: "supabase"
      }
    }
  };
  const store = new SqliteStore(databasePath);
  try {
    const submitted = store.submit({
      project: "demo",
      operation: "migration.plan",
      payload: { migration: "0001_demo.sql" },
      repo_sha: "demo00",
      idempotency_key: "demo:demo00:0001"
    });
    const runner = new Runner(
      store,
      config,
      new DryRunCredentialProvider(),
      new DryRunExecutor()
    );
    await runner.tick();
    const completed = store.getJob(submitted.id);
    store.close();
    const databaseBytes = readFileSync(databasePath);
    io.stdout(
      `${JSON.stringify(
        {
          job_id: completed.id,
          status: completed.status,
          operation: completed.operation,
          result: completed.result,
          credentials_persisted:
            databaseBytes.includes("vault://") ||
            databaseBytes.includes("[dry-run]")
        },
        null,
        2
      )}\n`
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function projectProfile(value: string): ProjectProfile {
  if (value in projectProfiles) return value as ProjectProfile;
  throw new Error(
    `Unknown profile: ${value}. Expected inspect, development, or admin`
  );
}

function credentialName(value: string): CredentialName {
  if (
    value === "secret_key" ||
    value === "management_token" ||
    value === "database_access"
  ) {
    return value;
  }
  throw new Error(
    "Credential must be secret_key, management_token, or database_access"
  );
}

async function requiredWizardValue(
  value: string | null,
  optionName: string,
  prompt: string,
  assumeYes: boolean,
  runtime: CliRuntime
): Promise<string> {
  if (value) return value;
  if (assumeYes) {
    throw new Error(`Could not discover ${optionName}; pass --${optionName}`);
  }
  const answer = (await runtime.question(prompt)).trim();
  if (!answer) throw new Error(`${optionName} is required`);
  return answer;
}

async function probeConfiguredCredentials(
  name: string,
  config: SupadrumConfig,
  environment: NodeJS.ProcessEnv = process.env
) {
  return doctorProject(name, config, async (credential, reference) => {
    if (!config.vault_command) return false;
    try {
      const result = await nodeProcessRunner.run({
        argv: config.vault_command,
        stdin: `${reference}\n`,
        env: environment
      });
      const value = result.stdout.trim();
      if (result.exitCode !== 0 || value.length === 0) return false;
      if (credential === "database_access") {
        try {
          databasePassword(value);
        } catch {
          return "invalid";
        }
      }
      return true;
    } catch {
      return false;
    }
  });
}

function printProjectAdded(
  io: CliIo,
  report: {
    readonly added: true;
    readonly alias: string;
    readonly config_path: string;
    readonly repository: string;
    readonly project_ref: string;
    readonly profile: ProjectProfile;
    readonly ready: boolean;
    readonly missing_credentials: readonly string[];
    readonly executor: "dry-run" | "command";
    readonly agent_setup:
      | {
          readonly ready: true;
          readonly restart_required: true;
          readonly skill_path: string;
          readonly codex_config_path: string;
          readonly agents_path: string;
        }
      | { readonly skipped: true };
  },
  json: boolean
): void {
  if (json) {
    io.stdout(`${JSON.stringify(report)}\n`);
    return;
  }
  io.stdout(
    formatProjectAdded({
      alias: report.alias,
      repository: report.repository,
      project_ref: report.project_ref,
      profile: report.profile,
      ready: report.ready,
      configured_credentials: 3 - report.missing_credentials.length,
      executor: report.executor
    })
  );
  io.stdout(
    "ready" in report.agent_setup
      ? [
          "✓ Codex agent   configured",
          "  Start a new Codex task to load Supadrum.",
          ""
        ].join("\n")
      : ["○ Codex agent   skipped", ""].join("\n")
  );
}

function configureCodexAgent(input: {
  readonly args: readonly string[];
  readonly runtime: CliRuntime;
  readonly repository: string;
  readonly configPath: string;
}):
  | {
      readonly ready: true;
      readonly restart_required: true;
      readonly skill_path: string;
      readonly codex_config_path: string;
      readonly agents_path: string;
    }
  | { readonly skipped: true } {
  if (
    input.args.includes("--no-agent-setup") ||
    !input.runtime.codexAgentSetup
  ) {
    return { skipped: true };
  }
  const setup = input.runtime.codexAgentSetup;
  const report = installCodexAgentSetup({
    repository: input.repository,
    configPath: input.configPath,
    skillSource: setup.skillSource,
    mcpCommand: setup.mcpCommand,
    mcpArgs: setup.mcpArgs,
    mcpCwd: setup.mcpCwd
  });
  return {
    ready: true,
    restart_required: report.restartRequired,
    skill_path: report.skillPath,
    codex_config_path: report.codexConfigPath,
    agents_path: report.agentsPath
  };
}

export async function runCli(
  args: readonly string[],
  io: CliIo = processIo,
  runtime: CliRuntime = processRuntime
): Promise<number> {
  const command = args[0];
  if (command === "--help" || command === "-h") {
    io.stdout(
      [
        "Usage:",
        "  supadrum project add <alias> [options]",
        "  supadrum project setup <alias>",
        "  supadrum project credentials set <alias> [--replace CREDENTIAL]",
        "  supadrum project migrations owner <alias>",
        "  supadrum project migrations driver <alias> <supabase|prisma>",
        "  supadrum project live <alias>",
        "  supadrum project dry-run <alias>",
        "  supadrum project inspect <alias>",
        "  supadrum project doctor <alias>|--all",
        "  supadrum project list",
        "  supadrum approve <job-id>",
        "  supadrum status <job-id>",
        "  supadrum demo",
        "",
        "Project add options:",
        "  --repo PATH",
        "  --project-ref REF",
        "  --profile inspect|development|admin",
        "  --config PATH",
        "  --no-agent-setup",
        "  --yes",
        "  --json",
        ""
      ].join("\n")
    );
    return 0;
  }
  if (command === "demo") {
    await runDemo(io);
    return 0;
  }
  if (command === "init") {
    const path = resolve(args[1] ?? "supadrum.yml");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, exampleConfig, { flag: "wx", mode: 0o600 });
    io.stdout(`${path}\n`);
    return 0;
  }
  if (command === "project" && args[1] === "add") {
    const alias = requireArgument(
      args[2],
      "supadrum project add <alias> [--local] [--repo PATH] [--project-ref REF] [--profile PROFILE] [--config PATH] [--yes]"
    );
    const local = args.includes("--local");
    const assumeYes = args.includes("--yes");
    let discovery = discoverProject({
      alias,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory,
      ...(option(args, "--repo")
        ? { repository: option(args, "--repo") as string }
        : {}),
      ...(option(args, "--project-ref")
        ? { project_ref: option(args, "--project-ref") as string }
        : {})
    });
    const repository = await requiredWizardValue(
      discovery.repository,
      "repo",
      "Repository path: ",
      assumeYes,
      runtime
    );
    if (!discovery.repository) {
      discovery = discoverProject({
        alias,
        cwd: runtime.cwd,
        homeDirectory: runtime.homeDirectory,
        repository
      });
    }
    const configPath = resolveOperatorConfigPath({
      args,
      environment: runtime.environment,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory
    });
    if (local) {
      const added = addLocalProject({
        alias,
        repository,
        config_path: configPath
      });
      const agentSetup = configureCodexAgent({
        args,
        runtime,
        repository: added.repository,
        configPath
      });
      const report = {
        ...added,
        ready: true,
        missing_credentials: [],
        executor: "command",
        agent_setup: agentSetup
      };
      if (args.includes("--json")) {
        io.stdout(`${JSON.stringify(report)}\n`);
      } else {
        io.stdout(
          [
            `✓ Project ${alias} added`,
            "",
            `  Repository   ${added.repository}`,
            "  Target       local",
            "  Mode         live",
            ""
          ].join("\n")
        );
      }
      return 0;
    }
    const projectRef = await requiredWizardValue(
      option(args, "--project-ref") ?? discovery.project_ref,
      "project-ref",
      "Supabase project ref: ",
      assumeYes,
      runtime
    );
    const profileValue =
      option(args, "--profile") ?? "development";
    const profile = projectProfile(profileValue);
    let added;
    try {
      added = addProject({
        alias,
        repository,
        project_ref: projectRef,
        profile,
        config_path: configPath,
        ...(runtime.defaultVaultCommand
          ? { vault_command: runtime.defaultVaultCommand }
          : {})
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Project already exists: ${alias}`
      ) {
        throw new Error(
          `${error.message}\nNext: supadrum project setup ${alias}`
        );
      }
      throw error;
    }
    const configured = loadConfig(configPath);
    const agentSetup = configureCodexAgent({
      args,
      runtime,
      repository: added.repository,
      configPath
    });
    const doctor = await probeConfiguredCredentials(
      alias,
      configured,
      runtime.environment
    );
    printProjectAdded(
      io,
      {
        ...added,
        ready: doctor.ready,
        missing_credentials: doctor.missing_credentials,
        executor: doctor.executor,
        agent_setup: agentSetup
      },
      args.includes("--json")
    );
    return 0;
  }
  if (command === "project" && args[1] === "setup") {
    const alias = requireArgument(
      args[2],
      "supadrum project setup <alias> [--config PATH]"
    );
    const configPath = resolveOperatorConfigPath({
      args,
      environment: runtime.environment,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory
    });
    let config = loadConfig(configPath);
    let project = config.projects[alias];
    if (!project) throw new Error(`Unknown project: ${alias}`);

    if (!project.repo) {
      const discovered = discoverProjectRepository({
        alias,
        cwd: runtime.cwd,
        homeDirectory: runtime.homeDirectory
      });
      if (!discovered.path) {
        throw new Error(
          `Repository not found for ${alias}; pass it with project add --repo`
        );
      }
      setProjectRepository(configPath, alias, discovered.path);
      config = loadConfig(configPath);
      project = config.projects[alias] as typeof project;
    }

    const currentDoctor = await probeConfiguredCredentials(
      alias,
      config,
      runtime.environment
    );
    if (
      currentDoctor.missing_credentials.length +
        currentDoctor.invalid_credentials.length >
      0
    ) {
      const targetRef = project.project_ref;
      const targetChamber = project.chamber;
      const peers = Object.keys(config.projects).filter(
        (name) =>
          name !== alias &&
          config.projects[name]?.project_ref === targetRef &&
          config.projects[name]?.chamber !== targetChamber
      );
      const completePeers: string[] = [];
      for (const peer of peers) {
        const report = await probeConfiguredCredentials(
          peer,
          config,
          runtime.environment
        );
        if (report.ready) completePeers.push(peer);
      }
      if (completePeers.length === 1) {
        shareProjectChamber(configPath, alias, completePeers[0] as string);
        config = loadConfig(configPath);
        project = config.projects[alias] as typeof project;
      }
    }

    const report = await probeConfiguredCredentials(
      alias,
      config,
      runtime.environment
    );
    if (!project.repo) {
      throw new Error(`Repository not found for ${alias}`);
    }
    const agentSetup = configureCodexAgent({
      args,
      runtime,
      repository: project.repo,
      configPath
    });
    const siblings = Object.entries(config.projects)
      .filter(
        ([name, candidate]) =>
          name !== alias && candidate.chamber === project.chamber
      )
      .map(([name]) => name)
      .sort();
    io.stdout(
      [
        `Supadrum setup — ${alias}`,
        "",
        `✓ Repository   ${project.repo}`,
        `✓ Supabase     ${project.project_ref}`,
        `✓ Chamber      ${project.chamber}${siblings.length > 0 ? ` (shared with ${siblings.join(", ")})` : ""}`,
        `${report.ready ? "✓" : "○"} Credentials  ${Object.values(report.credentials).filter(Boolean).length}/3 valid`,
        ...(report.invalid_credentials.length > 0
          ? [`  Invalid       ${report.invalid_credentials.join(", ")}`]
          : []),
        `${project.migrations === "owner" ? "✓" : "○"} Migrations   ${project.migrations}`,
        `○ Mode         ${project.mode}`,
        `${"ready" in agentSetup ? "✓" : "○"} Codex agent  ${"ready" in agentSetup ? "configured (new task required)" : "skipped"}`,
        "",
        "Next:",
        ...(report.invalid_credentials.length > 0
          ? [
              `  supadrum project credentials set ${alias} --replace ${report.invalid_credentials[0]}`
            ]
          : report.missing_credentials.length > 0
          ? [`  supadrum project credentials set ${alias}`]
          : project.mode === "dry-run"
            ? [`  supadrum project live ${alias}`]
            : ["  supadrum-runner"]),
        ""
      ].join("\n")
    );
    return 0;
  }
  if (
    command === "project" &&
    args[1] === "migrations" &&
    args[2] === "owner"
  ) {
    const alias = requireArgument(
      args[3],
      "supadrum project migrations owner <alias> [--config PATH]"
    );
    const configPath = resolveOperatorConfigPath({
      args,
      environment: runtime.environment,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory
    });
    setMigrationOwner(configPath, alias);
    const project = loadConfig(configPath).projects[alias];
    io.stdout(
      `✓ Migration owner: ${alias} (${project?.chamber ?? "unknown chamber"})\n`
    );
    return 0;
  }
  if (
    command === "project" &&
    args[1] === "migrations" &&
    args[2] === "driver"
  ) {
    const usage =
      "supadrum project migrations driver <alias> <supabase|prisma> [--config PATH]";
    const alias = requireArgument(args[3], usage);
    const requestedDriver = requireArgument(args[4], usage);
    if (
      requestedDriver !== "supabase" &&
      requestedDriver !== "prisma"
    ) {
      throw new Error(
        `Migration driver must be supabase or prisma, got ${requestedDriver}`
      );
    }
    const configPath = resolveOperatorConfigPath({
      args,
      environment: runtime.environment,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory
    });
    setMigrationDriver(configPath, alias, requestedDriver);
    io.stdout(`✓ Migration driver: ${alias} (${requestedDriver})\n`);
    return 0;
  }
  if (
    command === "project" &&
    (args[1] === "live" || args[1] === "dry-run")
  ) {
    const mode = args[1];
    const alias = requireArgument(
      args[2],
      `supadrum project ${mode} <alias> [--config PATH]`
    );
    const configPath = resolveOperatorConfigPath({
      args,
      environment: runtime.environment,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory
    });
    if (mode === "live") {
      const report = await probeConfiguredCredentials(
        alias,
        loadConfig(configPath),
        runtime.environment
      );
      if (!report.ready) {
        throw new Error(
          `Project ${alias} is not ready; run supadrum project setup ${alias}`
        );
      }
    }
    setProjectMode(configPath, alias, mode);
    io.stdout(`✓ ${alias} mode: ${mode}\n`);
    return 0;
  }
  if (
    command === "project" &&
    args[1] === "credentials" &&
    args[2] === "set"
  ) {
    const alias = requireArgument(
      args[3],
      "supadrum project credentials set <alias> [--replace CREDENTIAL] [--config PATH]"
    );
    const configPath = resolveOperatorConfigPath({
      args,
      environment: runtime.environment,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory
    });
    const config = loadConfig(configPath);
    const project = config.projects[alias];
    if (!project) {
      throw new Error(`Unknown project: ${alias}`);
    }
    if (!isBundledKeychainCommand(config.vault_command)) {
      throw new Error(
        "Configured vault backend does not support interactive writes"
      );
    }

    const keychain = runtime.keychain();
    io.stdout(`Supadrum credentials — ${alias}\n\n`);
    io.stdout(formatCredentialSecurityNotice());
    const credentialGuides: Readonly<Record<string, () => string>> = {
      "Secret key": () =>
        formatSecretKeyGuide(alias, project.project_ref),
      "Management token": () => formatManagementTokenGuide(alias),
      "Database access": () =>
        formatDatabaseAccessGuide(project.project_ref)
    };
    const shownGuides = new Set<string>();
    await setupProjectCredentials({
      project: alias,
      config,
      vault: keychain,
      ...(option(args, "--replace")
        ? {
            replace: [
              credentialName(option(args, "--replace") as string)
            ]
          }
        : {}),
      prompt: {
        read: async (label) => {
          const guide = credentialGuides[label];
          if (guide && !shownGuides.has(label)) {
            shownGuides.add(label);
            io.stdout(guide());
          }
          return runtime.promptSecret.read(label);
        }
      }
    });
    // setupProjectCredentials only returns once every credential has been
    // read back out of the vault and compared, so re-reading them here would
    // just ask the keychain the same question again — three more
    // authorisation prompts on macOS for an answer already in hand. What is
    // still worth reporting is whether the repository and project ref check
    // out, which doctorProject decides on its own.
    const doctor = await doctorProject(alias, config, async () => true);
    io.stdout(formatCredentialSetup(alias, doctor.ready));
    return 0;
  }
  if (command === "project" && args[1] === "doctor") {
    const configPath = resolveOperatorConfigPath({
      args,
      environment: runtime.environment,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory
    });
    const config = loadConfig(configPath);
    if (args[2] === "--all") {
      const reports = [];
      for (const alias of Object.keys(config.projects).sort()) {
        reports.push(
          await probeConfiguredCredentials(
            alias,
            config,
            runtime.environment
          )
        );
      }
      if (args.includes("--json")) {
        io.stdout(`${JSON.stringify(reports)}\n`);
      } else {
        io.stdout(reports.map(formatProjectDoctor).join("\n"));
      }
    } else {
      const alias = requireArgument(
        args[2],
        "supadrum project doctor <alias> [--config PATH] [--json]"
      );
      const report = await probeConfiguredCredentials(
        alias,
        config,
        runtime.environment
      );
      if (args.includes("--json")) {
        io.stdout(`${JSON.stringify(report)}\n`);
      } else {
        io.stdout(formatProjectDoctor(report));
      }
    }
    return 0;
  }
  if (command === "project" && args[1] === "inspect") {
    const alias = requireArgument(
      args[2],
      "supadrum project inspect <alias> [--config PATH] [--json]"
    );
    const configPath = resolveOperatorConfigPath({
      args,
      environment: runtime.environment,
      cwd: runtime.cwd,
      homeDirectory: runtime.homeDirectory
    });
    const report = inspectProject(alias, loadConfig(configPath));
    if (args.includes("--json")) {
      io.stdout(`${JSON.stringify(report)}\n`);
    } else {
      io.stdout(
        [
          `Project: ${report.name}`,
          ...("repo" in report ? [`Repository: ${report.repo}`] : []),
          ...("target" in report
            ? [`Target: ${report.target}`]
            : [`Supabase ref: ${report.project_ref}`]),
          `Capabilities: ${report.capabilities.join(", ")}`,
          `Credentials: ${report.credentials.join(", ")}`,
          `Executor: ${report.executor}`,
          ""
        ].join("\n")
      );
    }
    return 0;
  }
  if (command === "approve") {
    const jobId = requireArgument(
      args[1],
      "supadrum approve <job-id> [--actor <name>] [--config <path>]"
    );
    const actor =
      option(args, "--actor") ?? runtime.environment.USER ?? "operator";
    const { store } = openConfiguredStore(args, runtime);
    try {
      io.stdout(`${JSON.stringify(store.approve(jobId, actor), null, 2)}\n`);
    } finally {
      store.close();
    }
    return 0;
  }
  if (command === "status") {
    const jobId = requireArgument(
      args[1],
      "supadrum status <job-id> [--config <path>]"
    );
    const { store } = openConfiguredStore(args, runtime);
    try {
      io.stdout(`${JSON.stringify(store.getJob(jobId), null, 2)}\n`);
    } finally {
      store.close();
    }
    return 0;
  }
  if (
    command === "projects" ||
    (command === "project" && args[1] === "list")
  ) {
    const { config, store } = openConfiguredStore(args, runtime);
    try {
      io.stdout(
        `${JSON.stringify(
          Object.keys(config.projects).sort().map((name) => ({
            name,
            ...(config.projects[name]?.target === "local"
              ? { target: "local" }
              : { project_ref: config.projects[name]?.project_ref })
          })),
          null,
          2
        )}\n`
      );
    } finally {
      store.close();
    }
    return 0;
  }

  io.stderr(
    "Usage: supadrum <init|demo|project add|project setup|project credentials set|project migrations owner|project migrations driver|project live|project dry-run|project inspect|project doctor|project list|approve|status> [options]\n"
  );
  return 1;
}

/*
 * Process bootstrap: binds this module to the real process — its argv, its
 * stdio, its exit code. The guard is false by design whenever the module is
 * imported rather than executed, so a coverage instrument scoped to the test
 * process can never observe it. The logic it wires into is exported and
 * tested directly; excluded from the measurement so the reported number means
 * "code the instrument can see" rather than carrying a permanent red block.
 */
/* v8 ignore start */
const entrypoint = process.argv[1];
if (isEntrypoint(import.meta.url, entrypoint)) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    });
}
/* v8 ignore stop */

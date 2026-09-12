import {
  existsSync,
  mkdtempSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ProjectConfig } from "../src/config.js";
import type { ExecutionResult, Job } from "../src/domain.js";
import {
  CommandExecutor,
  ProjectModeExecutor,
  VaultCommandCredentialProvider,
  createRuntime,
  redactSecrets
} from "../src/executors.js";
import { MissingCredentialsError, type Executor } from "../src/runner.js";
import type { SupadrumConfig } from "../src/config.js";

const project: ProjectConfig = {
  chamber: "alpha",
  project_ref: "alpha-ref",
  credentials: {
    secret_key: "vault://supabase/alpha/secret",
    management_token: "vault://supabase/alpha/management",
    database_access: "vault://supabase/alpha/postgres"
  },
  capabilities: ["migrations"],
  mode: "live",
  migrations: "owner",
  migration_driver: "supabase",
  commands: {
    "migration.plan": {
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(process.env.DRUM_SECRET + ':' + process.argv[1])",
        "{{payload.migration}}"
      ],
      env: {
        DRUM_SECRET: "secret_key"
      },
      verify_repo_sha: false
    }
  }
};

const job: Job = {
  id: "job-1",
  project: "alpha",
  operation: "migration.plan",
  payload: { migration: "rules.sql" },
  repo_sha: "abc123",
  idempotency_key: "alpha:abc123:plan",
  capability: "migrations",
  requires_approval: false,
  session_id: null,
  status: "running",
  created_at: "2026-07-29T15:00:00.000Z",
  updated_at: "2026-07-29T15:00:00.000Z",
  lease_expires_at: null,
  approved_at: null,
  approved_by: null,
  result: null,
  error: null
};

describe("credential isolation", () => {
  test("does not require a vault resolver for a live local target", async () => {
    const localProject = Object.assign(
      { ...project, mode: "live" as const },
      { target: "local" as const }
    );
    const config: SupadrumConfig = {
      version: 1,
      database: "queue.sqlite",
      database_path: "/tmp/queue.sqlite",
      config_path: "/tmp/config.yml",
      executor: "command",
      approval_mode: "automatic",
      chambers: { alpha: localProject },
      projects: { alpha: localProject }
    };
    const runtime = createRuntime(config);

    await expect(
      runtime.credentials.resolve("alpha", localProject)
    ).resolves.toEqual({
      secret_key: "[local]",
      management_token: "[local]",
      database_access: "[local]"
    });
  });

  test("keeps a dry-run project isolated from a global command setting", async () => {
    const dryProject: ProjectConfig = {
      ...project,
      mode: "dry-run"
    };
    const config: SupadrumConfig = {
      version: 1,
      database: "queue.sqlite",
      database_path: "/tmp/queue.sqlite",
      config_path: "/tmp/config.yml",
      executor: "command",
      approval_mode: "automatic",
      vault_command: ["/definitely/missing/resolver"],
      chambers: {
        alpha: {
          project_ref: dryProject.project_ref,
          credentials: dryProject.credentials
        }
      },
      projects: { alpha: dryProject }
    };
    const runtime = createRuntime(config);

    const credentials = await runtime.credentials.resolve(
      "alpha",
      dryProject
    );
    const result = await runtime.executor.execute(
      job,
      dryProject,
      credentials
    );

    expect(result.output).toMatchObject({ mode: "dry-run" });
  });

  test("passes vault references on stdin rather than argv", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supadrum-vault-"));
    const resolver = join(directory, "resolver.mjs");
    writeFileSync(
      resolver,
      `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (process.argv.length !== 2) process.exit(9);
  process.stdout.write("resolved-" + input.trim().split("/").at(-1));
});`
    );
    const provider = new VaultCommandCredentialProvider([
      process.execPath,
      resolver
    ]);

    await expect(provider.resolve("alpha", project)).resolves.toEqual({
      secret_key: "resolved-secret",
      management_token: "resolved-management",
      database_access: "resolved-postgres"
    });
  });

  test("redacts every resolved value from command output", async () => {
    const credentials = {
      secret_key: "top-secret-value",
      management_token: "management-value",
      database_access: "postgres-value"
    };
    const executor = new CommandExecutor(process.cwd());
    await executor.mount("alpha", project, credentials);

    const result = await executor.execute(job, project, credentials);

    expect(result.output).toEqual({
      exit_code: 0,
      stdout: "[REDACTED]:rules.sql",
      stderr: ""
    });
    expect(JSON.stringify(result)).not.toContain("top-secret-value");
  });

  test("redacts longer overlapping credentials first", () => {
    expect(redactSecrets("token-long token", ["token", "token-long"])).toBe(
      "[REDACTED] [REDACTED]"
    );
  });

  test("uses the project repository when a command omits cwd", async () => {
    const baseDirectory = mkdtempSync(join(tmpdir(), "supadrum-base-"));
    const repository = mkdtempSync(join(tmpdir(), "supadrum-repo-"));
    const configuredProject: ProjectConfig = {
      ...project,
      repo: repository,
      commands: {
        "migration.plan": {
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write(process.cwd())"
          ],
          env: {},
          verify_repo_sha: false
        }
      }
    };
    const credentials = {
      secret_key: "secret",
      management_token: "management",
      database_access: "postgres"
    };
    const executor = new CommandExecutor(baseDirectory);

    const result = await executor.execute(
      job,
      configuredProject,
      credentials
    );

    expect(result.output).toMatchObject({
      stdout: realpathSync(repository)
    });
  });
});

describe("multi-step commands", () => {
  const stepProject = (
    steps: Array<{ argv: string[] }>
  ): ProjectConfig => ({
    ...project,
    commands: {
      "migration.plan": {
        steps,
        env: {},
        verify_repo_sha: false
      }
    }
  });

  const credentials = {
    secret_key: "secret",
    management_token: "management",
    database_access: "postgres"
  };

  test("runs every step in order and keeps each one legible", async () => {
    const executor = new CommandExecutor(process.cwd());

    const result = await executor.execute(
      job,
      stepProject([
        { argv: [process.execPath, "-e", "process.stdout.write('uno')"] },
        { argv: [process.execPath, "-e", "process.stdout.write('due')"] }
      ]),
      credentials
    );

    // Order is the whole point: a Vercel deploy that builds before it pulls
    // ships the wrong settings. 'uno' must precede 'due'.
    const stdout = (result.output as { stdout: string }).stdout;
    expect(stdout.indexOf("uno")).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf("uno")).toBeLessThan(stdout.indexOf("due"));
    // Each command is labelled, so three steps read as three commands.
    expect(stdout).toContain("$ ");
  });

  test("a failing step stops the ones after it", async () => {
    const executor = new CommandExecutor(process.cwd());
    const marker = join(mkdtempSync(join(tmpdir(), "supadrum-step-")), "ran");

    await expect(
      executor.execute(
        job,
        stepProject([
          {
            argv: [
              process.execPath,
              "-e",
              "process.stderr.write('build rotto'); process.exit(3)"
            ]
          },
          {
            argv: [
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`
            ]
          }
        ]),
        credentials
      )
    ).rejects.toThrow("exit code 3");

    // Il file esiste solo se il secondo passo e' partito: e' la differenza fra
    // "build fallito" e "build fallito e spedito lo stesso".
    expect(existsSync(marker)).toBe(false);
  });

  test("stops at waiting_credentials when the chamber lacks the token", async () => {
    const executor = new CommandExecutor(process.cwd());
    const deployProject: ProjectConfig = {
      ...project,
      commands: {
        "migration.plan": {
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
          env: { VERCEL_TOKEN: "deploy_token" },
          verify_repo_sha: false
        }
      }
    };

    // Senza guardia la variabile resterebbe non impostata e il fallimento
    // arriverebbe da dentro l'utensile, dove la ragione non si riconosce.
    await expect(
      executor.execute(job, deployProject, credentials)
    ).rejects.toThrow(MissingCredentialsError);
    await expect(
      executor.execute(job, deployProject, credentials)
    ).rejects.toThrow("deploy_token");
  });

  test("passes the deploy token through when the chamber carries it", async () => {
    const executor = new CommandExecutor(process.cwd());
    const deployProject: ProjectConfig = {
      ...project,
      commands: {
        "migration.plan": {
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write(process.env.VERCEL_TOKEN ?? 'assente')"
          ],
          env: { VERCEL_TOKEN: "deploy_token" },
          verify_repo_sha: false
        }
      }
    };

    const result = await executor.execute(job, deployProject, {
      ...credentials,
      deploy_token: "token-di-deploy"
    });

    // Redatto, non in chiaro: un token di deploy non deve comparire nei log
    // di un job piu' di quanto ci compaia una service key.
    expect((result.output as { stdout: string }).stdout).toBe("[REDACTED]");
  });
});

describe("deploy routing", () => {
  const liveProject: ProjectConfig = {
    ...project,
    mode: "live",
    capabilities: ["deploy"],
    deploy_target: {
      provider: "vercel",
      project_id: "prj_abc",
      org_id: "team_xyz"
    },
    commands: {
      "deploy.apply": {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.argv[1] + '|' + process.argv[2])",
          "{{deploy_project_id}}",
          "{{deploy_org_id}}"
        ],
        env: {},
        verify_repo_sha: false
      }
    }
  };

  const deployJob: Job = {
    ...job,
    operation: "deploy.apply",
    capability: "deploy",
    requires_approval: true
  };

  const credentials = {
    secret_key: "secret",
    management_token: "management",
    database_access: "postgres"
  };

  class RefusingExecutor implements Executor {
    async mount(): Promise<void> {}
    async drain(): Promise<void> {}
    async unmount(): Promise<void> {}
    async execute(): Promise<ExecutionResult> {
      throw new Error("No live adapter for deploy.apply");
    }
  }

  test("a live deploy runs the operator argv, not the Supabase adapter", async () => {
    const executor = new ProjectModeExecutor(
      new RefusingExecutor(),
      new RefusingExecutor(),
      new CommandExecutor(process.cwd())
    );

    const result = await executor.execute(
      deployJob,
      liveProject,
      credentials
    );

    // Senza l'instradamento questo job finirebbe nell'adattatore Supabase, che
    // per deploy.apply sa solo rispondere "no live adapter".
    expect((result.output as { stdout: string }).stdout).toBe(
      "prj_abc|team_xyz"
    );
  });

  test("the deploy ids come from the config, never from the payload", async () => {
    const executor = new CommandExecutor(process.cwd());
    const spoofed: Job = {
      ...deployJob,
      payload: { deploy_project_id: "prj_di_un_altro" }
    };

    const result = await executor.execute(
      spoofed,
      liveProject,
      credentials
    );

    // Un job non deve poter scegliere verso quale progetto Vercel spedire.
    expect((result.output as { stdout: string }).stdout).toBe(
      "prj_abc|team_xyz"
    );
  });

  test("a project without a target cannot render deploy ids", async () => {
    const executor = new CommandExecutor(process.cwd());
    const { deploy_target: _omitted, ...withoutTarget } = liveProject;

    await expect(
      executor.execute(deployJob, withoutTarget as ProjectConfig, credentials)
    ).rejects.toThrow("no deploy target");
  });

  test("a non-deploy live job still goes to the Supabase adapter", async () => {
    const executor = new ProjectModeExecutor(
      new RefusingExecutor(),
      new RefusingExecutor(),
      new CommandExecutor(process.cwd())
    );

    // L'instradamento deve essere stretto: dirottare anche le migrazioni sul
    // percorso comandi toglierebbe a ogni progetto il suo adattatore Supabase.
    await expect(
      executor.execute({ ...job, operation: "migration.apply" }, liveProject, credentials)
    ).rejects.toThrow("No live adapter");
  });
});

describe("deploy target authority", () => {
  const credentials = {
    secret_key: "secret",
    management_token: "management",
    database_access: "postgres"
  };

  const echoEnv = (projectConfig: Partial<ProjectConfig>): ProjectConfig => ({
    ...project,
    mode: "live",
    capabilities: ["deploy"],
    ...projectConfig,
    commands: {
      "deploy.apply": {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write((process.env.VERCEL_ORG_ID ?? 'assente') + '|' + (process.env.VERCEL_PROJECT_ID ?? 'assente'))"
        ],
        env: {},
        verify_repo_sha: false
      }
    }
  });

  const deployJob: Job = {
    ...job,
    operation: "deploy.apply",
    capability: "deploy",
    requires_approval: true
  };

  test("tells the CLI which project to ship to, instead of trusting the folder", async () => {
    const executor = new CommandExecutor(process.cwd());

    const result = await executor.execute(
      deployJob,
      echoEnv({
        deploy_target: {
          provider: "vercel",
          project_id: "prj_abc",
          org_id: "team_xyz"
        }
      }),
      credentials
    );

    // Senza queste variabili la CLI leggerebbe .vercel/project.json dal
    // repository: un repo collegato a un altro progetto spedirebbe altrove
    // senza che il broker lo sappia.
    expect((result.output as { stdout: string }).stdout).toBe(
      "team_xyz|prj_abc"
    );
  });

  test("injects nothing when the project has no deploy target", async () => {
    const executor = new CommandExecutor(process.cwd());
    const config = echoEnv({});
    const { deploy_target: _none, ...withoutTarget } = config;

    const result = await executor.execute(
      deployJob,
      withoutTarget as ProjectConfig,
      credentials
    );

    // Un progetto che non spedisce non deve ereditare il target di nessun altro.
    expect((result.output as { stdout: string }).stdout).toBe(
      "assente|assente"
    );
  });
});

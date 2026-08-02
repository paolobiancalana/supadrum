import {
  mkdtempSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ProjectConfig } from "../src/config.js";
import type { Job } from "../src/domain.js";
import {
  CommandExecutor,
  VaultCommandCredentialProvider,
  createRuntime,
  redactSecrets
} from "../src/executors.js";
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

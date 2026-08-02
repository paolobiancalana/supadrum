import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ProjectConfig } from "../src/config.js";
import type { Job } from "../src/domain.js";
import {
  LiveSupabaseExecutor,
  databasePassword,
  resolveExecutable,
  type LiveProcess,
  type LiveProcessInput
} from "../src/live-executor.js";
import {
  CATALOG_INSPECTION_SQL,
  MIGRATION_INSPECTION_SQL,
  SCHEMA_INSPECTION_PSQL_ARGS
} from "../src/schema-inspection-sql.js";
import {
  PRISMA_BASELINE_HISTORY_SQL,
  PRISMA_HISTORY_AVAILABILITY_SQL
} from "../src/prisma-baseline-sql.js";
import {
  parseSchemaInspectionPayload,
  schemaInspectionPsqlInput
} from "../src/schema-inspection.js";

const FULL_REPOSITORY_OID =
  "abc123deadbeefabc123deadbeefabc123deadbe";

function runningJob(
  operation: Job["operation"],
  payload: Record<string, unknown>
): Job {
  return {
    id: "job-1",
    project: "example-web",
    operation,
    payload,
    repo_sha: "abc123",
    idempotency_key: `example-web:abc123:${operation}`,
    capability:
      operation === "project.inspect"
        ? "project-management"
        : operation === "auth.admin"
          ? "auth-admin"
        : operation === "functions.deploy"
          ? "edge-functions"
          : operation === "secrets.set"
            ? "secrets"
            : operation === "schema.inspect"
              ? "schema-inspection"
            : operation === "sql.execute"
              ? "sql"
              : "migrations",
    requires_approval: operation !== "project.inspect" &&
      operation !== "migration.plan" &&
      operation !== "schema.inspect",
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
}

function liveProject(
  repository: string,
  migrationDriver: "supabase" | "prisma" = "supabase"
): ProjectConfig {
  return {
    repo: repository,
    chamber: "example-platform",
    project_ref: "abcdefghijklmnopqrst",
    credentials: {
      secret_key: "vault://supabase/example-platform/secret",
      management_token: "vault://supabase/example-platform/management",
      database_access: "vault://supabase/example-platform/postgres"
    },
    managed_secrets: {
      STRIPE_KEY: "vault://supabase/example-platform/functions/STRIPE_KEY"
    },
    capabilities: [
      "project-management",
      "migrations",
      "edge-functions",
      "secrets",
      "schema-inspection",
      "sql"
    ],
    mode: "live",
    migrations: "owner",
    migration_driver: migrationDriver
  };
}

function localProject(repository: string): ProjectConfig {
  return Object.assign(liveProject(repository), {
    target: "local" as const
  });
}

class LocalRecordingProcess implements LiveProcess {
  readonly calls: LiveProcessInput[] = [];

  constructor(readonly local = true) {}

  async run(input: LiveProcessInput) {
    this.calls.push(input);
    if (input.argv[0] === "git") {
      return {
        exitCode: 0,
        stdout: `${FULL_REPOSITORY_OID}\n${FULL_REPOSITORY_OID}\n`,
        stderr: ""
      };
    }
    if (input.argv.includes("status")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          "API URL": this.local
            ? "http://127.0.0.1:54321"
            : "https://remote.example.test",
          "DB URL": this.local
            ? "postgresql://postgres:secret@127.0.0.1:54322/postgres"
            : "postgresql://postgres:secret@db.remote.example.test/postgres"
        }),
        stderr: ""
      };
    }
    return { exitCode: 0, stdout: "ok", stderr: "" };
  }
}

class RecordingProcess implements LiveProcess {
  readonly calls: LiveProcessInput[] = [];

  async run(input: LiveProcessInput) {
    this.calls.push(input);
    if (input.argv[0] === "git") {
      return {
        exitCode: 0,
        stdout: `${FULL_REPOSITORY_OID}\n${FULL_REPOSITORY_OID}\n`,
        stderr: ""
      };
    }
    return {
      exitCode: 0,
      stdout: "management-canary db-canary",
      stderr: ""
    };
  }
}

class PendingPrismaProcess implements LiveProcess {
  readonly calls: LiveProcessInput[] = [];

  constructor(readonly connectionFailure = false) {}

  async run(input: LiveProcessInput) {
    this.calls.push(input);
    if (input.argv[0] === "git") {
      return {
        exitCode: 0,
        stdout: `${FULL_REPOSITORY_OID}\n${FULL_REPOSITORY_OID}\n`,
        stderr: ""
      };
    }
    return this.connectionFailure
      ? {
          exitCode: 1,
          stdout: "",
          stderr: "Error: P1001: Can't reach database server"
        }
      : {
          exitCode: 1,
          stdout:
            "Following migration have not yet been applied:\n" +
            "20260729203000_server_backed_templates\n",
          stderr: ""
        };
  }
}

class PrismaBaselineProcess implements LiveProcess {
  readonly calls: LiveProcessInput[] = [];
  readonly history: Array<Record<string, unknown>>;

  constructor(
    readonly sources: Readonly<Record<string, string>>,
    history: Array<Record<string, unknown>> = [],
    readonly statusOutput = "",
    readonly resolveError = ""
  ) {
    this.history = [...history];
  }

  async run(input: LiveProcessInput) {
    this.calls.push(input);
    if (input.argv[0] === "git") {
      if (input.argv[3] === "rev-parse") {
        return {
          exitCode: 0,
          stdout: `${FULL_REPOSITORY_OID}\n${FULL_REPOSITORY_OID}\n`,
          stderr: ""
        };
      }
      if (input.argv[3] === "ls-tree") {
        return {
          exitCode: 0,
          stdout: Object.keys(this.sources)
            .map(
              (name) =>
                `prisma/migrations/${name}/migration.sql`
            )
            .join("\n") + "\n",
          stderr: ""
        };
      }
      if (input.argv[3] === "status") {
        return {
          exitCode: 0,
          stdout: this.statusOutput,
          stderr: ""
        };
      }
      if (input.argv[3] === "show") {
        const object = input.argv[4] ?? "";
        const name = object.match(
          /prisma\/migrations\/([^/]+)\/migration\.sql$/
        )?.[1];
        return {
          exitCode: name && this.sources[name] ? 0 : 1,
          stdout: name ? this.sources[name] ?? "" : "",
          stderr: name && this.sources[name] ? "" : "missing blob"
        };
      }
    }
    if (input.argv[0] === "psql") {
      if (input.stdin === PRISMA_HISTORY_AVAILABILITY_SQL) {
        return {
          exitCode: 0,
          stdout: '{"available":true}\n',
          stderr: ""
        };
      }
      if (input.stdin === PRISMA_BASELINE_HISTORY_SQL) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ rows: this.history })}\n`,
          stderr: ""
        };
      }
    }
    if (
      input.argv[1] === "migrate" &&
      input.argv[2] === "resolve" &&
      input.argv[3] === "--applied"
    ) {
      if (this.resolveError) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: this.resolveError
        };
      }
      const name = input.argv[4] as string;
      const source = this.sources[name] as string;
      this.history.push({
        migration_name: name,
        checksum: createHash("sha256").update(source).digest("hex"),
        started_at: `2026-07-30T00:00:0${this.history.length}.000Z`,
        finished_at: `2026-07-30T00:00:0${this.history.length}.500Z`,
        rolled_back_at: null,
        logs: null
      });
      return { exitCode: 0, stdout: "resolved\n", stderr: "" };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: "unexpected process call"
    };
  }
}

class SchemaInspectionProcess implements LiveProcess {
  readonly calls: LiveProcessInput[] = [];

  constructor(
    readonly historyAvailable = true,
    readonly malformedCatalog = false,
    readonly catalogExitCode = 0
  ) {}

  async run(input: LiveProcessInput) {
    this.calls.push(input);
    if (input.argv[0] === "git") {
      const submitted = input.argv.at(-2) ?? "";
      const submittedOid = submitted.startsWith("abc123")
        ? FULL_REPOSITORY_OID
        : "def456deadbeefabc123deadbeefabc123deadbe";
      return {
        exitCode: 0,
        stdout: `${submittedOid}\n${FULL_REPOSITORY_OID}\n`,
        stderr: ""
      };
    }
    const firstLine = input.stdin?.split("\n", 1)[0] ?? "";
    const encodedChecks = firstLine.split(" ", 3)[2] ?? "";
    const requestedChecks = JSON.parse(
      Buffer.from(encodedChecks, "base64").toString("utf8")
    ) as Array<Record<string, unknown>>;
    if (
      input.stdin?.endsWith(CATALOG_INSPECTION_SQL) ||
      input.stdin?.includes("'public._prisma_migrations'")
    ) {
      return {
        exitCode: this.catalogExitCode,
        stdout: this.malformedCatalog
          ? "not-json\n"
          : `${JSON.stringify({
              migration_history_available: this.historyAvailable,
              checks: requestedChecks.flatMap<Record<string, unknown>>(
                (check, index) => {
                  if (check.kind === "relation") {
                    return [{
                      index,
                      kind: "relation",
                      target: `${check.schema}.${check.name}`,
                      present: true,
                      relation_kind: "table"
                    }];
                  }
                  if (check.kind === "row-security") {
                    return [{
                      index,
                      kind: "row-security",
                      target: `${check.schema}.${check.relation}`,
                      present: true,
                      enabled: check.enabled,
                      force: check.force,
                      roles: (check.roles_without_bypass as string[]).map(
                        (role) => ({ role, bypasses_rls: false })
                      )
                    }];
                  }
                  if (check.kind === "schema-privilege") {
                    return [{
                      index,
                      kind: "schema-privilege",
                      target:
                        `${check.schema}:${check.role}:${check.privilege}`,
                      present: true,
                      role: check.role,
                      privilege: check.privilege,
                      granted: check.granted
                    }];
                  }
                  return [];
                }
              )
            })}\n`,
        stderr:
          this.catalogExitCode === 0
            ? ""
            : "canceling statement due to statement timeout"
      };
    }
    if (
      input.stdin?.endsWith(MIGRATION_INSPECTION_SQL) ||
      input.stdin?.includes("from public._prisma_migrations history")
    ) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          checks: requestedChecks.flatMap((check, index) =>
            check.kind === "migration"
              ? [{
                  index,
                  kind: "migration",
                  target: check.version,
                  present: false,
                  history_available: true
                }]
              : []
          )
        })}\n`,
        stderr: ""
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: "unexpected process call"
    };
  }
}

const credentials = {
  secret_key: "secret-canary",
  management_token: "management-canary",
  database_access:
    "postgresql://postgres:db-canary@db.example.test:5432/postgres"
};

describe("live Supabase executor", () => {
  const schemaPayload = parseSchemaInspectionPayload({
    checks: [
      { kind: "migration", version: "99999999999999" },
      { kind: "relation", schema: "pg_catalog", name: "pg_class" }
    ]
  });

  test("resolves an executable from an explicit service PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "supadrum-bin-"));
    const executable = join(directory, "supabase");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(
      resolveExecutable("supabase", { PATH: directory })
    ).toBe(executable);
  });

  test("derives a decoded PostgreSQL password without returning the URI", () => {
    expect(
      databasePassword(
        "postgresql://postgres:p%40ss%3Aword@db.example.test/postgres"
      )
    ).toBe("p@ss:word");
  });

  test("plans migrations with credentials in environment and never argv", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-"));
    const process = new RecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("migration.plan", {}),
      liveProject(repository),
      credentials
    );

    expect(process.calls[0]?.argv).toEqual([
      "git",
      "-C",
      repository,
      "rev-parse",
      "abc123^{commit}",
      "HEAD"
    ]);
    const command = process.calls[1];
    expect(command?.argv).toEqual([
      "supabase",
      "db",
      "push",
      "--dry-run",
      "--linked"
    ]);
    expect(command?.env.SUPABASE_ACCESS_TOKEN).toBe(
      "management-canary"
    );
    expect(command?.env.SUPABASE_DB_PASSWORD).toBe("db-canary");
    expect(command?.argv.join(" ")).not.toMatch(
      /management-canary|db-canary|postgresql:\/\//
    );
    expect(JSON.stringify(result)).not.toMatch(
      /management-canary|db-canary/
    );
  });

  test("plans a local chamber only after a loopback preflight", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-"));
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("migration.plan", {}),
      localProject(repository),
      credentials
    );

    expect(process.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", repository, "rev-parse", "abc123^{commit}", "HEAD"],
      ["supabase", "status", "--output", "json"],
      ["supabase", "db", "push", "--dry-run", "--local"]
    ]);
    for (const call of process.calls) {
      expect(call.argv).not.toContain("--linked");
      expect(call.argv).not.toContain("--db-url");
      expect(call.env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
      expect(call.env.SUPABASE_DB_PASSWORD).toBeUndefined();
    }
    expect(result.verification).toMatchObject({
      repo_sha_verified: true,
      target: "local",
      local_preflight: true
    });
  });

  test("resets one SNAP password locally without persisting plaintext in the job", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-auth-"));
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("auth.admin", {
        action: "reset-password",
        adapter: "snap-password",
        email: "codex.local@materic.test",
        profile: "local-development"
      }),
      Object.assign(localProject(repository), {
        capabilities: ["migrations", "auth-admin"] as const
      }),
      credentials
    );

    expect(process.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", repository, "rev-parse", "abc123^{commit}", "HEAD"],
      ["supabase", "status", "--output", "json"],
      ["psql", ...SCHEMA_INSPECTION_PSQL_ARGS]
    ]);
    const command = process.calls[2];
    expect(command?.env).toMatchObject({
      PGHOST: "127.0.0.1",
      PGPORT: "54322",
      PGDATABASE: "postgres",
      PGUSER: "postgres",
      PGSSLMODE: "disable"
    });
    expect(command?.stdin).toContain("codex.local@materic.test");
    expect(command?.stdin).toContain("$argon2id$");
    expect(command?.stdin).toContain("GET DIAGNOSTICS");
    expect(command?.stdin).not.toContain("TestPassword1234");
    expect(JSON.stringify(result)).not.toContain("TestPassword1234");
    expect(result.verification).toMatchObject({
      repo_sha_verified: true,
      target: "local",
      local_preflight: true,
      auth_adapter: "snap-password",
      password_profile: "local-development"
    });
  });

  test("inspects local organizations without returning fiscal or credential data", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-auth-"));
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("auth.admin", {
        action: "inspect-organizations",
        adapter: "snap-auth"
      }),
      Object.assign(localProject(repository), {
        capabilities: ["migrations", "auth-admin"] as const
      }),
      credentials
    );

    expect(process.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", repository, "rev-parse", "abc123^{commit}", "HEAD"],
      ["supabase", "status", "--output", "json"],
      ["psql", ...SCHEMA_INSPECTION_PSQL_ARGS]
    ]);
    const command = process.calls[2];
    expect(command?.stdin).toContain("begin transaction read only");
    expect(command?.stdin).toContain("json_build_object");
    expect(command?.stdin).toContain("'name', organization.name");
    expect(command?.stdin).toContain("'products'");
    expect(command?.stdin).toContain("'document_ingests'");
    expect(command?.stdin).not.toContain("vat_number");
    expect(command?.stdin).not.toContain("credentials");
    expect(result.verification).toMatchObject({
      repo_sha_verified: true,
      target: "local",
      local_preflight: true,
      auth_action: "inspect-organizations",
      auth_adapter: "snap-auth"
    });
  });

  test("recreates a local test user in the ready SNAP Dev organization", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-auth-"));
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("auth.admin", {
        action: "recreate-test-user",
        adapter: "snap-password",
        email: "test@materic.dev",
        profile: "local-development",
        organization: "snap-dev-ready"
      }),
      Object.assign(localProject(repository), {
        capabilities: ["migrations", "auth-admin"] as const
      }),
      credentials
    );

    expect(process.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", repository, "rev-parse", "abc123^{commit}", "HEAD"],
      ["supabase", "status", "--output", "json"],
      ["psql", ...SCHEMA_INSPECTION_PSQL_ARGS]
    ]);
    const command = process.calls[2];
    expect(command?.stdin).toContain("test@materic.dev");
    expect(command?.stdin).toContain("a1b2c3d4-0002-4000-8000-000000000001");
    expect(command?.stdin).toContain("Expected the SNAP Dev organization");
    expect(command?.stdin).toContain("onboarding_completed = true");
    expect(command?.stdin).toContain("insert into public.users");
    expect(command?.stdin).toContain("insert into public.organization_members");
    expect(command?.stdin).toContain("insert into public.credentials");
    expect(command?.stdin).toContain("update public.auth_sessions");
    expect(command?.stdin).not.toContain("TestPassword1234");
    expect(JSON.stringify(result)).not.toContain("TestPassword1234");
    expect(result.verification).toMatchObject({
      repo_sha_verified: true,
      target: "local",
      local_preflight: true,
      auth_action: "recreate-test-user",
      auth_adapter: "snap-password",
      organization_selector: "snap-dev-ready",
      password_profile: "local-development"
    });
  });

  test("rejects unsupported local password profiles before touching the database", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-auth-"));
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    await expect(
      executor.execute(
        runningJob("auth.admin", {
          action: "reset-password",
          adapter: "snap-password",
          email: "codex.local@materic.test",
          profile: "operator-secret"
        }),
        Object.assign(localProject(repository), {
          capabilities: ["migrations", "auth-admin"] as const
        }),
        credentials
      )
    ).rejects.toThrow(/password profile/i);

    expect(process.calls).toHaveLength(1);
  });

  test("resets a local chamber with preflight and postflight checks", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-"));
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("migration.apply", {}),
      localProject(repository),
      credentials
    );

    expect(process.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", repository, "rev-parse", "abc123^{commit}", "HEAD"],
      ["supabase", "status", "--output", "json"],
      ["supabase", "db", "reset", "--local", "--no-seed"],
      ["supabase", "status", "--output", "json"]
    ]);
    expect(result.verification).toMatchObject({
      repo_sha_verified: true,
      target: "local",
      local_preflight: true,
      local_postflight: true
    });
  });

  test("plans local migrations through the repository SNAP runner", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-plan-"));
    const api = join(repository, "api");
    const snap = join(api, "node_modules", ".bin", "snap");
    mkdirSync(dirname(snap), { recursive: true });
    writeFileSync(snap, "#!/bin/sh\n");
    chmodSync(snap, 0o755);
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("migration.plan", {
        migration_runner: "snap",
        working_directory: "api"
      }),
      localProject(repository),
      credentials
    );

    expect(process.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", repository, "rev-parse", "abc123^{commit}", "HEAD"],
      ["supabase", "status", "--output", "json"],
      [snap, "migrate", "--dry-run"]
    ]);
    expect(process.calls[2]).toMatchObject({
      cwd: api,
      env: {
        DATABASE_URL:
          "postgresql://postgres:secret@127.0.0.1:54322/postgres"
      }
    });
    expect(process.calls[2]?.env.PATH?.split(":")[0]).toBe(
      dirname(globalThis.process.execPath)
    );
    expect(process.calls[2]?.argv.join(" ")).not.toContain("secret");
    expect(result.verification).toMatchObject({
      migration_runner: "snap",
      local_preflight: true,
      target: "local"
    });
  });

  test("resets locally then applies framework and app migrations through SNAP", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-apply-"));
    const api = join(repository, "api");
    const snap = join(api, "node_modules", ".bin", "snap");
    mkdirSync(dirname(snap), { recursive: true });
    writeFileSync(snap, "#!/bin/sh\n");
    chmodSync(snap, 0o755);
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("migration.apply", {
        migration_runner: "snap",
        working_directory: "api"
      }),
      localProject(repository),
      credentials
    );

    expect(process.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", repository, "rev-parse", "abc123^{commit}", "HEAD"],
      ["supabase", "status", "--output", "json"],
      ["supabase", "db", "reset", "--local", "--no-seed"],
      [snap, "migrate"],
      ["supabase", "status", "--output", "json"]
    ]);
    expect(process.calls[3]).toMatchObject({
      cwd: api,
      env: {
        DATABASE_URL:
          "postgresql://postgres:secret@127.0.0.1:54322/postgres"
      }
    });
    expect(result.verification).toMatchObject({
      migration_runner: "snap",
      local_postflight: true,
      target: "local"
    });
  });

  test("rejects a SNAP working directory outside the repository", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-path-"));
    const process = new LocalRecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    await expect(
      executor.execute(
        runningJob("migration.apply", {
          migration_runner: "snap",
          working_directory: "../outside"
        }),
        localProject(repository),
        credentials
      )
    ).rejects.toThrow(/inside.*repository/i);

    expect(process.calls).toHaveLength(1);
  });

  test("refuses a local migration when status resolves to a non-loopback database", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-"));
    const process = new LocalRecordingProcess(false);
    const executor = new LiveSupabaseExecutor({ process });

    await expect(
      executor.execute(
        runningJob("migration.apply", {}),
        localProject(repository),
        credentials
      )
    ).rejects.toThrow(/loopback|local/i);

    expect(process.calls).toHaveLength(2);
    expect(process.calls.some((call) => call.argv.includes("reset"))).toBe(false);
  });

  test("plans Prisma migrations with migrate status and DATABASE_URL only in environment", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-prisma-"));
    const process = new RecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("migration.plan", {}),
      liveProject(repository, "prisma"),
      credentials
    );

    const command = process.calls[1];
    expect(command?.argv).toEqual([
      "prisma",
      "migrate",
      "status"
    ]);
    expect(command?.env.DATABASE_URL).toBe(credentials.database_access);
    expect(command?.env.DIRECT_DATABASE_URL).toBe(
      credentials.database_access
    );
    expect(command?.env.PATH?.split(":")[0]).toBe(
      dirname(globalThis.process.execPath)
    );
    expect(command?.env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
    expect(command?.env.SUPABASE_DB_PASSWORD).toBeUndefined();
    expect(command?.argv.join(" ")).not.toMatch(
      /management-canary|db-canary|postgresql:\/\//
    );
    expect(JSON.stringify(result)).not.toMatch(
      /management-canary|db-canary|postgresql:\/\//
    );
  });

  test("completes Prisma migration plan when status reports pending migrations", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-prisma-"));
    const process = new PendingPrismaProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("migration.plan", {}),
      liveProject(repository, "prisma"),
      credentials
    );

    expect(result).toMatchObject({
      output: {
        exit_code: 1,
        stdout: expect.stringContaining(
          "20260729203000_server_backed_templates"
        )
      },
      verification: {
        repo_sha_verified: true,
        pending_migrations: true
      }
    });
  });

  test("fails Prisma migration plan on a connection error", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-prisma-"));
    const process = new PendingPrismaProcess(true);
    const executor = new LiveSupabaseExecutor({ process });

    await expect(
      executor.execute(
        runningJob("migration.plan", {}),
        liveProject(repository, "prisma"),
        credentials
      )
    ).rejects.toThrow(/P1001/);
  });

  test("applies Prisma migrations with migrate deploy", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-prisma-"));
    const process = new RecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    await executor.execute(
      runningJob("migration.apply", {}),
      liveProject(repository, "prisma"),
      credentials
    );

    expect(process.calls[1]?.argv).toEqual([
      "prisma",
      "migrate",
      "deploy"
    ]);
    expect(process.calls[1]?.env.DATABASE_URL).toBe(
      credentials.database_access
    );
  });

  test("resolves only the missing suffix of a clean tracked Prisma prefix", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-baseline-"));
    const sources = {
      "001_init": "select 1;\n",
      "002_rls": "select 2;\n",
      "003_api": "select 3;\n"
    };
    for (const [name, source] of Object.entries(sources)) {
      const directory = join(
        repository,
        "prisma",
        "migrations",
        name
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "migration.sql"), source);
    }
    const process = new PrismaBaselineProcess(sources, [{
      migration_name: "001_init",
      checksum: createHash("sha256")
        .update(sources["001_init"])
        .digest("hex"),
      started_at: "2026-07-30T00:00:00.000Z",
      finished_at: "2026-07-30T00:00:00.500Z",
      rolled_back_at: null,
      logs: null
    }]);
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("migration.baseline", {
        migrations: ["001_init", "002_rls"]
      }),
      liveProject(repository, "prisma"),
      credentials
    );

    expect(result.output).toEqual({
      requested: ["001_init", "002_rls"],
      already_applied: ["001_init"],
      resolved: ["002_rls"],
      verified_prefix_length: 2
    });
    const resolveCalls = process.calls.filter(
      ({ argv }) => argv[1] === "migrate" && argv[2] === "resolve"
    );
    expect(resolveCalls.map(({ argv }) => argv.slice(1))).toEqual([
      ["migrate", "resolve", "--applied", "002_rls"]
    ]);
    expect(resolveCalls[0]?.env.DATABASE_URL).toBe(
      credentials.database_access
    );
    expect(resolveCalls[0]?.argv.join(" ")).not.toContain(
      credentials.database_access
    );
    const snapshotCalls = process.calls.filter(
      ({ argv }) =>
        argv[0] === "git" &&
        (argv[3] === "ls-tree" || argv[3] === "show")
    );
    expect(
      snapshotCalls.every(({ argv }) =>
        argv.join(" ").includes(FULL_REPOSITORY_OID)
      )
    ).toBe(true);
  });

  test("blocks a dirty requested migration before psql or Prisma", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-baseline-"));
    const directory = join(
      repository,
      "prisma",
      "migrations",
      "001_init"
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "migration.sql"), "select 1;\n");
    const process = new PrismaBaselineProcess(
      { "001_init": "select 1;\n" },
      [],
      "?? prisma/migrations/001_init/untracked.sql\n"
    );
    const executor = new LiveSupabaseExecutor({ process });

    await expect(
      executor.execute(
        runningJob("migration.baseline", {
          migrations: ["001_init"]
        }),
        liveProject(repository, "prisma"),
        credentials
      )
    ).rejects.toThrow("not clean at the repository OID");
    expect(
      process.calls.some(({ argv }) => argv[0] === "psql")
    ).toBe(false);
  });

  test("redacts a decoded database password from Prisma baseline failures", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-baseline-"));
    const directory = join(
      repository,
      "prisma",
      "migrations",
      "001_init"
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "migration.sql"), "select 1;\n");
    const process = new PrismaBaselineProcess(
      { "001_init": "select 1;\n" },
      [],
      "",
      "connection rejected password db-canary"
    );
    const executor = new LiveSupabaseExecutor({ process });

    const execution = executor.execute(
      runningJob("migration.baseline", {
        migrations: ["001_init"]
      }),
      liveProject(repository, "prisma"),
      credentials
    );

    await expect(execution).rejects.not.toThrow(/db-canary/);
    await expect(execution).rejects.toThrow("[REDACTED]");
  });

  test("uses the repository-pinned Prisma executable when installed", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-prisma-"));
    const executable = join(
      repository,
      "node_modules",
      ".bin",
      "prisma"
    );
    mkdirSync(join(repository, "node_modules", ".bin"), {
      recursive: true
    });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const process = new RecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    await executor.execute(
      runningJob("migration.plan", {}),
      liveProject(repository, "prisma"),
      credentials
    );

    expect(process.calls[1]?.argv[0]).toBe(executable);
  });

  test("rejects SQL paths outside the repository before starting psql", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-sql-"));
    const process = new RecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    await expect(
      executor.execute(
        runningJob("sql.execute", {
          path: "../escape.sql",
          digest: "0".repeat(64)
        }),
        liveProject(repository),
        credentials
      )
    ).rejects.toThrow(
      "SQL file must be inside the project repository"
    );
    expect(process.calls).toHaveLength(1);
  });

  test("executes a digest-pinned repository SQL file without a database URL in argv", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-sql-"));
    const sqlDirectory = join(repository, "supabase", "queries");
    mkdirSync(sqlDirectory, { recursive: true });
    const sqlPath = join(sqlDirectory, "inspect.sql");
    const sql = "select 1;\n";
    writeFileSync(sqlPath, sql);
    const digest = createHash("sha256").update(sql).digest("hex");
    const process = new RecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    await executor.execute(
      runningJob("sql.execute", {
        path: "supabase/queries/inspect.sql",
        digest
      }),
      liveProject(repository),
      credentials
    );

    const command = process.calls[1];
    expect(command?.argv).toEqual([
      "psql",
      "--set",
      "ON_ERROR_STOP=1",
      "--file",
      sqlPath
    ]);
    expect(command?.env.PGPASSWORD).toBe("db-canary");
    expect(command?.argv.join(" ")).not.toContain("db-canary");
  });

  test("executes generic schema checks through static read-only psql programs", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-schema-"));
    const process = new SchemaInspectionProcess();
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("schema.inspect", schemaPayload),
      liveProject(repository),
      credentials
    );

    expect(result).toMatchObject({
      output: {
        compatible: false,
        scope: { requested_checks: 2 }
      },
      verification: {
        repo_sha_verified: true,
        read_only: true,
        requested_checks: 2
      }
    });
    expect(process.calls[0]?.argv).toEqual([
      "git",
      "-C",
      repository,
      "rev-parse",
      "abc123^{commit}",
      "HEAD"
    ]);
    expect(process.calls[1]?.argv).toEqual([
      "psql",
      ...SCHEMA_INSPECTION_PSQL_ARGS
    ]);
    expect(process.calls[1]?.stdin).toBe(
      schemaInspectionPsqlInput(schemaPayload, CATALOG_INSPECTION_SQL)
    );
    expect(process.calls[2]?.stdin).toBe(
      schemaInspectionPsqlInput(schemaPayload, MIGRATION_INSPECTION_SQL)
    );
    expect(
      process.calls[1]?.env.SUPADRUM_SCHEMA_CHECKS
    ).toBeUndefined();
    expect(process.calls[1]?.env.PGOPTIONS).toContain(
      "default_transaction_read_only=on"
    );
    expect(process.calls[1]?.argv.join(" ")).not.toMatch(
      /99999999999999|secret-canary|management-canary|db-canary/
    );
    expect(JSON.stringify(result)).not.toMatch(
      /secret-canary|management-canary|db-canary/
    );
  });

  test("executes schema security checks through the existing read-only catalog phase", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-security-"));
    const process = new SchemaInspectionProcess();
    const executor = new LiveSupabaseExecutor({ process });
    const securityPayload = parseSchemaInspectionPayload({
      checks: [
        {
          kind: "row-security",
          schema: "public",
          relation: "templates",
          enabled: true,
          force: false,
          roles_without_bypass: ["anon", "authenticated"]
        },
        {
          kind: "schema-privilege",
          schema: "private",
          role: "authenticated",
          privilege: "USAGE",
          granted: true
        }
      ]
    });

    const result = await executor.execute(
      runningJob("schema.inspect", securityPayload),
      liveProject(repository, "prisma"),
      credentials
    );

    expect(result).toMatchObject({
      output: {
        compatible: true,
        scope: { requested_checks: 2 }
      },
      verification: {
        repo_sha_verified: true,
        read_only: true,
        requested_checks: 2
      }
    });
    expect(process.calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(
      /secret-canary|management-canary|db-canary|pg_get_expr|relacl|proacl/
    );
  });

  test("inspects Prisma migration history through _prisma_migrations", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-prisma-schema-"));
    const process = new SchemaInspectionProcess();
    const executor = new LiveSupabaseExecutor({ process });

    await executor.execute(
      runningJob("schema.inspect", schemaPayload),
      liveProject(repository, "prisma"),
      credentials
    );

    expect(process.calls[1]?.stdin).toMatch(
      /to_regclass\([\s\S]*'public\._prisma_migrations'/
    );
    expect(process.calls[2]?.stdin).toContain(
      "from public._prisma_migrations history"
    );
    expect(process.calls[2]?.stdin).toMatch(
      /history\.migration_name[\s\S]+like/
    );
    expect(process.calls[2]?.stdin).toContain(
      "history.finished_at is not null"
    );
    expect(process.calls[2]?.stdin).toContain(
      "history.rolled_back_at is null"
    );
  });

  test("completes absent migration history without starting migration SQL", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-schema-"));
    const process = new SchemaInspectionProcess(false);
    const executor = new LiveSupabaseExecutor({ process });

    const result = await executor.execute(
      runningJob("schema.inspect", schemaPayload),
      liveProject(repository),
      credentials
    );

    expect(process.calls).toHaveLength(2);
    expect(result.output).toMatchObject({ compatible: false });
    expect(
      (result.output as {
        checks: readonly Record<string, unknown>[];
      }).checks[0]
    ).toMatchObject({
        kind: "migration",
        present: false,
        history_available: false
    });
  });

  test("does not start migration SQL when no migration check was requested", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-schema-"));
    const process = new SchemaInspectionProcess();
    const executor = new LiveSupabaseExecutor({ process });
    const relationOnlyPayload = parseSchemaInspectionPayload({
      checks: [{
        kind: "relation",
        schema: "pg_catalog",
        name: "pg_class"
      }]
    });

    const result = await executor.execute(
      runningJob("schema.inspect", relationOnlyPayload),
      liveProject(repository),
      credentials
    );

    expect(process.calls).toHaveLength(2);
    expect(process.calls[1]?.stdin).toBe(
      schemaInspectionPsqlInput(
        relationOnlyPayload,
        CATALOG_INSPECTION_SQL
      )
    );
    expect(result.output).toMatchObject({ compatible: true });
  });

  test("rejects a repository SHA mismatch before starting psql", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-schema-"));
    const process = new SchemaInspectionProcess();
    const executor = new LiveSupabaseExecutor({ process });
    const job = {
      ...runningJob("schema.inspect", schemaPayload),
      repo_sha: "def456"
    };

    await expect(
      executor.execute(job, liveProject(repository), credentials)
    ).rejects.toThrow(/repository sha mismatch/i);
    expect(process.calls).toHaveLength(1);
    expect(process.calls[0]?.argv[0]).toBe("git");
  });

  test("fails schema inspection when psql enforces its timeout", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-schema-"));
    const process = new SchemaInspectionProcess(true, false, 1);
    const executor = new LiveSupabaseExecutor({ process });

    await expect(
      executor.execute(
        runningJob("schema.inspect", schemaPayload),
        liveProject(repository),
        credentials
      )
    ).rejects.toThrow(/statement timeout/i);
    expect(process.calls).toHaveLength(2);
  });

  test("fails schema inspection on malformed catalog output", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-schema-"));
    const process = new SchemaInspectionProcess(true, true);
    const executor = new LiveSupabaseExecutor({ process });

    await expect(
      executor.execute(
        runningJob("schema.inspect", schemaPayload),
        liveProject(repository),
        credentials
      )
    ).rejects.toThrow(/catalog inspection output/i);
    expect(process.calls).toHaveLength(2);
  });

  test("deploys a named function with the project ref and token outside argv", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-fn-"));
    const process = new RecordingProcess();
    const executor = new LiveSupabaseExecutor({ process });

    await executor.execute(
      runningJob("functions.deploy", { name: "send-report" }),
      liveProject(repository),
      credentials
    );

    const command = process.calls[1];
    expect(command?.argv).toEqual([
      "supabase",
      "functions",
      "deploy",
      "send-report",
      "--project-ref",
      "abcdefghijklmnopqrst",
      "--use-api"
    ]);
    expect(command?.env.SUPABASE_ACCESS_TOKEN).toBe(
      "management-canary"
    );
    expect(command?.argv.join(" ")).not.toContain(
      "management-canary"
    );
  });

  test("sets only operator-mapped secrets through the Management API", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-live-secret-"));
    const process = new RecordingProcess();
    const requests: Array<{
      readonly url: string;
      readonly body: string | undefined;
    }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : undefined
      });
      return new Response('{"created":1}', { status: 200 });
    };
    const executor = new LiveSupabaseExecutor({
      process,
      fetch: fetcher,
      resolveReference: async (reference) => {
        expect(reference).toBe(
          "vault://supabase/example-platform/functions/STRIPE_KEY"
        );
        return "stripe-canary";
      }
    });

    const result = await executor.execute(
      runningJob("secrets.set", { names: ["STRIPE_KEY"] }),
      liveProject(repository),
      credentials
    );

    expect(requests).toEqual([
      {
        url: "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/secrets",
        body: '[{"name":"STRIPE_KEY","value":"stripe-canary"}]'
      }
    ]);
    expect(JSON.stringify(result)).not.toContain("stripe-canary");
  });
});

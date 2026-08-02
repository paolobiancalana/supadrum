import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { SupadrumConfig } from "../src/config.js";
import type {
  ExecutionResult,
  Job,
  JobSubmission
} from "../src/domain.js";
import {
  MissingCredentialsError,
  Runner,
  type CredentialProvider,
  type Executor
} from "../src/runner.js";
import { SqliteStore } from "../src/store.js";

let currentTime = new Date("2026-07-29T15:00:00.000Z");
const now = () => currentTime;
const stores: SqliteStore[] = [];

function projectConfig(): SupadrumConfig {
  return {
    version: 1,
    database: ".supadrum/queue.sqlite",
    database_path: "/tmp/queue.sqlite",
    config_path: "/tmp/supadrum.yml",
    executor: "command",
    approval_mode: "manual",
    chambers: {
      alpha: {
        project_ref: "alpha-ref",
        credentials: {
          secret_key: "vault://supabase/alpha/secret",
          management_token: "vault://supabase/alpha/management",
          database_access: "vault://supabase/alpha/postgres"
        }
      },
      beta: {
        project_ref: "beta-ref",
        credentials: {
          secret_key: "vault://supabase/beta/secret",
          management_token: "vault://supabase/beta/management",
          database_access: "vault://supabase/beta/postgres"
        }
      }
    },
    projects: {
      alpha: {
        chamber: "alpha",
        project_ref: "alpha-ref",
        credentials: {
          secret_key: "vault://supabase/alpha/secret",
          management_token: "vault://supabase/alpha/management",
          database_access: "vault://supabase/alpha/postgres"
        },
        capabilities: ["data-api", "migrations", "project-management"],
        mode: "live",
        migrations: "owner",
        migration_driver: "supabase"
      },
      beta: {
        chamber: "beta",
        project_ref: "beta-ref",
        credentials: {
          secret_key: "vault://supabase/beta/secret",
          management_token: "vault://supabase/beta/management",
          database_access: "vault://supabase/beta/postgres"
        },
        capabilities: ["data-api", "migrations", "project-management"],
        mode: "live",
        migrations: "owner",
        migration_driver: "supabase"
      },
      "alpha-ios": {
        chamber: "alpha",
        project_ref: "alpha-ref",
        credentials: {
          secret_key: "vault://supabase/alpha/secret",
          management_token: "vault://supabase/alpha/management",
          database_access: "vault://supabase/alpha/postgres"
        },
        capabilities: ["data-api", "migrations", "project-management"],
        mode: "live",
        migrations: "consumer",
        migration_driver: "supabase"
      }
    }
  };
}

function createStore() {
  const path = join(
    mkdtempSync(join(tmpdir(), "supadrum-runner-")),
    "queue.sqlite"
  );
  const store = new SqliteStore(path, now, "manual");
  stores.push(store);
  return store;
}

function submit(
  store: SqliteStore,
  project: string,
  operation: JobSubmission["operation"],
  suffix: string
) {
  return store.submit({
    project,
    operation,
    payload:
      operation === "migration.baseline"
        ? { migrations: ["001_init"] }
        : { migration: `${suffix}.sql` },
    repo_sha: "abc123",
    idempotency_key: `${project}:abc123:${suffix}`
  });
}

class RecordingExecutor implements Executor {
  readonly calls: string[] = [];

  async mount(project: string): Promise<void> {
    this.calls.push(`mount:${project}`);
  }

  async drain(): Promise<void> {
    this.calls.push("drain");
  }

  async unmount(): Promise<void> {
    this.calls.push("unmount");
  }

  async execute(job: Job): Promise<ExecutionResult> {
    this.calls.push(`execute:${job.project}:${job.operation}`);
    return {
      output: { job: job.id },
      verification: { ok: true }
    };
  }
}

class AvailableCredentials implements CredentialProvider {
  async resolve() {
    return {
      secret_key: "secret-value",
      management_token: "management-value",
      database_access: "postgres-value"
    };
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  currentTime = new Date("2026-07-29T15:00:00.000Z");
});

describe("global scheduler", () => {
  test("atomically grants a job when two runners tick concurrently", async () => {
    const store = createStore();
    const job = submit(store, "alpha", "migration.plan", "contended");
    const next = submit(
      store,
      "beta",
      "migration.plan",
      "contended-next"
    );
    const executor = new RecordingExecutor();
    const first = new Runner(
      store,
      projectConfig(),
      new AvailableCredentials(),
      executor,
      { now }
    );
    const second = new Runner(
      store,
      projectConfig(),
      new AvailableCredentials(),
      executor,
      { now }
    );

    await expect(
      Promise.all([first.tick(), second.tick()])
    ).resolves.toBeDefined();

    expect(store.getJob(job.id).status).toBe("completed");
    expect(store.getJob(next.id).status).toBe("queued");
    expect(
      executor.calls.filter((call) => call.startsWith("execute:"))
    ).toHaveLength(1);
  });

  test("reuses one mounted chamber across different logical projects", async () => {
    const store = createStore();
    submit(store, "alpha", "migration.plan", "one");
    submit(store, "alpha-ios", "project.inspect", "two");
    const executor = new RecordingExecutor();
    const runner = new Runner(
      store,
      projectConfig(),
      new AvailableCredentials(),
      executor,
      { now }
    );

    await runner.tick();
    await runner.tick();

    expect(executor.calls).toEqual([
      "mount:alpha",
      "execute:alpha:migration.plan",
      "execute:alpha-ios:project.inspect",
      "drain",
      "unmount"
    ]);
  });

  test.each([
    "migration.apply",
    "migration.baseline"
  ] as const)("rejects %s from a chamber consumer before credential resolution", async (operation) => {
    const store = createStore();
    const job = submit(
      store,
      "alpha-ios",
      operation,
      `consumer-${operation}`
    );
    store.approve(job.id, "operator");
    const calls: string[] = [];
    const credentials: CredentialProvider = {
      async resolve(project) {
        calls.push(project);
        return new AvailableCredentials().resolve();
      }
    };
    const runner = new Runner(
      store,
      projectConfig(),
      credentials,
      new RecordingExecutor(),
      { now }
    );

    await runner.tick();

    expect(store.getJob(job.id)).toMatchObject({
      status: "failed",
      error: "Migration owner for chamber alpha is alpha"
    });
    expect(calls).toEqual([]);
  });

  test("rejects a migrations session from a chamber consumer before credential resolution", async () => {
    const store = createStore();
    const session = store.openSession({
      project: "alpha-ios",
      capability: "migrations",
      repo_sha: "abc123",
      idempotency_key: "alpha-ios:migrations-session",
      ttl_ms: 60_000
    });
    store.approve(session.open_job_id, "operator");
    const calls: string[] = [];
    const credentials: CredentialProvider = {
      async resolve(project) {
        calls.push(project);
        return new AvailableCredentials().resolve();
      }
    };
    const runner = new Runner(
      store,
      projectConfig(),
      credentials,
      new RecordingExecutor(),
      { now }
    );

    await runner.tick();

    expect(store.getJob(session.open_job_id)).toMatchObject({
      status: "failed",
      error: "Migration owner for chamber alpha is alpha"
    });
    expect(calls).toEqual([]);
  });

  test("expires work abandoned by a dead runner", async () => {
    const store = createStore();
    const abandoned = submit(store, "alpha", "migration.plan", "abandoned");
    store.transition(abandoned.id, "granted", null, {
      lease_expires_at: "2026-07-29T14:59:00.000Z"
    });
    store.transition(abandoned.id, "running");
    const runner = new Runner(
      store,
      projectConfig(),
      new AvailableCredentials(),
      new RecordingExecutor(),
      { now }
    );

    await runner.tick();

    expect(store.getJob(abandoned.id).status).toBe("lease_expired");
  });

  test("skips an approval-blocked job and runs the first executable job", async () => {
    const store = createStore();
    const blocked = submit(store, "alpha", "migration.apply", "apply");
    const executable = submit(store, "beta", "migration.plan", "plan");
    const executor = new RecordingExecutor();
    const runner = new Runner(
      store,
      projectConfig(),
      new AvailableCredentials(),
      executor,
      { now }
    );

    await runner.tick();

    expect(store.getJob(blocked.id).status).toBe("waiting_approval");
    expect(store.getJob(executable.id).status).toBe("completed");
    expect(executor.calls).toContain("execute:beta:migration.plan");
  });

  test("automatically releases a legacy approval-gated job in automatic mode", async () => {
    const store = createStore();
    const legacy = submit(store, "alpha", "migration.apply", "legacy-apply");
    const executor = new RecordingExecutor();
    const config = {
      ...projectConfig(),
      approval_mode: "automatic" as const
    };
    const runner = new Runner(
      store,
      config,
      new AvailableCredentials(),
      executor,
      { now }
    );

    await runner.tick();

    expect(store.getJob(legacy.id)).toMatchObject({
      status: "completed",
      approved_by: "policy:automatic"
    });
    expect(executor.calls).toContain("execute:alpha:migration.apply");
  });

  test("reuses a chamber for consecutive jobs and rotates for another project", async () => {
    const store = createStore();
    submit(store, "alpha", "migration.plan", "one");
    submit(store, "alpha", "migration.plan", "two");
    submit(store, "beta", "migration.plan", "three");
    const executor = new RecordingExecutor();
    const runner = new Runner(
      store,
      projectConfig(),
      new AvailableCredentials(),
      executor,
      { now }
    );

    await runner.tick();
    await runner.tick();
    await runner.tick();

    expect(executor.calls).toEqual([
      "mount:alpha",
      "execute:alpha:migration.plan",
      "execute:alpha:migration.plan",
      "drain",
      "unmount",
      "mount:beta",
      "execute:beta:migration.plan",
      "drain",
      "unmount"
    ]);
  });

  test("marks missing credentials without blocking later work", async () => {
    const store = createStore();
    const missing = submit(store, "alpha", "migration.plan", "missing");
    const executable = submit(store, "beta", "migration.plan", "ready");
    const executor = new RecordingExecutor();
    const credentials: CredentialProvider = {
      async resolve(project) {
        if (project === "alpha") {
          throw new MissingCredentialsError(["database_access"]);
        }
        return new AvailableCredentials().resolve();
      }
    };
    const runner = new Runner(
      store,
      projectConfig(),
      credentials,
      executor,
      { now }
    );

    await runner.tick();

    expect(store.getJob(missing.id).status).toBe("waiting_credentials");
    expect(store.getJob(executable.id).status).toBe("completed");
  });
});

describe("interactive session lease", () => {
  test("holds one chamber for covered commands and drains it on close", async () => {
    const store = createStore();
    const session = store.openSession({
      project: "alpha",
      capability: "migrations",
      repo_sha: "abc123",
      idempotency_key: "alpha:session:migrations",
      ttl_ms: 60_000
    });
    store.approve(session.open_job_id, "operator");
    const executor = new RecordingExecutor();
    const runner = new Runner(
      store,
      projectConfig(),
      new AvailableCredentials(),
      executor,
      { now }
    );

    await runner.tick();
    const command = store.submitSessionJob(session.id, {
      operation: "migration.plan",
      payload: { migration: "rules.sql" },
      idempotency_key: "alpha:session:plan"
    });
    await runner.tick();
    store.requestSessionClose(session.id);
    await runner.tick();

    expect(store.getJob(command.id).status).toBe("completed");
    expect(store.getSession(session.id).status).toBe("closed");
    expect(executor.calls).toEqual([
      "mount:alpha",
      "execute:alpha:migration.plan",
      "drain",
      "unmount"
    ]);
  });

  test("expires an abandoned session and releases the chamber", async () => {
    const store = createStore();
    const session = store.openSession({
      project: "alpha",
      capability: "data-api",
      repo_sha: "abc123",
      idempotency_key: "alpha:session:data",
      ttl_ms: 1_000
    });
    const executor = new RecordingExecutor();
    const runner = new Runner(
      store,
      projectConfig(),
      new AvailableCredentials(),
      executor,
      { now }
    );

    await runner.tick();
    currentTime = new Date("2026-07-29T15:00:02.000Z");
    await runner.tick();

    expect(store.getSession(session.id).status).toBe("lease_expired");
    expect(executor.calls).toEqual([
      "mount:alpha",
      "drain",
      "unmount"
    ]);
  });
});

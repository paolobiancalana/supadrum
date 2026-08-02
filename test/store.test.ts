import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { JobSubmission } from "../src/domain.js";
import { SqliteStore } from "../src/store.js";

/**
 * Opens the queue from another process and holds it for `holdMs` without
 * switching it to WAL. Another process cannot make that switch while this
 * connection is open, and SQLite refuses it outright rather than through the
 * busy handler — which is the race two Supadrum daemons hit on a fresh queue.
 * It has to be another process: a second connection here would block the very
 * thread that must release it.
 */
async function holdUnmigratedQueue(
  path: string,
  holdMs: number
): Promise<() => void> {
  const driver = createRequire(import.meta.url).resolve("better-sqlite3");
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        `const Database = require(${JSON.stringify(driver)});`,
        `const db = new Database(${JSON.stringify(path)});`,
        `db.exec("CREATE TABLE IF NOT EXISTS holder (x)");`,
        `db.exec("BEGIN IMMEDIATE");`,
        `db.prepare("INSERT INTO holder VALUES (1)").run();`,
        `process.stdout.write("held");`,
        `setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});`
      ].join("")
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  return () => child.kill();
}

const stores: SqliteStore[] = [];
const now = () => new Date("2026-07-29T15:00:00.000Z");

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "supadrum-store-"));
  const path = join(directory, "queue.sqlite");
  const store = new SqliteStore(path, now, "manual");
  stores.push(store);
  return { path, store };
}

function submission(
  overrides: Partial<JobSubmission> = {}
): JobSubmission {
  return {
    project: "example-web",
    operation: "migration.plan",
    payload: { migration: "20260729164000_rules.sql" },
    repo_sha: "abc123",
    idempotency_key: "example-web:abc123:plan",
    ...overrides
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("opening the queue", () => {
  test("waits for another process to finish opening it", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "supadrum-store-")),
      "queue.sqlite"
    );
    const holdMs = 300;
    const release = await holdUnmigratedQueue(path, holdMs);
    const started = Date.now();

    try {
      // Whichever of the two daemons loses the race must queue behind the
      // other and start, not exit with "database is locked".
      const store = new SqliteStore(path, now, "manual");
      stores.push(store);

      expect(Date.now() - started).toBeGreaterThanOrEqual(holdMs - 50);
      expect(store.submit(submission()).status).toBe("queued");
    } finally {
      release();
    }
  });

  test("refuses a queue path that is not a database", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "supadrum-store-")),
      "queue.sqlite"
    );
    writeFileSync(path, "this is a note, not a queue");
    const started = Date.now();

    expect(() => new SqliteStore(path, now, "manual")).toThrow(
      /not a database/i
    );
    // And at once: a misconfigured database_path is not something anyone is
    // about to let go of, so it must not be retried against the busy deadline.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("can be closed more than once", () => {
    const { store } = createStore();

    store.close();

    expect(() => store.close()).not.toThrow();
  });
});

describe("durable jobs", () => {
  test("returns the original job for an identical idempotent submission", () => {
    const { store } = createStore();

    const first = store.submit(submission());
    const retried = store.submit(submission());

    expect(retried.id).toBe(first.id);
    expect(store.listJobs()).toHaveLength(1);
  });

  test("rejects reuse of an idempotency key for different work", () => {
    const { store } = createStore();
    store.submit(submission());

    expect(() =>
      store.submit(submission({ payload: { migration: "different.sql" } }))
    ).toThrow(/idempotency key/i);
  });

  test("records status transitions and exposes only events after the cursor", () => {
    const { store } = createStore();
    const job = store.submit(submission());
    const queued = store.events(job.id, 0);

    store.transition(job.id, "waiting_credentials", {
      missing: ["database_access"]
    });
    const afterQueued = store.events(job.id, queued.at(-1)?.cursor ?? 0);

    expect(queued.map((event) => event.status)).toEqual(["queued"]);
    expect(afterQueued.map((event) => event.status)).toEqual([
      "waiting_credentials"
    ]);
    expect(afterQueued[0]?.detail).toEqual({
      missing: ["database_access"]
    });
  });

  test("rejects an illegal lifecycle jump", () => {
    const { store } = createStore();
    const job = store.submit(submission());

    expect(() => store.transition(job.id, "completed")).toThrow(
      /queued.*completed/
    );
  });

  test("operator approval returns a waiting mutation to the runnable queue", () => {
    const { store } = createStore();
    const job = store.submit(
      submission({
        operation: "migration.apply",
        idempotency_key: "example-web:abc123:apply"
      })
    );
    store.transition(job.id, "waiting_approval");

    const approved = store.approve(job.id, "operator");

    expect(approved.status).toBe("queued");
    expect(approved.approved_by).toBe("operator");
    expect(store.events(job.id, 0).map((event) => event.status)).toEqual([
      "queued",
      "waiting_approval",
      "queued"
    ]);
  });

  test("does not persist chamber references with a job", () => {
    const { path, store } = createStore();
    store.submit(submission());
    store.close();
    stores.splice(stores.indexOf(store), 1);

    expect(readFileSync(path).includes("vault://supabase/example-web")).toBe(false);
  });
});

describe("session leases", () => {
  test("opens a mutable capability through an approval-gated scheduler job", () => {
    const { store } = createStore();

    const session = store.openSession({
      project: "example-web",
      capability: "migrations",
      repo_sha: "abc123",
      idempotency_key: "example-web:session:migrations",
      ttl_ms: 60_000
    });
    const openJob = store.getJob(session.open_job_id);

    expect(session.status).toBe("queued");
    expect(openJob.operation).toBe("session.open");
    expect(openJob.requires_approval).toBe(true);
  });

  test("accepts only operations covered by an active session capability", () => {
    const { store } = createStore();
    const session = store.openSession({
      project: "example-web",
      capability: "migrations",
      repo_sha: "abc123",
      idempotency_key: "example-web:session:migrations",
      ttl_ms: 60_000
    });
    store.activateSession(session.id);

    expect(() =>
      store.submitSessionJob(session.id, {
        operation: "sql.execute",
        payload: { statement_name: "health" },
        idempotency_key: "example-web:session:sql"
      })
    ).toThrow(/does not grant sql/i);

    expect(
      store.submitSessionJob(session.id, {
        operation: "migration.plan",
        payload: { migration: "rules.sql" },
        idempotency_key: "example-web:session:plan"
      }).session_id
    ).toBe(session.id);
  });
});

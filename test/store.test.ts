import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { JobSubmission } from "../src/domain.js";
import { BrokerError, type BrokerErrorCode } from "../src/errors.js";
import { SqliteStore } from "../src/store.js";

/** The code, not the wording — the code is what a caller branches on. */
function brokerErrorFrom(run: () => unknown): BrokerError {
  try {
    run();
  } catch (error) {
    if (error instanceof BrokerError) return error;
    throw error;
  }
  throw new Error("Expected a BrokerError, but nothing was thrown");
}

function expectCode(run: () => unknown, code: BrokerErrorCode): BrokerError {
  const error = brokerErrorFrom(run);
  expect(error.code).toBe(code);
  return error;
}

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

function createStore(approvalMode: "automatic" | "manual" = "manual") {
  const directory = mkdtempSync(join(tmpdir(), "supadrum-store-"));
  const path = join(directory, "queue.sqlite");
  const store = new SqliteStore(path, now, approvalMode);
  stores.push(store);
  return { path, store };
}

function openMigrationSession(store: SqliteStore) {
  return store.openSession({
    project: "example-web",
    capability: "migrations",
    repo_sha: "abc123",
    idempotency_key: "example-web:session:migrations",
    ttl_ms: 60_000
  });
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

  test("reports an unknown job by code, not by returning nothing", () => {
    const { store } = createStore();

    expectCode(
      () => store.getJob("11111111-2222-3333-4444-555555555555"),
      "unknown_job"
    );
  });

  test("treats a repeated transition as already done", () => {
    const { store } = createStore();
    const job = store.submit(submission());
    store.transition(job.id, "waiting_credentials");

    const again = store.transition(job.id, "waiting_credentials");

    // A runner that retries after a crash must not be told the move is
    // illegal, and must not double the event stream a waiter is reading.
    expect(again.status).toBe("waiting_credentials");
    expect(store.events(job.id, 0).map((event) => event.status)).toEqual([
      "queued",
      "waiting_credentials"
    ]);
  });

  test.each([
    { case: "does not require approval", operation: "migration.plan" as const },
    { case: "is past the point of approving", operation: "migration.apply" as const }
  ])("refuses to approve a job that $case", ({ operation }) => {
    const { store } = createStore();
    const job = store.submit(submission({ operation }));
    if (operation === "migration.apply") store.transition(job.id, "cancelled");

    expectCode(
      () => store.approve(job.id, "operator"),
      operation === "migration.apply"
        ? "job_state_conflict"
        : "approval_not_required"
    );
  });

  test("approves a job that is still queued without moving it", () => {
    const { store } = createStore();
    const job = store.submit(
      submission({
        operation: "migration.apply",
        idempotency_key: "example-web:abc123:apply"
      })
    );

    const approved = store.approve(job.id, "operator");

    expect(approved.status).toBe("queued");
    expect(approved.approved_by).toBe("operator");
    expect(store.events(job.id, 0).map((event) => event.status)).toEqual([
      "queued"
    ]);
  });

  test.each(["cancelled", "failed"] as const)(
    "returns a job that already %s from cancel unchanged",
    (status) => {
      const { store } = createStore();
      const job = store.submit(submission());
      store.transition(job.id, status);

      // Terminal is terminal: cancelling again is a no-op, not an illegal
      // move, so an operator retrying a cancel is not told off for it.
      expect(store.cancel(job.id).status).toBe(status);
      expect(store.events(job.id, 0)).toHaveLength(2);
    }
  );

  test.each(["running", "verifying"] as const)(
    "refuses to cancel a job that is already %s",
    (status) => {
      const { store } = createStore();
      const job = store.submit(submission());
      store.grantIfSchedulable(job.id, "2026-07-29T16:00:00.000Z");
      store.transition(job.id, "running");
      if (status === "verifying") store.transition(job.id, "verifying");

      // The executor is holding real credentials; nothing here can take them
      // back, so the queue must not pretend the work stopped.
      expectCode(() => store.cancel(job.id), "job_state_conflict");
    }
  );

  test("does not persist chamber references with a job", () => {
    const { path, store } = createStore();
    store.submit(submission());
    store.close();
    stores.splice(stores.indexOf(store), 1);

    expect(readFileSync(path).includes("vault://supabase/example-web")).toBe(false);
  });
});

describe("granting a lease", () => {
  const lease = "2026-07-29T16:00:00.000Z";

  test("grants nothing while another job holds the lease", () => {
    const { store } = createStore();
    const first = store.submit(submission());
    const second = store.submit(
      submission({ idempotency_key: "example-web:abc123:plan-2" })
    );

    expect(store.grantIfSchedulable(first.id, lease)).not.toBeNull();

    // One job at a time is the whole point of the queue: two executors
    // holding the same project's credentials is the failure it prevents.
    expect(store.grantIfSchedulable(second.id, lease)).toBeNull();
    expect(store.getJob(second.id).status).toBe("queued");
  });

  test("grants nothing for a job that has left the runnable statuses", () => {
    const { store } = createStore();
    const job = store.submit(submission());
    store.transition(job.id, "cancelled");

    expect(store.grantIfSchedulable(job.id, lease)).toBeNull();
    expect(store.getJob(job.id).status).toBe("cancelled");
  });

  test("shows a waiting job returning to the queue before it is granted", () => {
    const { store } = createStore();
    const job = store.submit(
      submission({
        operation: "migration.apply",
        idempotency_key: "example-web:abc123:apply"
      })
    );
    store.transition(job.id, "waiting_approval");

    store.grantIfSchedulable(job.id, lease);

    // A client long-polling jobs.wait reads the event stream as the story of
    // the job; going straight from waiting_approval to granted skips the
    // moment it became runnable again.
    expect(store.events(job.id, 0).map((event) => event.status)).toEqual([
      "queued",
      "waiting_approval",
      "queued",
      "granted"
    ]);
  });
});

describe("session leases", () => {
  test("opens a mutable capability through an approval-gated scheduler job", () => {
    const { store } = createStore();

    const session = openMigrationSession(store);
    const openJob = store.getJob(session.open_job_id);

    expect(session.status).toBe("queued");
    expect(openJob.operation).toBe("session.open");
    expect(openJob.requires_approval).toBe(true);
  });

  test("opens without an approval gate when the operator asked for none", () => {
    const { store } = createStore("automatic");

    const session = openMigrationSession(store);

    expect(store.getJob(session.open_job_id).requires_approval).toBe(false);
  });

  test.each([
    { case: "shorter than a second", ttl_ms: 999 },
    { case: "not a whole number of milliseconds", ttl_ms: 60_000.5 }
  ])("refuses a lease $case", ({ ttl_ms }) => {
    const { store } = createStore();

    expectCode(
      () =>
        store.openSession({
          project: "example-web",
          capability: "migrations",
          repo_sha: "abc123",
          idempotency_key: "example-web:session:migrations",
          ttl_ms
        }),
      "invalid_input"
    );
  });

  test("returns the same lease for a retried open", () => {
    const { store } = createStore();
    const first = openMigrationSession(store);

    const retried = openMigrationSession(store);

    expect(retried.id).toBe(first.id);
    expect(store.listJobs()).toHaveLength(1);
  });

  test("refuses a lease whose key already belongs to a plain job", () => {
    const { store } = createStore();
    store.submit(submission({ idempotency_key: "example-web:shared-key" }));

    expectCode(
      () =>
        store.openSession({
          project: "example-web",
          capability: "migrations",
          repo_sha: "abc123",
          idempotency_key: "example-web:shared-key",
          ttl_ms: 60_000
        }),
      "idempotency_conflict"
    );
  });

  test("reports an unknown lease by code", () => {
    const { store } = createStore();

    expectCode(
      () => store.getSession("11111111-2222-3333-4444-555555555555"),
      "unknown_session"
    );
  });

  test("activates a lease only once", () => {
    const { store } = createStore();
    const session = openMigrationSession(store);
    store.activateSession(session.id);

    expectCode(
      () => store.activateSession(session.id),
      "session_state_conflict"
    );
  });

  test.each([
    { case: "beating", act: "heartbeat" as const },
    { case: "submitting through", act: "submit" as const }
  ])("marks $case a lease that is not active as worth retrying", ({ act }) => {
    const { store } = createStore();
    const session = openMigrationSession(store);

    const error = expectCode(
      () =>
        act === "heartbeat"
          ? store.heartbeatSession(session.id)
          : store.submitSessionJob(session.id, {
              operation: "migration.plan",
              payload: { migration: "rules.sql" },
              idempotency_key: "example-web:session:plan"
            }),
      "session_not_active"
    );

    // The lease exists and its open job is still waiting to be granted; the
    // identical call succeeds once the runner activates it.
    expect(error.retryable).toBe(true);
  });

  test("says a lease is not ready before it says what it does not grant", () => {
    const { store } = createStore();
    const session = openMigrationSession(store);

    const error = expectCode(
      () =>
        store.submitSessionJob(session.id, {
          operation: "sql.execute",
          payload: { statement_name: "health" },
          idempotency_key: "example-web:session:sql"
        }),
      "session_not_active"
    );

    // Answering capability_denied here would be non-retryable, and would
    // send an agent away from a lease that was only waiting to be granted.
    expect(error.retryable).toBe(true);
  });

  test("cancels the open job when a lease is closed before it starts", () => {
    const { store } = createStore();
    const session = openMigrationSession(store);

    const closed = store.requestSessionClose(session.id);

    expect(closed.status).toBe("closed");
    expect(store.getJob(session.open_job_id).status).toBe("cancelled");
  });

  test("asks an active lease to close rather than closing it outright", () => {
    const { store } = createStore();
    const session = openMigrationSession(store);
    store.activateSession(session.id);

    // The executor still holds the chamber; the runner has to release it.
    expect(store.requestSessionClose(session.id).status).toBe("closing");
  });

  test("leaves a finished lease alone when asked to close it again", () => {
    const { store } = createStore();
    const session = openMigrationSession(store);
    store.finishSession(session.id, "lease_expired");

    expect(store.requestSessionClose(session.id).status).toBe("lease_expired");
  });

  test("accepts only operations covered by an active session capability", () => {
    const { store } = createStore();
    const session = openMigrationSession(store);
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

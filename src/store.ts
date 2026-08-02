import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import {
  operationCatalog,
  type Capability,
  type Operation
} from "./catalog.js";
import {
  JobSubmissionSchema,
  terminalJobStatuses,
  type Job,
  type JobEvent,
  type JobOperation,
  type JobStatus,
  type JobSubmission,
  type Session
} from "./domain.js";
import { BrokerError } from "./errors.js";

type Clock = () => Date;
const sqliteRetrySignal = new Int32Array(new SharedArrayBuffer(4));

function initializeWithBusyRetry(operation: () => void): void {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      operation();
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      if (
        (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      Atomics.wait(sqliteRetrySignal, 0, 0, 10);
    }
  }
}

interface JobRow {
  id: string;
  project: string;
  operation: JobOperation;
  payload_json: string;
  repo_sha: string;
  idempotency_key: string;
  capability: Job["capability"];
  requires_approval: number;
  session_id: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  lease_expires_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  result_json: string | null;
  error: string | null;
}

interface SessionRow {
  id: string;
  project: string;
  capability: Capability;
  status: Session["status"];
  open_job_id: string;
  created_at: string;
  heartbeat_at: string;
  expires_at: string | null;
  ttl_ms: number;
  repo_sha: string;
}

interface EventRow {
  cursor: number;
  job_id: string;
  status: JobStatus;
  detail_json: string | null;
  created_at: string;
}

interface TransitionPatch {
  lease_expires_at?: string | null;
  result?: unknown;
  error?: string | null;
}

const allowedTransitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: [
    "waiting_credentials",
    "waiting_approval",
    "granted",
    "failed",
    "cancelled"
  ],
  waiting_credentials: ["queued", "failed", "cancelled"],
  waiting_approval: ["queued", "failed", "cancelled"],
  granted: ["running", "failed", "cancelled", "lease_expired"],
  running: ["verifying", "failed", "cancelled", "lease_expired"],
  verifying: ["completed", "failed", "lease_expired"],
  completed: [],
  failed: [],
  cancelled: [],
  lease_expired: []
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value);
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    project: row.project,
    operation: row.operation,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    repo_sha: row.repo_sha,
    idempotency_key: row.idempotency_key,
    capability: row.capability,
    requires_approval: row.requires_approval === 1,
    session_id: row.session_id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lease_expires_at: row.lease_expires_at,
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    result: parseJson(row.result_json),
    error: row.error
  };
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    project: row.project,
    capability: row.capability,
    status: row.status,
    open_job_id: row.open_job_id,
    created_at: row.created_at,
    heartbeat_at: row.heartbeat_at,
    expires_at: row.expires_at,
    ttl_ms: row.ttl_ms,
    repo_sha: row.repo_sha
  };
}

interface StoredSubmission {
  project: string;
  operation: JobOperation;
  payload: Record<string, unknown>;
  repo_sha: string;
  idempotency_key: string;
  capability: Capability;
  requires_approval: boolean;
  session_id: string | null;
}

export interface SessionOpenInput {
  readonly project: string;
  readonly capability: Capability;
  readonly repo_sha: string;
  readonly idempotency_key: string;
  readonly ttl_ms: number;
}

export interface SessionJobInput {
  readonly operation: Operation;
  readonly payload: Record<string, unknown>;
  readonly idempotency_key: string;
}

export class SqliteStore {
  readonly #database: Database.Database;
  readonly #clock: Clock;
  readonly #approvalMode: "automatic" | "manual";
  #closed = false;

  constructor(
    path: string,
    clock: Clock = () => new Date(),
    approvalMode: "automatic" | "manual" = "automatic"
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new Database(path, { timeout: 5_000 });
    this.#clock = clock;
    this.#approvalMode = approvalMode;
    initializeWithBusyRetry(() => {
      this.#database.pragma("journal_mode = WAL");
    });
    this.#database.pragma("foreign_keys = ON");
    initializeWithBusyRetry(() => {
      this.#database.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        repo_sha TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        capability TEXT NOT NULL,
        requires_approval INTEGER NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_expires_at TEXT,
        approved_at TEXT,
        approved_by TEXT,
        result_json TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS job_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        open_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT,
        ttl_ms INTEGER NOT NULL,
        repo_sha TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS jobs_scheduler_idx
        ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS job_events_job_cursor_idx
        ON job_events(job_id, cursor);
    `);
    });
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  submit(input: JobSubmission): Job {
    const submission = JobSubmissionSchema.parse(input);
    const definition = operationCatalog[submission.operation];
    return this.#submitJob({
      ...submission,
      capability: definition.capability,
      requires_approval:
        this.#approvalMode === "manual" && definition.approval,
      session_id: null
    });
  }

  #submitJob(submission: StoredSubmission): Job {
    const requestHash = createHash("sha256")
      .update(stableJson(submission))
      .digest("hex");

    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          "SELECT * FROM jobs WHERE idempotency_key = ?"
        )
        .get(submission.idempotency_key) as JobRow | undefined;

      if (existing) {
        const storedHash = this.#database
          .prepare(
            "SELECT request_hash FROM jobs WHERE id = ?"
          )
          .pluck()
          .get(existing.id) as string;
        if (storedHash !== requestHash) {
          throw new BrokerError(
            "idempotency_conflict",
            `Idempotency key already belongs to different work: ${submission.idempotency_key}`
          );
        }
        return toJob(existing);
      }

      const timestamp = this.#clock().toISOString();
      const id = randomUUID();

      this.#database
        .prepare(
          `INSERT INTO jobs (
            id, project, operation, payload_json, repo_sha, idempotency_key,
            request_hash, capability, requires_approval, session_id, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
        )
        .run(
          id,
          submission.project,
          submission.operation,
          stableJson(submission.payload),
          submission.repo_sha,
          submission.idempotency_key,
          requestHash,
          submission.capability,
          submission.requires_approval ? 1 : 0,
          submission.session_id,
          timestamp,
          timestamp
        );
      this.#insertEvent(id, "queued", null, timestamp);
      return this.getJob(id);
    }).immediate();
  }

  getJob(id: string): Job {
    const row = this.#database
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as JobRow | undefined;
    if (!row) throw new BrokerError("unknown_job", `Unknown job: ${id}`);
    return toJob(row);
  }

  listJobs(): Job[] {
    return (
      this.#database
        .prepare("SELECT * FROM jobs ORDER BY created_at, rowid")
        .all() as JobRow[]
    ).map(toJob);
  }

  listSchedulable(): Job[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM jobs
           WHERE status IN ('queued', 'waiting_credentials', 'waiting_approval')
             AND (session_id IS NULL OR operation = 'session.open')
           ORDER BY created_at, rowid`
        )
        .all() as JobRow[]
    ).map(toJob);
  }

  grantIfSchedulable(
    id: string,
    leaseExpiresAt: string
  ): Job | null {
    return this.#database.transaction(() => {
      const active = this.#database
        .prepare(
          `SELECT 1 FROM jobs
           WHERE status IN ('granted', 'running', 'verifying')
           LIMIT 1`
        )
        .get();
      if (active) return null;
      const current = this.getJob(id);
      if (
        current.status !== "queued" &&
        current.status !== "waiting_credentials" &&
        current.status !== "waiting_approval"
      ) {
        return null;
      }
      const timestamp = this.#clock().toISOString();
      this.#database
        .prepare(
          `UPDATE jobs
           SET status = 'granted', updated_at = ?, lease_expires_at = ?
           WHERE id = ? AND status = ?`
        )
        .run(timestamp, leaseExpiresAt, id, current.status);
      if (current.status !== "queued") {
        this.#insertEvent(id, "queued", null, timestamp);
      }
      this.#insertEvent(id, "granted", null, timestamp);
      return this.getJob(id);
    }).immediate();
  }

  position(id: string): number | null {
    const index = this.listSchedulable().findIndex((job) => job.id === id);
    return index === -1 ? null : index + 1;
  }

  expireStaleJobs(now: Date): Job[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM jobs
         WHERE status IN ('granted', 'running', 'verifying')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
         ORDER BY created_at, rowid`
      )
      .all(now.toISOString()) as JobRow[];
    return rows.map((row) =>
      this.transition(row.id, "lease_expired", {
        lease_expires_at: row.lease_expires_at
      })
    );
  }

  events(jobId: string, afterCursor: number): JobEvent[] {
    return (
      this.#database
        .prepare(
          `SELECT cursor, job_id, status, detail_json, created_at
           FROM job_events
           WHERE job_id = ? AND cursor > ?
           ORDER BY cursor`
        )
        .all(jobId, afterCursor) as EventRow[]
    ).map((row) => ({
      cursor: row.cursor,
      job_id: row.job_id,
      status: row.status,
      detail: parseJson(row.detail_json),
      created_at: row.created_at
    }));
  }

  transition(
    id: string,
    next: JobStatus,
    detail: unknown = null,
    patch: TransitionPatch = {}
  ): Job {
    return this.#database.transaction(() => {
      const current = this.getJob(id);
      if (current.status === next) return current;
      if (!allowedTransitions[current.status].includes(next)) {
        throw new BrokerError(
          "internal_invariant",
          `Illegal job transition: ${current.status} -> ${next}`
        );
      }

      const timestamp = this.#clock().toISOString();
      const lease =
        patch.lease_expires_at === undefined
          ? current.lease_expires_at
          : patch.lease_expires_at;
      const result =
        patch.result === undefined
          ? current.result
          : patch.result;
      const error =
        patch.error === undefined
          ? current.error
          : patch.error;
      this.#database
        .prepare(
          `UPDATE jobs
           SET status = ?, updated_at = ?, lease_expires_at = ?,
               result_json = ?, error = ?
           WHERE id = ?`
        )
        .run(
          next,
          timestamp,
          lease,
          result === null ? null : stableJson(result),
          error,
          id
        );
      this.#insertEvent(id, next, detail, timestamp);
      return this.getJob(id);
    }).immediate();
  }

  approve(id: string, actor: string): Job {
    return this.#database.transaction(() => {
      const current = this.getJob(id);
      if (!current.requires_approval) {
        throw new BrokerError(
          "approval_not_required",
          `Job does not require approval: ${id}`
        );
      }
      if (
        current.status !== "waiting_approval" &&
        current.status !== "queued"
      ) {
        throw new BrokerError(
          "job_state_conflict",
          `Job cannot be approved from ${current.status}`
        );
      }
      const timestamp = this.#clock().toISOString();
      this.#database
        .prepare(
          `UPDATE jobs
           SET approved_at = ?, approved_by = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(timestamp, actor, timestamp, id);
      if (current.status === "waiting_approval") {
        return this.transition(id, "queued", { approved_by: actor });
      }
      return this.getJob(id);
    }).immediate();
  }

  openSession(input: SessionOpenInput): Session {
    if (!Number.isInteger(input.ttl_ms) || input.ttl_ms < 1_000) {
      throw new BrokerError(
        "invalid_input",
        "Session ttl_ms must be an integer of at least 1000"
      );
    }
    const requiresApproval = Object.values(operationCatalog).some(
      (definition) =>
        this.#approvalMode === "manual" &&
        definition.capability === input.capability &&
        definition.approval
    );

    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
        .get(input.idempotency_key) as JobRow | undefined;
      if (existing) {
        const session = this.#database
          .prepare("SELECT * FROM sessions WHERE open_job_id = ?")
          .get(existing.id) as SessionRow | undefined;
        if (!session) {
          throw new BrokerError(
            "idempotency_conflict",
            `Idempotency key already belongs to different work: ${input.idempotency_key}`
          );
        }
        return toSession(session);
      }

      const id = randomUUID();
      const openJob = this.#submitJob({
        project: input.project,
        operation: "session.open",
        payload: { session_id: id },
        repo_sha: input.repo_sha,
        idempotency_key: input.idempotency_key,
        capability: input.capability,
        requires_approval: requiresApproval,
        session_id: id
      });
      const timestamp = this.#clock().toISOString();
      this.#database
        .prepare(
          `INSERT INTO sessions (
            id, project, capability, status, open_job_id, created_at,
            heartbeat_at, expires_at, ttl_ms, repo_sha
          ) VALUES (?, ?, ?, 'queued', ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          id,
          input.project,
          input.capability,
          openJob.id,
          timestamp,
          timestamp,
          input.ttl_ms,
          input.repo_sha
        );
      return this.getSession(id);
    }).immediate();
  }

  getSession(id: string): Session {
    const row = this.#database
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    if (!row) {
      throw new BrokerError("unknown_session", `Unknown session: ${id}`);
    }
    return toSession(row);
  }

  findOpenSession(): Session | null {
    const row = this.#database
      .prepare(
        `SELECT * FROM sessions
         WHERE status IN ('active', 'closing')
         ORDER BY created_at, rowid
         LIMIT 1`
      )
      .get() as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  activateSession(id: string): Session {
    const session = this.getSession(id);
    if (session.status !== "queued") {
      throw new BrokerError(
        "session_state_conflict",
        `Session cannot activate from ${session.status}`
      );
    }
    const timestamp = this.#clock().toISOString();
    const expiresAt = new Date(
      this.#clock().getTime() + session.ttl_ms
    ).toISOString();
    this.#database
      .prepare(
        `UPDATE sessions
         SET status = 'active', heartbeat_at = ?, expires_at = ?
         WHERE id = ?`
      )
      .run(timestamp, expiresAt, id);
    return this.getSession(id);
  }

  heartbeatSession(id: string): Session {
    const session = this.getSession(id);
    if (session.status !== "active") {
      throw new BrokerError(
        "session_not_active",
        `Session is not active: ${id}`
      );
    }
    const timestamp = this.#clock().toISOString();
    const expiresAt = new Date(
      this.#clock().getTime() + session.ttl_ms
    ).toISOString();
    this.#database
      .prepare(
        "UPDATE sessions SET heartbeat_at = ?, expires_at = ? WHERE id = ?"
      )
      .run(timestamp, expiresAt, id);
    return this.getSession(id);
  }

  requestSessionClose(id: string): Session {
    const session = this.getSession(id);
    if (session.status === "closed" || session.status === "lease_expired") {
      return session;
    }
    if (session.status === "queued") {
      this.cancel(session.open_job_id);
      return this.#setSessionStatus(id, "closed");
    }
    return this.#setSessionStatus(id, "closing");
  }

  finishSession(
    id: string,
    status: "closed" | "lease_expired"
  ): Session {
    return this.#setSessionStatus(id, status);
  }

  submitSessionJob(sessionId: string, input: SessionJobInput): Job {
    const session = this.getSession(sessionId);
    if (session.status !== "active") {
      throw new BrokerError(
        "session_not_active",
        `Session is not active: ${sessionId}`
      );
    }
    const parsed = JobSubmissionSchema.parse({
      project: session.project,
      operation: input.operation,
      payload: input.payload,
      repo_sha: session.repo_sha,
      idempotency_key: input.idempotency_key
    });
    const definition = operationCatalog[parsed.operation];
    if (definition.capability !== session.capability) {
      throw new BrokerError(
        "capability_denied",
        `Session ${sessionId} does not grant ${definition.capability}; it grants ${session.capability}`
      );
    }
    this.heartbeatSession(sessionId);
    return this.#submitJob({
      ...parsed,
      capability: definition.capability,
      requires_approval: false,
      session_id: sessionId
    });
  }

  listSessionJobs(sessionId: string): Job[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM jobs
           WHERE session_id = ? AND operation != 'session.open'
             AND status = 'queued'
           ORDER BY created_at, rowid`
        )
        .all(sessionId) as JobRow[]
    ).map(toJob);
  }

  cancel(id: string): Job {
    const current = this.getJob(id);
    if ((terminalJobStatuses as readonly JobStatus[]).includes(current.status)) {
      return current;
    }
    if (current.status === "running" || current.status === "verifying") {
      throw new BrokerError(
        "job_state_conflict",
        "Running jobs cannot be cancelled atomically"
      );
    }
    return this.transition(id, "cancelled");
  }

  #insertEvent(
    jobId: string,
    status: JobStatus,
    detail: unknown,
    timestamp: string
  ): void {
    this.#database
      .prepare(
        `INSERT INTO job_events (job_id, status, detail_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        jobId,
        status,
        detail === null ? null : stableJson(detail),
        timestamp
      );
  }

  #setSessionStatus(id: string, status: Session["status"]): Session {
    this.getSession(id);
    this.#database
      .prepare("UPDATE sessions SET status = ? WHERE id = ?")
      .run(status, id);
    return this.getSession(id);
  }
}

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { loadConfig, type SupadrumConfig } from "./config.js";
import {
  FULL_OBJECT_NAME,
  terminalJobStatuses,
  type Job,
  type JobStatus
} from "./domain.js";
import { BrokerError } from "./errors.js";
import { pgtapReasons, type PgtapReason } from "./pgtap-reasons.js";
import { runnerPidPath } from "./runner-cli.js";
import { SqliteStore } from "./store.js";

export interface PgtapSeams {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

interface PgtapIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface PgtapRuntime {
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly pgtap?: PgtapSeams;
}

const USAGE = "supadrum pgtap <alias> <tree-oid> [--config PATH]";
const POLL_MS = 250;
const STATUS_MS = 5_000;
// The runner's three fixed 60 s phase limits and its 30 s margin (#46); the
// configured queue, start and test limits come on top.
const FIXED_LIMITS_MS = 3 * 60_000 + 30_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const NOT_GRANTED: readonly JobStatus[] = ["queued", "waiting_credentials", "waiting_approval"];
const CANCELLABLE: readonly JobStatus[] = [...NOT_GRANTED, "granted"];
const TERMINAL: readonly JobStatus[] = terminalJobStatuses;

/** Every non-zero exit says why and how to get past the hook. */
function stop(io: PgtapIo, code: number, cause: string): number {
  io.stderr(`pgtap: ${cause}; \`git commit --no-verify\` salta l'hook\n`);
  return code;
}

function exitCodeFor(reason: PgtapReason): 1 | 3 | 4 | 5 {
  switch (reason) {
    case "tests_failed":
      return 1;
    case "tree_invalid":
    case "tree_incomplete":
    case "extraction_failed":
    case "docker_unreachable":
    case "supabase_cli_missing":
    case "supabase_cli_too_old":
    case "no_probe_image":
    case "space_probe_failed":
    case "insufficient_space":
    case "reserved_project_id":
    case "original_port_left":
    case "ports_exhausted":
    case "tests_path_missing":
    case "cleanup_before_failed":
      return 3;
    case "start_failed":
    case "phase_timeout":
      return 4;
    case "queue_timeout":
      return 5;
    default: {
      const unmapped: never = reason;
      throw new Error(`Unmapped pgtap reason: ${String(unmapped)}`);
    }
  }
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

function runnerAlive(pidPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(pidPath, "utf8").trim();
  } catch {
    return false;
  }
  // 0 and below would signal a process group, not the runner.
  if (!/^[1-9]\d*$/.test(text)) return false;
  try {
    process.kill(Number(text), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True only when the job is now cancelled; a job already past granting stays as it is. */
function tryCancel(store: SqliteStore, job: Job): boolean {
  if (!CANCELLABLE.includes(job.status)) return false;
  try {
    return store.cancel(job.id).status === "cancelled";
  } catch (error) {
    // The runner started it between our read and the cancel.
    if (error instanceof BrokerError && error.code === "job_state_conflict") {
      return false;
    }
    throw error;
  }
}

function waitingFor(store: SqliteStore, job: Job, now: number): string {
  if (job.status === "granted" || job.status === "running" || job.status === "verifying") {
    return `in esecuzione, fase ${job.status}`;
  }
  const session = store.findOpenSession();
  if (session) {
    return `bloccato da sessione fino a ${session.expires_at ?? "scadenza ignota"}`;
  }
  const ahead = store
    .listJobs()
    .find((other) => other.id !== job.id && ["granted", "running", "verifying"].includes(other.status));
  if (ahead) {
    return `occupato da ${ahead.id} da ${Math.floor((now - Date.parse(ahead.updated_at)) / 1000)} s`;
  }
  return `in coda (posizione ${store.position(job.id) ?? "?"})`;
}

function report(io: PgtapIo, job: Job, oid: string, elapsedMs: number): number {
  const result = fields(job.result);
  const output = fields(result.output);
  const verification = fields(result.verification);
  if (typeof output.stdout === "string") io.stdout(output.stdout);
  if (typeof output.stderr === "string") io.stderr(output.stderr);

  const reason = verification.reason;
  const exitCode = output.exit_code;
  const ranTests =
    job.status === "completed" || (job.status === "failed" && reason === "tests_failed");
  if (ranTests && typeof exitCode === "number") {
    const tree = typeof verification.tree_oid === "string" ? verification.tree_oid : oid;
    const db = typeof verification.db_image === "string" ? verification.db_image : "?";
    const ms = typeof verification.duration_ms === "number" ? verification.duration_ms : elapsedMs;
    io.stdout(
      `pgtap: ${exitCode === 0 ? "verde" : `rosso (exit ${exitCode})`} tree ${tree} db ${db} in ${(ms / 1000).toFixed(1)} s\n`
    );
  }
  const residue = verification.cleanup_residue;
  if (typeof residue === "string" && residue !== "") {
    io.stderr(`pgtap: residuo dopo la pulizia: ${residue.split("\n").join("; ")}\n`);
  }

  const detail = job.error ? `: ${job.error}` : "";
  if (job.status === "completed") {
    if (exitCode === 0) return 0;
    if (typeof exitCode === "number") return stop(io, 1, "prove fallite");
    return stop(io, 4, "il job è finito senza exit_code");
  }
  if (job.status === "failed") {
    if (!(pgtapReasons as readonly unknown[]).includes(reason)) {
      return stop(io, 4, `job fallito senza una reason riconosciuta${detail}`);
    }
    const code = exitCodeFor(reason as PgtapReason);
    const phase = typeof verification.phase === "string" ? ` nella fase ${verification.phase}` : "";
    return stop(io, code, code === 1 ? "prove fallite" : `${String(reason)}${phase}${detail}`);
  }
  return stop(io, 4, `job ${job.id} finito come ${job.status}${detail}`);
}

interface Wait {
  readonly io: PgtapIo;
  readonly store: SqliteStore;
  readonly job: Job;
  readonly oid: string;
  readonly seams: PgtapSeams;
  readonly pidPath: string;
  readonly queueMs: number;
  readonly ceilingMs: number;
  readonly interrupted: () => boolean;
}

async function awaitJob(wait: Wait): Promise<number> {
  const { io, store, seams, oid } = wait;
  const id = wait.job.id;
  const startedAt = seams.now();
  let lastStatusAt = startedAt;
  for (;;) {
    const job = store.getJob(id);
    const now = seams.now();
    const elapsed = now - startedAt;
    if (TERMINAL.includes(job.status)) return report(io, job, oid, elapsed);

    if (wait.interrupted()) {
      return tryCancel(store, job)
        ? stop(io, 130, `interrotto, job ${id} annullato`)
        : stop(io, 130, `interrotto: il job ${id} continua, finisce entro i tetti, il runner ripulisce`);
    }
    if (!runnerAlive(wait.pidPath)) {
      return stop(
        io,
        2,
        `runner spento (${wait.pidPath} sparito o pid morto), job ${id} ${
          tryCancel(store, job) ? "annullato" : "già partito"
        }`
      );
    }
    if (elapsed >= wait.ceilingMs) {
      return stop(io, 5, `attesa esaurita dopo ${Math.round(elapsed / 1000)} s, job ${id} lasciato com'è`);
    }
    if (NOT_GRANTED.includes(job.status) && elapsed >= wait.queueMs && tryCancel(store, job)) {
      return stop(io, 5, `scaduto in coda dopo ${Math.round(elapsed / 1000)} s, job ${id} annullato`);
    }
    if (now - lastStatusAt >= STATUS_MS) {
      io.stderr(`pgtap: ${waitingFor(store, job, now)}\n`);
      lastStatusAt = now;
    }
    await seams.sleep(POLL_MS);
  }
}

/**
 * The commit hook's entry: queue a pgtap.run for one tree, wait for it, and
 * turn its outcome into an exit code. It never throws — a hook must always
 * get one of the documented codes.
 */
export async function runPgtap(
  args: readonly string[],
  io: PgtapIo,
  runtime: PgtapRuntime
): Promise<number> {
  const seams = runtime.pgtap ?? { now: Date.now, sleep: (ms: number) => delay(ms) };
  const refuse = (cause: string): number => stop(io, 2, cause);

  const positional: string[] = [];
  let explicit: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg !== "--config") {
      positional.push(arg);
      continue;
    }
    explicit = args[++index];
    if (!explicit) return refuse(`uso: ${USAGE}`);
  }
  const [alias, oid] = positional;
  if (!alias || !oid || positional.length !== 2) return refuse(`uso: ${USAGE}`);

  // Not resolveOperatorConfigPath: that one also picks up a supadrum.yml in
  // the working directory, and a hook runs inside the very repository it checks.
  const configPath = resolve(
    runtime.cwd,
    explicit ??
      runtime.environment.SUPADRUM_CONFIG ??
      join(
        runtime.environment.XDG_CONFIG_HOME ?? join(runtime.homeDirectory, ".config"),
        "supadrum",
        "config.yml"
      )
  );
  let config: SupadrumConfig;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  const pidPath = runnerPidPath(config.database_path);
  if (!runnerAlive(pidPath)) {
    return refuse(`il runner non gira (${pidPath} manca o il suo pid è morto): avviare supadrum-runner`);
  }
  const project = config.projects[alias];
  if (!project) return refuse(`progetto sconosciuto: ${alias}`);
  if (project.target !== "local") return refuse(`il progetto ${alias} non è local`);
  if (!project.capabilities.includes("pgtap")) {
    return refuse(`il progetto ${alias} non ha la capability pgtap`);
  }
  const chamber = project.pgtap;
  if (!chamber) return refuse(`la chamber ${project.chamber} non ha il blocco pgtap`);
  if (project.mode !== "live") {
    return refuse(`il progetto ${alias} è in mode ${project.mode}, serve live`);
  }
  if (config.executor !== "command") {
    return refuse(`executor ${config.executor} nella config, serve command`);
  }
  if (!FULL_OBJECT_NAME.test(oid)) {
    return refuse(`tree OID non valido: ${oid} (servono 40 o 64 caratteri esadecimali, non un prefisso o un ramo)`);
  }

  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  let store: SqliteStore | undefined;
  let job: Job | undefined;
  try {
    store = new SqliteStore(config.database_path, undefined, config.approval_mode);
    job = store.submit({
      project: alias,
      operation: "pgtap.run",
      payload: {},
      repo_sha: oid,
      idempotency_key: randomUUID()
    });
    io.stdout(`${job.id}\n`);
    return await awaitJob({
      io,
      store,
      job,
      oid,
      seams,
      pidPath,
      queueMs: config.pgtap.queue_timeout_ms,
      ceilingMs:
        config.pgtap.queue_timeout_ms +
        chamber.start_timeout_ms +
        chamber.test_timeout_ms +
        FIXED_LIMITS_MS,
      interrupted: () => interrupted
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return job
      ? stop(io, 4, `errore inatteso, il job ${job.id} resta nello store: ${message}`)
      : refuse(message);
  } finally {
    store?.close();
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  }
}

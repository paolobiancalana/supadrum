import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { terminalJobStatuses, type Job, type JobStatus } from "./domain.js";

const TERMINAL: readonly JobStatus[] = terminalJobStatuses;
import {
  admitTreeCommand,
  exitCodeFor,
  runnerAlive,
  waitingFor,
  type PgtapIo,
  type PgtapRuntime
} from "./pgtap-cli.js";
import { pgtapReasons, type PgtapReason } from "./pgtap-reasons.js";
import { SqliteStore } from "./store.js";

const USAGE = "supadrum stack <alias> <tree-oid> [--config PATH] -- <command...>";
const POLL_MS = 250;
const STATUS_MS = 5_000;
const HEARTBEAT_MS = 5_000;
const TTL_MS = 30_000;
// The runner's fixed 60 s prepare limit and a 30 s margin on top of the
// configured start limit; the same 60 s and margin for the cleanup.
const PREPARE_AND_MARGIN_MS = 60_000 + 30_000;
const CLOSE_MS = 60_000 + 30_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Every non-zero exit of the command's own says why; the child's code is its own. */
function stop(io: PgtapIo, code: number, cause: string): number {
  io.stderr(`stack: ${cause}\n`);
  return code;
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** The `supabase status -o env` lines, prefixed so nothing of the caller's is shadowed. */
export function stackEnvironment(status: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of status.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[`SUPADRUM_${match[1]}`] = (match[2] as string).replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

function exitOf(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? 128 + (signal ? constants.signals[signal] : 0);
}

/**
 * The verifica's entry for Playwright and Deno tests: open a stack session for
 * one tree, run the command with the stack's addresses in its environment,
 * then close the session so the runner removes the stack. The command's exit
 * code is passed through; the stack's own refusals use the pgtap codes (#59).
 */
export async function runStack(
  args: readonly string[],
  io: PgtapIo,
  runtime: PgtapRuntime
): Promise<number> {
  const seams = runtime.pgtap ?? { now: Date.now, sleep: (ms: number) => delay(ms) };
  const refuse = (cause: string): number => stop(io, 2, cause);

  const separator = args.indexOf("--");
  const command = separator < 0 ? [] : args.slice(separator + 1);
  const positional: string[] = [];
  let explicit: string | undefined;
  for (let index = 0; index < (separator < 0 ? args.length : separator); index++) {
    const arg = args[index] as string;
    if (arg !== "--config") {
      positional.push(arg);
      continue;
    }
    explicit = args[++index];
    if (!explicit || explicit === "--") return refuse(`uso: ${USAGE}`);
  }
  const [alias, oid] = positional;
  if (!alias || !oid || positional.length !== 2 || command.length === 0) {
    return refuse(`uso: ${USAGE}`);
  }
  const admitted = admitTreeCommand(runtime, explicit, alias, oid, "stack");
  if (typeof admitted === "string") return refuse(admitted);
  const { config, pidPath, chamber } = admitted;

  let interrupted = false;
  let child: ChildProcess | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = true;
    // A signal to this process alone: the terminal's reaches the child by itself.
    child?.kill(signal);
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  const store = new SqliteStore(config.database_path, undefined, config.approval_mode);
  let lastStatusAt = seams.now();
  const pulse = async (label: () => string): Promise<void> => {
    if (seams.now() - lastStatusAt >= STATUS_MS) {
      io.stderr(`stack: ${label()}\n`);
      lastStatusAt = seams.now();
    }
    await seams.sleep(POLL_MS);
  };
  let sessionId: string | undefined;
  try {
    const session = store.openSession({
      project: alias,
      capability: "stack",
      repo_sha: oid,
      idempotency_key: randomUUID(),
      ttl_ms: TTL_MS
    });
    sessionId = session.id;
    io.stderr(`stack: sessione ${session.id}\n`);

    // 1. The runner takes the session.
    const openedAt = seams.now();
    for (;;) {
      const current = store.getSession(session.id);
      if (current.status === "active") break;
      const open = store.getJob(current.open_job_id);
      if (current.status !== "queued" || TERMINAL.includes(open.status)) {
        sessionId = undefined; // nothing to close: the runner never took it
        return stop(io, 4, `sessione ${session.id} non aperta (${open.status})${open.error ? `: ${open.error}` : ""}`);
      }
      if (interrupted) {
        store.requestSessionClose(session.id);
        return stop(io, 130, `interrotto, sessione ${session.id} annullata`);
      }
      if (!runnerAlive(pidPath)) {
        store.requestSessionClose(session.id);
        return stop(io, 2, `runner spento (${pidPath} sparito o pid morto), sessione ${session.id} annullata`);
      }
      const elapsed = seams.now() - openedAt;
      if (elapsed >= config.pgtap.queue_timeout_ms) {
        store.requestSessionClose(session.id);
        return stop(io, 5, `scaduto in coda dopo ${Math.round(elapsed / 1000)} s, sessione ${session.id} annullata`);
      }
      await pulse(() => waitingFor(store, open, seams.now()));
    }

    // 2. The runner starts the stack; the heartbeat keeps the session while it does.
    let lastBeatAt = seams.now();
    const beat = () => {
      if (seams.now() - lastBeatAt < HEARTBEAT_MS) return;
      lastBeatAt = seams.now();
      store.heartbeatSession(session.id);
    };
    const served = store.submitSessionJob(session.id, {
      operation: "stack.serve",
      payload: {},
      idempotency_key: randomUUID()
    });
    const servedAt = seams.now();
    const ceilingMs = chamber.start_timeout_ms + PREPARE_AND_MARGIN_MS;
    let job: Job;
    for (;;) {
      job = store.getJob(served.id);
      if (TERMINAL.includes(job.status)) break;
      if (interrupted) return stop(io, 130, `interrotto, sessione ${session.id} chiusa, il runner ripulisce`);
      if (!runnerAlive(pidPath)) return stop(io, 2, `runner spento (${pidPath} sparito o pid morto), la sessione ${session.id} scade da sola`);
      const elapsed = seams.now() - servedAt;
      if (elapsed >= ceilingMs) return stop(io, 5, `attesa esaurita dopo ${Math.round(elapsed / 1000)} s, sessione ${session.id} chiusa`);
      beat();
      await pulse(() => `avvio dello stack, fase ${job.status}`);
    }
    const result = fields(job.result);
    const output = fields(result.output);
    const verification = fields(result.verification);
    if (job.status !== "completed" || typeof output.stdout !== "string") {
      if (typeof output.stdout === "string") io.stderr(output.stdout);
      if (typeof output.stderr === "string") io.stderr(output.stderr);
      const reason = verification.reason;
      const detail = job.error ? `: ${job.error}` : "";
      if (job.status === "failed" && (pgtapReasons as readonly unknown[]).includes(reason)) {
        const phase = typeof verification.phase === "string" ? ` nella fase ${verification.phase}` : "";
        return stop(io, exitCodeFor(reason as PgtapReason), `${String(reason)}${phase}${detail}`);
      }
      return stop(io, 4, `job ${job.id} finito come ${job.status} senza lo stato dello stack${detail}`);
    }

    // 3. The command, with the stack in its environment. A signal that landed
    // between the last poll and here has no child yet to reach.
    if (interrupted) return stop(io, 130, `interrotto prima del comando, sessione ${session.id} chiusa`);
    const env = { ...runtime.environment, ...stackEnvironment(output.stdout) };
    const startedAt = seams.now();
    const spawned = spawn(command[0] as string, command.slice(1), { cwd: runtime.cwd, env, stdio: "inherit" });
    child = spawned;
    const exited = new Promise<number>((resolve) => {
      spawned.once("error", (error) => resolve(stop(io, 127, `${command[0]}: ${error.message}`)));
      spawned.once("exit", (code, signal) => resolve(exitOf(code, signal)));
    });
    let code: number | undefined;
    for (;;) {
      code = await Promise.race([exited, seams.sleep(HEARTBEAT_MS).then(() => undefined)]);
      if (code !== undefined) break;
      try {
        store.heartbeatSession(session.id);
      } catch (error) {
        // The runner expired the session (its own clock, or a paused host): the
        // stack is gone or going, the command sees it and fails by itself.
        io.stderr(`stack: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    const db = typeof verification.db_image === "string" ? verification.db_image : "?";
    io.stderr(`stack: ${command.join(" ")} exit ${code} tree ${oid} db ${db} in ${((seams.now() - startedAt) / 1000).toFixed(1)} s\n`);
    return code;
  } catch (error) {
    return stop(io, 4, `errore inatteso: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // 4. Closing hands the stack back to the runner; wait for it so the next
    // command (a pgtap.run on the same project) finds the chamber free.
    if (sessionId) {
      try {
        store.requestSessionClose(sessionId);
        const closingAt = seams.now();
        for (;;) {
          const status = store.getSession(sessionId).status;
          if (status === "closed" || status === "lease_expired") break;
          if (!runnerAlive(pidPath)) {
            io.stderr(`stack: runner spento, lo stack resta fino alla prossima run di ${alias}\n`);
            break;
          }
          if (seams.now() - closingAt >= CLOSE_MS) {
            io.stderr(`stack: il runner non ha chiuso la sessione ${sessionId} entro ${CLOSE_MS / 1000} s\n`);
            break;
          }
          await seams.sleep(POLL_MS);
        }
      } catch (error) {
        io.stderr(`stack: chiusura fallita: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    store.close();
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  }
}

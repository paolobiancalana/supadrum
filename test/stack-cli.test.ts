import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";

import { runCli } from "../src/cli.js";
import type { Job, Session } from "../src/domain.js";
import { stackEnvironment } from "../src/stack-cli.js";
import { SqliteStore, type TransitionPatch } from "../src/store.js";

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const T0 = Date.parse("2020-01-01T00:00:00.000Z");
const STATUS = 'API_URL="http://127.0.0.1:56321"\nDB_URL=postgresql://postgres:postgres@127.0.0.1:56322/postgres\nStarted\n';
const NODE = process.execPath;
/** A child that writes its environment and cwd where told, then exits as told. */
const REPORT = "require('fs').writeFileSync(process.argv[1], JSON.stringify({ env: process.env, cwd: process.cwd() })); process.exit(Number(process.argv[2]))";
/** A child that waits until killed. */
const WAIT = "setTimeout(() => {}, 20000)";

function configYaml(options: { capabilities?: string; executor?: string; queue?: string } = {}): string {
  return `version: 1
database: queue.sqlite
executor: ${options.executor ?? "command"}
${options.queue ?? ""}chambers:
  atlas-local:
    target: local
    pgtap:
      tests_path: supabase/tests
      start_timeout_ms: 1000
projects:
  atlas:
    chamber: atlas-local
    capabilities: [${options.capabilities ?? "pgtap, stack"}]
    repo: .
    mode: live
`;
}

const stores: SqliteStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function harness(options: Parameters<typeof configYaml>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "supadrum-stack-"));
  const configPath = join(dir, "config.yml");
  writeFileSync(configPath, configYaml(options));
  const pidPath = join(dir, "runner.pid");
  writeFileSync(pidPath, `${process.pid}\n`);
  // The operator's working directory: a hook runs inside its repository, not
  // beside the config.
  const work = join(dir, "work");
  mkdirSync(work);
  let now = T0;
  const store = new SqliteStore(join(dir, "queue.sqlite"), () => new Date(now));
  stores.push(store);
  let onSleep: (ms: number) => void | Promise<void> = () => undefined;
  const h = {
    dir,
    work,
    configPath,
    pidPath,
    store,
    now: () => now,
    onSleep(hook: (ms: number) => void | Promise<void>) {
      onSleep = hook;
    },
    err: [] as string[],
    out: [] as string[],
    async run(args: readonly string[] = ["atlas", TREE, "--config", configPath, "--", NODE, "-e", REPORT, join(dir, "report.json"), "0"]) {
      const code = await runCli(
        ["stack", ...args],
        { stdout: (text) => h.out.push(text), stderr: (text) => h.err.push(text) },
        {
          cwd: work,
          homeDirectory: dir,
          environment: { PATH: process.env.PATH ?? "", OPERATOR_VAR: "kept" },
          question: async () => { throw new Error("stack must not prompt"); },
          defaultVaultCommand: undefined,
          promptSecret: { read: async () => { throw new Error("stack must not read a secret"); } },
          keychain: () => { throw new Error("stack must not open the keychain"); },
          pgtap: {
            now: () => now,
            sleep: async (ms: number) => {
              now += ms;
              await onSleep(ms);
              // A sleep that never yields would starve the child's exit event.
              await delay(1);
            }
          }
        }
      );
      return { code, stdout: h.out.join(""), stderr: h.err.join("") };
    },
    report(): { env: Record<string, string>; cwd: string } {
      return JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { env: Record<string, string>; cwd: string };
    },
    session(): Session {
      const open = store.listJobs().find((job) => job.operation === "session.open");
      if (!open) throw new Error("the command opened no session");
      return store.getSession(String(open.payload.session_id));
    },
    serveJob(): Job | undefined {
      return store.listJobs().find((job) => job.operation === "stack.serve");
    }
  };
  return h;
}
type Harness = ReturnType<typeof harness>;

const served = (patch: Partial<TransitionPatch> = {}): TransitionPatch => ({
  result: { output: { exit_code: 0, stdout: STATUS, stderr: "" }, verification: { db_image: "postgres:17", reason: null } },
  ...patch
});

/**
 * What the runner does, one step per wait of the command: takes the session,
 * settles its stack.serve job, finishes the session when told to close.
 */
function fakeRunner(h: Harness, outcome: { status: "completed" | "failed"; patch: TransitionPatch } = { status: "completed", patch: served() }): () => void {
  const step = () => {
    const open = h.store.listJobs().find((job) => job.operation === "session.open");
    if (!open) return;
    const id = String(open.payload.session_id);
    const session = h.store.getSession(id);
    if (session.status === "queued") {
      h.store.transition(open.id, "granted");
      h.store.transition(open.id, "running");
      h.store.activateSession(id);
      h.store.transition(open.id, "verifying");
      h.store.transition(open.id, "completed");
      return;
    }
    if (session.status === "active") {
      const job = h.store.listSessionJobs(id)[0];
      if (!job) return;
      h.store.transition(job.id, "granted");
      h.store.transition(job.id, "running");
      if (outcome.status === "completed") h.store.transition(job.id, "verifying");
      h.store.transition(job.id, outcome.status, null, outcome.patch);
      return;
    }
    if (session.status === "closing") h.store.finishSession(id, "closed");
  };
  h.onSleep(step);
  return step;
}

describe("stack: environment", () => {
  test("prefixes every KEY=value line of the status, quotes stripped, and ignores the rest", () => {
    expect(stackEnvironment(STATUS)).toEqual({
      SUPADRUM_API_URL: "http://127.0.0.1:56321",
      SUPADRUM_DB_URL: "postgresql://postgres:postgres@127.0.0.1:56322/postgres"
    });
    expect(stackEnvironment("ANON_KEY='a=b'\r\nlower=x\n")).toEqual({ SUPADRUM_ANON_KEY: "a=b" });
  });
});

describe("stack: usage and refusals", () => {
  test.each([
    ["no separator", ["atlas", TREE, "--config", "c.yml"]],
    ["no command after the separator", ["atlas", TREE, "--"]],
    ["no tree", ["atlas", "--", "true"]],
    ["a third positional", ["atlas", TREE, "extra", "--", "true"]],
    ["--config without a path", ["atlas", TREE, "--config", "--", "true"]]
  ])("refuses %s with the usage, before any config is read", async (_case, args) => {
    const h = harness();

    const run = await h.run(args);

    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/^stack: uso: supadrum stack <alias> <tree-oid> \[--config PATH\] -- <command\.\.\.>\n$/);
    expect(h.store.listJobs()).toEqual([]);
  });

  test("refuses a project without the stack capability, even with pgtap", async () => {
    const h = harness({ capabilities: "pgtap" });

    const run = await h.run();

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("non ha la capability stack");
    expect(h.store.listJobs()).toEqual([]);
  });

  test("refuses a dead runner and a short OID before opening a session", async () => {
    const h = harness();
    rmSync(h.pidPath);
    expect((await h.run()).code).toBe(2);
    expect(h.store.listJobs()).toEqual([]);

    const g = harness();
    const run = await g.run(["atlas", "abc123", "--config", g.configPath, "--", "true"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("tree OID non valido");
    expect(g.store.listJobs()).toEqual([]);
  });
});

describe("stack: a served command", () => {
  test("opens a stack session for the tree, serves it, runs the command in the stack's environment and closes", async () => {
    const h = harness();
    fakeRunner(h);

    const run = await h.run(["atlas", TREE, "--config", h.configPath, "--", NODE, "-e", REPORT, join(h.dir, "report.json"), "7"]);

    expect(run.code).toBe(7);
    expect(h.session()).toMatchObject({ project: "atlas", capability: "stack", repo_sha: TREE, ttl_ms: 30_000, status: "closed" });
    expect(h.serveJob()).toMatchObject({ session_id: h.session().id, payload: {}, repo_sha: TREE, status: "completed" });
    const report = h.report();
    expect(report.env).toMatchObject({
      SUPADRUM_API_URL: "http://127.0.0.1:56321",
      SUPADRUM_DB_URL: "postgresql://postgres:postgres@127.0.0.1:56322/postgres",
      OPERATOR_VAR: "kept"
    });
    expect(report.env.API_URL).toBeUndefined();
    expect(report.cwd).toBe(realpathSync(h.work));
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`stack: sessione ${h.session().id}\n`);
    expect(run.stderr).toMatch(new RegExp(`stack: ${NODE.replaceAll("/", "\\/")} .* exit 7 tree ${TREE} db postgres:17 in [0-9.]+ s\\n$`));
  });

  test("keeps the session alive with a heartbeat while the command runs", async () => {
    const h = harness();
    fakeRunner(h);
    const beats: number[] = [];
    const heartbeat = SqliteStore.prototype.heartbeatSession;
    vi.spyOn(SqliteStore.prototype, "heartbeatSession").mockImplementation(function (this: SqliteStore, id: string) {
      beats.push(h.now());
      return heartbeat.call(this, id);
    });
    const child = ["--", NODE, "-e", "setTimeout(() => {}, 150)"];

    const run = await h.run(["atlas", TREE, "--config", h.configPath, ...child]);

    expect(run.code).toBe(0);
    // The first beat is submitSessionJob's own, at the first poll; every one
    // after it is the wait's, 5 s after the one before. The command's store
    // keeps the real clock, so the beats are compared with each other only.
    expect(beats.length).toBeGreaterThanOrEqual(3);
    expect(beats.slice(1).map((at, index) => at - beats[index]!)).toEqual([5250, ...Array<number>(beats.length - 2).fill(5000)]);
    expect(h.session().status).toBe("closed");
  });

  test("keeps the session alive with a heartbeat while the stack starts", async () => {
    const h = harness();
    const runner = fakeRunner(h);
    const t0 = h.now();
    // A start of 12 s: longer than the 5 s heartbeat, shorter than the ceiling.
    h.onSleep(() => { if (!h.serveJob() || h.now() - t0 >= 12_000) runner(); });
    const beats: number[] = [];
    const heartbeat = SqliteStore.prototype.heartbeatSession;
    vi.spyOn(SqliteStore.prototype, "heartbeatSession").mockImplementation(function (this: SqliteStore, id: string) {
      beats.push(h.now());
      return heartbeat.call(this, id);
    });

    const run = await h.run();

    expect(run.code).toBe(0);
    const starting = beats.filter((at) => at - t0 < 12_000);
    expect(starting.length).toBeGreaterThanOrEqual(2);
    expect(starting.slice(1).map((at, index) => at - starting[index]!)).toEqual(Array<number>(starting.length - 1).fill(5000));
  });

  test("goes on when a heartbeat is refused: the command, not the session, decides", async () => {
    const h = harness();
    fakeRunner(h);
    const heartbeat = SqliteStore.prototype.heartbeatSession;
    vi.spyOn(SqliteStore.prototype, "heartbeatSession").mockImplementation(function (this: SqliteStore, id: string) {
      if (h.serveJob()?.status === "completed") throw new Error("Session is not active: gone");
      return heartbeat.call(this, id);
    });

    const run = await h.run(["atlas", TREE, "--config", h.configPath, "--", NODE, "-e", "setTimeout(() => {}, 150)"]);

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("stack: Session is not active: gone");
  });

  test("a signal reaches the command and its exit code is the command's", async () => {
    const h = harness();
    const runner = fakeRunner(h);
    let fired = false;
    h.onSleep((ms) => {
      runner();
      // The 5 s wait is the one beside the running command.
      if (ms === 5000 && !fired) {
        fired = true;
        process.emit("SIGINT", "SIGINT");
      }
    });

    const run = await h.run(["atlas", TREE, "--config", h.configPath, "--", NODE, "-e", WAIT]);

    expect(fired).toBe(true);
    expect(run.code).toBe(130);
    expect(run.stderr).toMatch(/exit 130 tree/);
    expect(h.session().status).toBe("closed");
  });

  test("a signal that lands between the stack's start and the spawn skips the command", async () => {
    const h = harness();
    const runner = fakeRunner(h);
    h.onSleep(() => {
      runner();
      if (h.serveJob()?.status === "completed") process.emit("SIGINT", "SIGINT");
    });

    const run = await h.run();

    expect(run.code).toBe(130);
    expect(run.stderr).toMatch(/interrotto prima del comando/);
    expect(() => h.report()).toThrow(/ENOENT/);
    expect(h.session().status).toBe("closed");
  });

  test("a command that cannot be spawned exits 127 and still closes the session", async () => {
    const h = harness();
    fakeRunner(h);

    const run = await h.run(["atlas", TREE, "--config", h.configPath, "--", join(h.dir, "missing-binary")]);

    expect(run.code).toBe(127);
    expect(run.stderr).toMatch(/missing-binary: .*ENOENT/);
    expect(h.session().status).toBe("closed");
  });
});

describe("stack: the runner's refusals", () => {
  test.each([
    ["start_failed", 4],
    ["tree_invalid", 3],
    ["phase_timeout", 4],
    ["queue_timeout", 5]
  ])("a stack.serve failed with %s exits %i, prints the start output and closes the session", async (reason, code) => {
    const h = harness();
    fakeRunner(h, { status: "failed", patch: { result: { output: { stdout: "pulling\n", stderr: "port taken\n" }, verification: { reason, phase: "start" } }, error: `executor said ${reason}` } });

    const run = await h.run();

    expect(run.code).toBe(code);
    expect(run.stderr).toContain("pulling\nport taken\n");
    expect(run.stderr).toContain(`stack: ${reason} nella fase start: executor said ${reason}`);
    expect(h.session().status).toBe("closed");
  });

  test("a completed stack.serve without a status exits 4", async () => {
    const h = harness();
    fakeRunner(h, { status: "completed", patch: { result: { output: { exit_code: 0 }, verification: {} } } });

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stderr).toMatch(/finito come completed senza lo stato dello stack/);
    expect(h.session().status).toBe("closed");
  });

  test("a session the runner refuses exits 4 with the runner's reason, nothing to close", async () => {
    const h = harness();
    h.onSleep(() => {
      const open = h.store.listJobs().find((job) => job.operation === "session.open")!;
      if (open.status !== "queued") return;
      h.store.transition(open.id, "failed", null, { error: "a stack session requires a live chamber and the command executor" });
    });
    const close = vi.spyOn(SqliteStore.prototype, "requestSessionClose");

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stderr).toContain("non aperta (failed): a stack session requires a live chamber and the command executor");
    expect(close).not.toHaveBeenCalled();
  });
});

describe("stack: waiting", () => {
  test("a session still queued after the queue timeout is closed, and exits 5", async () => {
    const h = harness({ queue: "pgtap:\n  queue_timeout_ms: 10000\n" });

    const run = await h.run();

    expect(run.code).toBe(5);
    expect(run.stderr).toMatch(/scaduto in coda dopo 10 s/);
    expect(h.session().status).toBe("closed");
    expect(h.store.getJob(h.session().open_job_id).status).toBe("cancelled");
    expect(h.now() - T0).toBe(10_000);
  });

  test("a start that outlasts its ceiling exits 5 and closes the session", async () => {
    const h = harness();
    const runner = fakeRunner(h);
    h.onSleep(() => { if (!h.serveJob()) runner(); });

    const run = await h.run();

    expect(run.code).toBe(5);
    expect(run.stderr).toMatch(/attesa esaurita dopo 91 s/);
    expect(h.session().status).toBe("closing");
  });

  test("a runner that dies while the session is queued exits 2 and closes it", async () => {
    const h = harness();
    h.onSleep(() => rmSync(h.pidPath, { force: true }));

    const run = await h.run();

    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/runner spento/);
    expect(h.session().status).toBe("closed");
  });

  test("an interrupt while the session is queued exits 130 and closes it", async () => {
    const h = harness();
    h.onSleep(() => { process.emit("SIGINT", "SIGINT"); });

    const run = await h.run();

    expect(run.code).toBe(130);
    expect(run.stderr).toMatch(/interrotto, sessione .* annullata/);
    expect(h.session().status).toBe("closed");
  });

  test("prints a status line every 5 s while waiting, not more often", async () => {
    const h = harness({ queue: "pgtap:\n  queue_timeout_ms: 12000\n" });

    const run = await h.run();

    expect(run.stderr.match(/stack: in coda/g)?.length ?? 0).toBe(2);
  });

  test("gives up waiting for the close after 90 s, saying so", async () => {
    const h = harness();
    const runner = fakeRunner(h);
    h.onSleep(() => { if (h.session().status !== "closing") runner(); });

    const run = await h.run();

    expect(run.code).toBe(0);
    expect(run.stderr).toMatch(/non ha chiuso la sessione .* entro 90 s/);
    expect(h.session().status).toBe("closing");
  });
});

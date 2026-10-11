import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";

import { runCli } from "../src/cli.js";
import type { Job } from "../src/domain.js";
import { BrokerError } from "../src/errors.js";
import { pgtapReasons, type PgtapReason } from "../src/pgtap-reasons.js";
import { runnerPidPath } from "../src/runner-cli.js";
import { SqliteStore, type TransitionPatch } from "../src/store.js";

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OTHER_TREE = "9f".repeat(20);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Long before any real clock, so a job stamped by the fake clock always sorts
// ahead of the one the command stamps with the real one.
const T0 = Date.parse("2020-01-01T00:00:00.000Z");

/** What the command does after every failure: say why, and how to skip the hook. */
const NO_VERIFY = "git commit --no-verify";

const EXIT_FOR_REASON: Record<PgtapReason, number> = {
  tests_failed: 1,
  tree_invalid: 3,
  tree_incomplete: 3,
  extraction_failed: 3,
  docker_unreachable: 3,
  supabase_cli_missing: 3,
  supabase_cli_too_old: 3,
  no_probe_image: 3,
  space_probe_failed: 3,
  insufficient_space: 3,
  reserved_project_id: 3,
  original_port_left: 3,
  ports_exhausted: 3,
  tests_path_missing: 3,
  cleanup_before_failed: 3,
  start_failed: 4,
  phase_timeout: 4,
  queue_timeout: 5
};

const SHORT_PHASES =
  "    pgtap:\n      tests_path: supabase/tests\n      start_timeout_ms: 1000\n      test_timeout_ms: 2000\n";
const QUEUE_10S = "pgtap:\n  queue_timeout_ms: 10000\n";
// queue 10 s + start 1 s + test 2 s + the runner's fixed 210 s of phase limits.
const SHORT_CEILING_MS = 223_000;

interface ConfigOptions {
  readonly executor?: "command" | "dry-run";
  readonly mode?: "live" | "dry-run";
  readonly capabilities?: string;
  readonly pgtapBlock?: string;
  readonly broker?: string;
  readonly database?: string;
  readonly configRelative?: string;
}

function configYaml(options: ConfigOptions): string {
  return `version: 1
database: ${options.database ?? "queue.sqlite"}
executor: ${options.executor ?? "command"}
${options.broker ?? ""}chambers:
  atlas-local:
    target: local
${options.pgtapBlock ?? "    pgtap:\n      tests_path: supabase/tests\n"}  remote-chamber:
    project_ref: remote-ref-0000000000000
    credentials:
      secret_key: vault://supabase/remote/secret
      management_token: vault://supabase/remote/management
      database_access: vault://supabase/remote/postgres
projects:
  atlas:
    chamber: atlas-local
    capabilities: [${options.capabilities ?? "pgtap"}]
    repo: .
    mode: ${options.mode ?? "live"}
  remote-app:
    chamber: remote-chamber
    mode: dry-run
    capabilities: [project-management]
`;
}

/** A clock only the command's wait moves: each sleep advances it and may act on the store. */
function fakeTime() {
  let now = T0;
  let origin = T0;
  let onSleep: (elapsedMs: number) => void | Promise<void> = () => undefined;
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
    mark: () => {
      origin = now;
    },
    elapsed: () => now - origin,
    onSleep: (hook: (elapsedMs: number) => void | Promise<void>) => {
      onSleep = hook;
    },
    atFirstSleep: (action: () => void) => {
      onSleep = (elapsed) => {
        if (elapsed === 250) action();
      };
    },
    seams: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        await onSleep(now - origin);
      }
    }
  };
}

type Runtime = NonNullable<Parameters<typeof runCli>[2]>;

const stores: SqliteStore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function harness(options: ConfigOptions & { readonly runner?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "supadrum-pgtap-"));
  const configPath = join(dir, options.configRelative ?? "config.yml");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, configYaml(options));
  const databasePath = join(dirname(configPath), options.database ?? "queue.sqlite");
  // Spelled out on purpose: runner and command share runnerPidPath, so the
  // test must not, or a wrong shared answer would satisfy both sides.
  const pidPath = join(dirname(databasePath), "runner.pid");
  const time = fakeTime();
  const store = new SqliteStore(databasePath, time.clock);
  stores.push(store);
  // An empty string is a runner.pid with nothing in it; "absent" writes no file.
  if (options.runner !== "absent") {
    writeFileSync(pidPath, `${options.runner ?? process.pid}\n`);
  }

  const h = {
    dir,
    configPath,
    databasePath,
    pidPath,
    time,
    store,
    out: [] as string[],
    err: [] as string[],
    async run(
      args: readonly string[] = ["atlas", TREE, "--config", configPath],
      runtime: Partial<Runtime> = {},
      fakeSeams = true
    ) {
      h.out = [];
      h.err = [];
      const { out, err } = h;
      time.mark();
      const code = await runCli(
        ["pgtap", ...args],
        { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
        {
          cwd: dir,
          homeDirectory: dir,
          environment: {},
          question: async () => {
            throw new Error("pgtap must not prompt");
          },
          defaultVaultCommand: undefined,
          promptSecret: {
            read: async () => {
              throw new Error("pgtap must not read a secret");
            }
          },
          keychain: () => {
            throw new Error("pgtap must not open the keychain");
          },
          ...(fakeSeams ? { pgtap: time.seams } : {}),
          ...runtime
        }
      );
      return { code, out, err, stdout: out.join(""), stderr: err.join("") };
    }
  };
  return h;
}

type Harness = ReturnType<typeof harness>;

/** The job the command queued for one tree; the last one if it queued several. */
function cliJob(store: SqliteStore, oid = TREE): Job {
  const job = store.listJobs().filter((candidate) => candidate.repo_sha === oid).at(-1);
  if (!job) throw new Error(`the command queued nothing for ${oid}`);
  return job;
}

function start(store: SqliteStore, id: string): void {
  store.transition(id, "granted");
  store.transition(id, "running");
}

/** What the runner does to a job: take it, run it, and write the outcome. */
function settle(
  store: SqliteStore,
  id: string,
  status: "completed" | "failed",
  patch: TransitionPatch
): void {
  start(store, id);
  if (status === "completed") store.transition(id, "verifying");
  store.transition(id, status, null, patch);
}

/** There is no runner in these tests: the first wait of the command is when the job gets its outcome. */
function settleAtFirstSleep(
  h: Harness,
  status: "completed" | "failed",
  patch: TransitionPatch,
  oid = TREE
): void {
  h.time.onSleep(() => settle(h.store, cliJob(h.store, oid).id, status, patch));
}

const finished = (
  exitCode: number | undefined,
  verification: Record<string, unknown> = {}
) => ({
  output: {
    stdout: "ok 1 - a\n1..1",
    stderr: "NOTICE: x\n",
    ...(exitCode === undefined ? {} : { exit_code: exitCode })
  },
  verification: {
    tree_oid: OTHER_TREE,
    db_image: "supabase/postgres:15.8.1.085",
    duration_ms: 12_340,
    ...verification
  }
});

const failedWith = (reason: string, extra: Record<string, unknown> = {}) => ({
  result: { output: {}, verification: { reason, ...extra } },
  error: `executor said ${reason}`
});

function expectRefused(h: Harness, run: { code: number; stdout: string; stderr: string }, cause: RegExp) {
  expect(run.code).toBe(2);
  expect(run.stdout).toBe("");
  expect(run.stderr).toMatch(cause);
  expect(run.stderr).toContain(NO_VERIFY);
  expect(h.store.listJobs()).toEqual([]);
}

describe("pgtap: outcome to exit code", () => {
  test.each(pgtapReasons)("a job failed with %s exits with the code of its class", async (reason) => {
    const h = harness();
    settleAtFirstSleep(h, "failed", failedWith(reason));

    const run = await h.run();

    expect(run.code).toBe(EXIT_FOR_REASON[reason]);
    expect(run.stderr).toContain(reason === "tests_failed" ? "prove fallite" : reason);
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("a phase timeout names the phase and carries the executor's error", async () => {
    const h = harness();
    settleAtFirstSleep(h, "failed", {
      result: { output: {}, verification: { reason: "phase_timeout", phase: "tests" } },
      error: "phase tests exceeded 120000 ms"
    });

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stderr).toContain("phase_timeout nella fase tests: phase tests exceeded 120000 ms");
  });

  test.each([
    ["no result at all", { error: "boom" }],
    ["a result without verification", { result: { output: {} }, error: "boom" }],
    ["a verification without reason", { result: { output: {}, verification: {} }, error: "boom" }],
    ["a reason it does not know", failedWith("something_new")]
  ] as const)("a failed job with %s exits 4", async (_name, patch) => {
    const h = harness();
    settleAtFirstSleep(h, "failed", patch);

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stderr).toContain("senza una reason riconosciuta");
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("a completed job with a failing exit_code exits 1", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", { result: finished(3) });

    const run = await h.run();

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("prove fallite");
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("a completed job with exit_code 0 exits 0 and says nothing on stderr beyond the test's own", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", { result: { output: { exit_code: 0 }, verification: {} } });

    const run = await h.run();

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
  });

  test("a completed job without an exit_code is not a green one", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", { result: finished(undefined) });

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("a job someone else cancelled is not a green one", async () => {
    const h = harness();
    h.time.onSleep(() => {
      h.store.cancel(cliJob(h.store).id);
    });

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stderr).toContain("cancelled");
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("a job whose lease expired is not a green one", async () => {
    const h = harness();
    h.time.onSleep(() => {
      const { id } = cliJob(h.store);
      h.store.transition(id, "granted");
      h.store.transition(id, "lease_expired");
    });

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stderr).toContain("lease_expired");
    expect(run.stderr).toContain(NO_VERIFY);
  });
});

describe("pgtap: what it prints", () => {
  test("prints the job id, the test's output untouched, then the green verdict from the outcome", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", { result: finished(0) });

    const run = await h.run();

    expect(run.code).toBe(0);
    expect(run.out).toEqual([
      `${cliJob(h.store).id}\n`,
      "ok 1 - a\n1..1",
      `pgtap: verde tree ${OTHER_TREE} db supabase/postgres:15.8.1.085 in 12.3 s\n`
    ]);
    expect(run.err).toEqual(["NOTICE: x\n"]);
  });

  test("a failing exit_code prints rosso with that code and never verde", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", { result: finished(7) });

    const run = await h.run();

    expect(run.stdout).toContain(
      `pgtap: rosso (exit 7) tree ${OTHER_TREE} db supabase/postgres:15.8.1.085 in 12.3 s\n`
    );
    expect(run.stdout).not.toContain("verde");
  });

  test("tests_failed prints the output and the red verdict too", async () => {
    const h = harness();
    settleAtFirstSleep(h, "failed", {
      result: finished(1, { reason: "tests_failed" }),
      error: "tests failed"
    });

    const run = await h.run();

    expect(run.code).toBe(1);
    expect(run.out).toContain("ok 1 - a\n1..1");
    expect(run.err).toContain("NOTICE: x\n");
    expect(run.stdout).toContain("pgtap: rosso (exit 1) tree");
  });

  test("a failure that is not tests_failed prints no verdict, whatever exit_code the output has", async () => {
    const h = harness();
    settleAtFirstSleep(h, "failed", { result: finished(0, { reason: "start_failed" }), error: "x" });

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stdout).not.toMatch(/pgtap: (verde|rosso)/);
  });

  test("without tree, image or duration in the outcome it falls back on the argument and the wait", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", { result: { output: { exit_code: 0 }, verification: {} } });

    const run = await h.run();

    expect(run.stdout).toContain(`pgtap: verde tree ${TREE} db ? in 0.3 s\n`);
  });

  test.each([
    ["completed", { result: finished(0, { cleanup_residue: "container db_1\nvolume db_1" }) }, 0],
    [
      "failed",
      {
        result: finished(undefined, { reason: "start_failed", cleanup_residue: "container db_1\nvolume db_1" }),
        error: "x"
      },
      4
    ]
  ] as const)("a %s job with a residue prints one line for it", async (status, patch, code) => {
    const h = harness();
    settleAtFirstSleep(h, status, patch);

    const run = await h.run();

    expect(run.code).toBe(code);
    expect(run.stderr).toContain("pgtap: residuo dopo la pulizia: container db_1; volume db_1\n");
  });

  test.each([["absent", {}], ["empty", { cleanup_residue: "" }]])("a %s residue prints no line", async (_name, extra) => {
    const h = harness();
    settleAtFirstSleep(h, "completed", { result: finished(0, extra) });

    const run = await h.run();

    expect(run.stderr).not.toContain("residuo");
  });
});

describe("pgtap: refusals before queuing", () => {
  test("refuses when runner.pid is missing", async () => {
    const h = harness({ runner: "absent" });

    expectRefused(h, await h.run(), /runner non gira/);
  });

  test("refuses when the pid in runner.pid is dead", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const h = harness({ runner: String(dead) });

    expectRefused(h, await h.run(), /runner non gira/);
  });

  // pid 0 would signal the caller's own process group and always "succeed".
  test.each(["0", "abc", ""])("refuses a runner.pid that holds %j", async (content) => {
    const h = harness({ runner: content });

    expectRefused(h, await h.run(), /runner non gira/);
  });

  // A runner owned by another user answers EPERM to signal 0, and is alive.
  test("counts a runner it may not signal as alive", async () => {
    const h = harness({ runner: "1" });
    settleAtFirstSleep(h, "completed", { result: finished(0) });

    expect((await h.run()).code).toBe(0);
  });

  test("looks for runner.pid beside the database, not beside the config", async () => {
    const h = harness({ database: "data/queue.sqlite", runner: "absent" });
    writeFileSync(join(h.dir, "runner.pid"), `${process.pid}\n`);

    expectRefused(h, await h.run(), /runner non gira/);

    writeFileSync(h.pidPath, `${process.pid}\n`);
    settleAtFirstSleep(h, "completed", { result: finished(0) });
    expect((await h.run()).code).toBe(0);
  });

  test("refuses an alias the config does not know", async () => {
    const h = harness();

    expectRefused(h, await h.run(["nope", TREE, "--config", h.configPath]), /progetto sconosciuto: nope/);
  });

  test("refuses a project that is not local", async () => {
    const h = harness();

    expectRefused(h, await h.run(["remote-app", TREE, "--config", h.configPath]), /remote-app non è local/);
  });

  test("refuses a project without the pgtap capability", async () => {
    const h = harness({ capabilities: "sql" });

    expectRefused(h, await h.run(), /capability pgtap/);
  });

  test("refuses a project whose chamber has no pgtap block", async () => {
    const h = harness({ pgtapBlock: "" });

    expectRefused(h, await h.run(), /has no pgtap block/);
  });

  test("refuses a project in dry-run mode", async () => {
    const h = harness({ mode: "dry-run" });

    expectRefused(h, await h.run(), /mode dry-run, serve live/);
  });

  test("refuses a config whose executor is dry-run", async () => {
    const h = harness({ executor: "dry-run", mode: "live" });

    expectRefused(h, await h.run(), /executor dry-run nella config, serve command/);
  });

  test.each([
    ["a prefix", TREE.slice(0, 7)],
    ["a branch", "main"],
    ["HEAD", "HEAD"],
    ["39 digits", TREE.slice(1)],
    ["41 digits", `${TREE}0`],
    ["63 digits", "a".repeat(63)],
    ["a non-hex digit", "g".repeat(40)]
  ])("refuses %s as the tree", async (_name, oid) => {
    const h = harness();

    expectRefused(h, await h.run(["atlas", oid, "--config", h.configPath]), /tree OID non valido/);
  });

  test("accepts a 64-digit tree", async () => {
    const h = harness();
    const oid = "e".repeat(64);
    settleAtFirstSleep(h, "completed", { result: finished(0) }, oid);

    const run = await h.run(["atlas", oid, "--config", h.configPath]);

    expect(run.code).toBe(0);
    expect(cliJob(h.store, oid).repo_sha).toBe(oid);
  });

  test.each([
    ["no arguments", []],
    ["no tree", ["atlas"]],
    ["an extra argument", ["atlas", TREE, "extra"]],
    ["--config without a path", ["atlas", TREE, "--config"]]
  ])("refuses %s with the usage", async (_name, args) => {
    const h = harness();

    expectRefused(h, await h.run(args), /uso: supadrum pgtap <alias> <tree-oid> \[--config PATH\]/);
  });

  test("refuses with the reason when the config file is missing", async () => {
    const h = harness();

    expectRefused(h, await h.run(["atlas", TREE, "--config", join(h.dir, "absent.yml")]), /absent\.yml/);
  });

  test("refuses, without throwing, when the queue cannot be opened", async () => {
    const h = harness();
    h.store.close();
    rmSync(h.databasePath, { force: true });
    mkdirSync(h.databasePath);

    const run = await h.run();

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("is exit 2 for the real process too", () => {
    const h = harness({ runner: "absent" });
    const tsxLoader = join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");

    const run = spawnSync(
      process.execPath,
      ["--import", tsxLoader, join(process.cwd(), "src", "cli.ts"), "pgtap", "atlas", TREE, "--config", h.configPath],
      { encoding: "utf8" }
    );

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(NO_VERIFY);
  }, 30_000);
});

describe("pgtap: which config it reads", () => {
  const green = { result: finished(0) };

  test("SUPADRUM_CONFIG when --config is absent", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", green);

    const run = await h.run(["atlas", TREE], { environment: { SUPADRUM_CONFIG: h.configPath } });

    expect(run.code).toBe(0);
  });

  test("--config before SUPADRUM_CONFIG", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", green);

    const run = await h.run(["atlas", TREE, "--config", h.configPath], {
      environment: { SUPADRUM_CONFIG: join(h.dir, "missing.yml") }
    });

    expect(run.code).toBe(0);
  });

  test("a relative --config is taken from the working directory", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", green);

    const run = await h.run(["atlas", TREE, "--config", "config.yml"]);

    expect(run.code).toBe(0);
  });

  test("~/.config/supadrum/config.yml by default", async () => {
    const h = harness({ configRelative: ".config/supadrum/config.yml" });
    settleAtFirstSleep(h, "completed", green);

    const run = await h.run(["atlas", TREE]);

    expect(run.code).toBe(0);
  });

  test("$XDG_CONFIG_HOME/supadrum/config.yml when it is set", async () => {
    const h = harness({ configRelative: "xdg/supadrum/config.yml" });
    settleAtFirstSleep(h, "completed", green);

    const run = await h.run(["atlas", TREE], { environment: { XDG_CONFIG_HOME: join(h.dir, "xdg") } });

    expect(run.code).toBe(0);
  });

  test("never a supadrum.yml in the working directory", async () => {
    const h = harness({ configRelative: ".config/supadrum/config.yml" });
    const work = join(h.dir, "work");
    mkdirSync(work);
    writeFileSync(join(work, "supadrum.yml"), configYaml({ database: "decoy.sqlite" }));
    settleAtFirstSleep(h, "completed", green);

    const run = await h.run(["atlas", TREE], { cwd: work });

    expect(run.code).toBe(0);
  });
});

describe("pgtap: queuing", () => {
  test("prints the job id before the first wait, even if the job never ends", async () => {
    const h = harness();
    let printedBeforeWaiting: string | undefined;
    h.time.onSleep(() => {
      printedBeforeWaiting ??= h.out.join("");
      process.emit("SIGINT");
    });

    await h.run();

    expect(printedBeforeWaiting).toBe(`${cliJob(h.store).id}\n`);
  });

  test("queues a pgtap.run for the tree with an empty payload and no hand-made key", async () => {
    const h = harness();
    settleAtFirstSleep(h, "completed", { result: finished(0) });

    await h.run();

    expect(cliJob(h.store)).toMatchObject({
      project: "atlas",
      operation: "pgtap.run",
      capability: "pgtap",
      repo_sha: TREE
    });
    expect(cliJob(h.store).payload).toEqual({});
    expect(cliJob(h.store).idempotency_key).toMatch(UUID);
  });

  test("two runs on the same tree are two jobs with different keys", async () => {
    const h = harness();
    for (let run = 0; run < 2; run++) {
      settleAtFirstSleep(h, "completed", { result: finished(0) });
      expect((await h.run()).code).toBe(0);
    }

    const jobs = h.store.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.id).not.toBe(jobs[1]?.id);
    expect(jobs[0]?.idempotency_key).not.toBe(jobs[1]?.idempotency_key);
    expect(jobs.map((job) => job.idempotency_key)).toSatisfy((keys: string[]) =>
      keys.every((key) => UUID.test(key))
    );
  });

  test("waits on the real clock until the runner settles the job", async () => {
    const h = harness();
    const running = h.run(undefined, {}, false);
    for (let tries = 0; tries < 100 && h.store.listJobs().length === 0; tries++) await delay(20);
    await delay(600);
    settle(h.store, cliJob(h.store).id, "completed", {
      result: { output: finished(0).output, verification: {} }
    });

    const run = await running;

    expect(run.code).toBe(0);
    // No duration in the outcome: the verdict says what the wait measured, and a frozen clock would say 0.0.
    expect(Number(/ in (\d+\.\d) s\n/.exec(run.stdout)?.[1])).toBeGreaterThanOrEqual(0.5);
  });

  test.each([
    ["settles", (h: Harness) => settleAtFirstSleep(h, "completed", { result: finished(0) })],
    [
      "breaks",
      (h: Harness) =>
        h.time.onSleep(() => {
          throw new Error("disk exploded");
        })
    ]
  ])("closes its connection to the queue when the wait %s", async (_name, arrange) => {
    const h = harness();
    const close = vi.spyOn(SqliteStore.prototype, "close");
    arrange(h);

    await h.run();

    expect(close).toHaveBeenCalledTimes(1);
  });

  test("an unexpected error while waiting leaves the job in the store and exits 4", async () => {
    const h = harness();
    h.time.onSleep(() => {
      throw new Error("disk exploded");
    });

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stdout).toBe(`${cliJob(h.store).id}\n`);
    expect(run.stderr).toContain(cliJob(h.store).id);
    expect(run.stderr).toContain("disk exploded");
    expect(run.stderr).toContain(NO_VERIFY);
    expect(cliJob(h.store).status).toBe("queued");
  });
});

describe("pgtap: waiting", () => {
  test("a runner that stops during the wait ends it at once and cancels the queued job", async () => {
    const h = harness();
    h.time.onSleep(() => rmSync(h.pidPath));

    const run = await h.run();

    expect(run.code).toBe(2);
    expect(h.time.elapsed()).toBeLessThan(1_000);
    expect(cliJob(h.store).status).toBe("cancelled");
    expect(run.stderr).toMatch(/runner spento/);
    expect(run.stderr).toContain(cliJob(h.store).id);
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("a runner that dies mid-run leaves the started job alone", async () => {
    const h = harness();
    const cancel = vi.spyOn(SqliteStore.prototype, "cancel");
    h.time.onSleep(() => {
      start(h.store, cliJob(h.store).id);
      rmSync(h.pidPath);
    });

    const run = await h.run();

    expect(run.code).toBe(2);
    expect(cancel).not.toHaveBeenCalled();
    expect(cliJob(h.store).status).toBe("running");
    expect(run.stderr).toMatch(/già partito/);
  });

  test("a cancel that loses the race to the runner leaves the started job alone", async () => {
    const h = harness();
    vi.spyOn(SqliteStore.prototype, "cancel").mockImplementation(() => {
      throw new BrokerError("job_state_conflict", "Running jobs cannot be cancelled atomically");
    });
    h.time.onSleep(() => {
      process.emit("SIGINT");
    });

    const run = await h.run();

    expect(run.code).toBe(130);
    expect(run.stderr).toContain("continua, finisce entro i tetti");
  });

  describe("when the runner fails the job in the instant between the read and the cancel", () => {
    const failsJobBeforeCancel = () => {
      const cancel = SqliteStore.prototype.cancel;
      vi.spyOn(SqliteStore.prototype, "cancel").mockImplementation(function (
        this: SqliteStore,
        id: string
      ) {
        settle(this, id, "failed", failedWith("tests_failed"));
        return cancel.call(this, id);
      });
    };

    test("the queue timeout does not claim the job was cancelled: its own outcome decides", async () => {
      const h = harness({ broker: QUEUE_10S });
      failsJobBeforeCancel();

      const run = await h.run();

      expect(run.code).toBe(1);
      expect(run.stderr).not.toMatch(/scaduto in coda/);
    });

    test("a runner that stops does not claim the job was cancelled", async () => {
      const h = harness();
      failsJobBeforeCancel();
      h.time.onSleep(() => rmSync(h.pidPath));

      const run = await h.run();

      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/già partito/);
      expect(run.stderr).not.toMatch(/annullato/);
    });

    test("an interrupt does not claim the job was cancelled", async () => {
      const h = harness();
      failsJobBeforeCancel();
      h.time.onSleep(() => {
        process.emit("SIGINT");
      });

      const run = await h.run();

      expect(run.code).toBe(130);
      expect(run.stderr).toContain("continua, finisce entro i tetti");
      expect(run.stderr).not.toMatch(/annullato/);
    });
  });

  test("a cancel that fails for any other reason is an unexpected error", async () => {
    const h = harness();
    vi.spyOn(SqliteStore.prototype, "cancel").mockImplementation(() => {
      throw new Error("database is locked");
    });
    h.time.onSleep(() => {
      process.emit("SIGINT");
    });

    const run = await h.run();

    expect(run.code).toBe(4);
    expect(run.stderr).toContain("database is locked");
    expect(run.stderr).toContain(cliJob(h.store).id);
  });

  test("a job still queued after the queue timeout is cancelled, and exits 5", async () => {
    const h = harness({ broker: QUEUE_10S });
    let statusJustBefore: string | undefined;
    h.time.onSleep((elapsed) => {
      if (elapsed === 9_750) statusJustBefore = h.store.getJob(cliJob(h.store).id).status;
    });

    const run = await h.run();

    expect(statusJustBefore).toBe("queued");
    expect(run.code).toBe(5);
    expect(h.time.elapsed()).toBe(10_000);
    expect(cliJob(h.store).status).toBe("cancelled");
    expect(run.stderr).toMatch(/scaduto in coda/);
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("a job that waits for credentials or approval is a queued job too", async () => {
    const h = harness({ broker: QUEUE_10S });
    h.time.atFirstSleep(() => {
      h.store.transition(cliJob(h.store).id, "waiting_credentials", { missing: ["deploy_token"] });
    });

    const run = await h.run();

    expect(run.code).toBe(5);
    expect(cliJob(h.store).status).toBe("cancelled");
  });

  test("a job already granted is not cancelled by the queue timeout", async () => {
    const h = harness({ broker: QUEUE_10S, pgtapBlock: SHORT_PHASES });
    const cancel = vi.spyOn(SqliteStore.prototype, "cancel");
    h.time.atFirstSleep(() => {
      h.store.transition(cliJob(h.store).id, "granted");
    });

    const run = await h.run();

    expect(run.code).toBe(5);
    expect(h.time.elapsed()).toBe(SHORT_CEILING_MS);
    expect(cancel).not.toHaveBeenCalled();
    expect(cliJob(h.store).status).toBe("granted");
  });

  test.each([
    ["the configured limits", { broker: QUEUE_10S, pgtapBlock: SHORT_PHASES }, SHORT_CEILING_MS],
    ["the default limits", {}, 750_000]
  ])("gives up on a running job at the ceiling of %s, leaving it as it is", async (_name, options, ceiling) => {
    const h = harness(options);
    const cancel = vi.spyOn(SqliteStore.prototype, "cancel");
    h.time.atFirstSleep(() => start(h.store, cliJob(h.store).id));

    const run = await h.run();

    expect(run.code).toBe(5);
    expect(h.time.elapsed()).toBe(ceiling);
    expect(cancel).not.toHaveBeenCalled();
    expect(cliJob(h.store).status).toBe("running");
    expect(run.stdout).toBe(`${cliJob(h.store).id}\n`);
    expect(run.stderr).toMatch(/attesa esaurita/);
    expect(run.stderr).toContain(cliJob(h.store).id);
    expect(run.stderr).toContain(NO_VERIFY);
  });

  describe("every five seconds it says what it waits for", () => {
    /** The stderr seen at each sleep, keyed by the milliseconds since the wait began. */
    function watch(h: Harness, until: number, before?: () => void) {
      const seen = new Map<number, string>();
      h.time.onSleep((elapsed) => {
        if (elapsed === 250) before?.();
        seen.set(elapsed, h.err.join(""));
        if (elapsed === until) process.emit("SIGINT");
      });
      return seen;
    }

    test("the job that holds the runner, and for how long it has", async () => {
      const h = harness();
      const busy = h.store.submit({
        project: "atlas",
        operation: "pgtap.run",
        payload: {},
        repo_sha: OTHER_TREE,
        idempotency_key: "busy"
      });
      h.time.advance(3_000);
      start(h.store, busy.id);
      const seen = watch(h, 10_250);

      await h.run();

      expect(seen.get(5_000)).not.toContain("occupato");
      expect(seen.get(5_250)).toBe(`pgtap: occupato da ${busy.id} da 5 s\n`);
      expect(seen.get(10_250)).toBe(
        `pgtap: occupato da ${busy.id} da 5 s\npgtap: occupato da ${busy.id} da 10 s\n`
      );
    });

    test("the session that holds it, until when", async () => {
      const h = harness();
      const session = h.store.openSession({
        project: "atlas",
        capability: "pgtap",
        repo_sha: OTHER_TREE,
        idempotency_key: "session",
        ttl_ms: 60_000
      });
      const active = h.store.activateSession(session.id);
      const seen = watch(h, 5_250);

      await h.run();

      expect(active.expires_at).toBe("2020-01-01T00:01:00.000Z");
      expect(seen.get(5_250)).toBe("pgtap: bloccato da sessione fino a 2020-01-01T00:01:00.000Z\n");
    });

    test("the place in the queue", async () => {
      const h = harness();
      h.store.submit({
        project: "atlas",
        operation: "pgtap.run",
        payload: {},
        repo_sha: OTHER_TREE,
        idempotency_key: "ahead"
      });
      const seen = watch(h, 5_250);

      await h.run();

      expect(seen.get(5_250)).toBe("pgtap: in coda (posizione 2)\n");
    });

    test("the job running, in which phase", async () => {
      const h = harness();
      const seen = watch(h, 5_250, () => start(h.store, cliJob(h.store).id));

      await h.run();

      expect(seen.get(5_250)).toBe("pgtap: in esecuzione, fase running\n");
    });
  });
});

describe.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("pgtap: %s", (signal) => {
  test("cancels a queued job and exits 130", async () => {
    const h = harness();
    h.time.onSleep(() => {
      process.emit(signal);
    });

    const run = await h.run();

    expect(run.code).toBe(130);
    expect(cliJob(h.store).status).toBe("cancelled");
    expect(run.stderr).toContain(`job ${cliJob(h.store).id} annullato`);
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("cancels a granted job and exits 130", async () => {
    const h = harness();
    h.time.onSleep(() => {
      h.store.transition(cliJob(h.store).id, "granted");
      process.emit(signal);
    });

    const run = await h.run();

    expect(run.code).toBe(130);
    expect(cliJob(h.store).status).toBe("cancelled");
  });

  test("leaves a started job running, says so, and exits 130", async () => {
    const h = harness();
    const cancel = vi.spyOn(SqliteStore.prototype, "cancel");
    h.time.onSleep(() => {
      start(h.store, cliJob(h.store).id);
      process.emit(signal);
    });

    const run = await h.run();

    expect(run.code).toBe(130);
    expect(cancel).not.toHaveBeenCalled();
    expect(cliJob(h.store).status).toBe("running");
    expect(run.stderr).toContain(
      `il job ${cliJob(h.store).id} continua, finisce entro i tetti, il runner ripulisce`
    );
    expect(run.stderr).toContain(NO_VERIFY);
  });

  test("is listened to while it waits and let go of after", async () => {
    const before = process.listenerCount(signal);
    const h = harness();
    let during = 0;
    h.time.onSleep(() => {
      during = process.listenerCount(signal);
      settle(h.store, cliJob(h.store).id, "completed", { result: finished(0) });
    });

    await h.run();

    expect(during).toBe(before + 1);
    expect(process.listenerCount(signal)).toBe(before);
  });
});

describe("pgtap: wiring", () => {
  test("runnerPidPath puts runner.pid beside the database", () => {
    expect(runnerPidPath("/var/lib/supadrum/queue.sqlite")).toBe("/var/lib/supadrum/runner.pid");
  });

  test("the help lists the command", async () => {
    const out: string[] = [];

    await runCli(["--help"], { stdout: (text) => out.push(text), stderr: () => undefined });

    expect(out.join("")).toContain("supadrum pgtap <alias> <tree-oid> [--config PATH]");
  });
});

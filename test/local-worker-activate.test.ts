import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadConfig, type ProjectConfig } from "../src/config.js";
import { JobSubmissionSchema, type Job } from "../src/domain.js";
import { operationCatalog } from "../src/catalog.js";
import { LiveSupabaseExecutor, type LiveProcess } from "../src/live-executor.js";
import {
  activateLocalWorkerSql, LOCAL_WORKER_SCHEDULE_MAX_BYTES, scheduleLocalWorkersSql, stopLocalWorkerSql, verifyLocalWorkersSql
} from "../src/local-worker-activation.js";

const secret = "local-fixture-jwt-secret-32-characters";
const anon = (() => {
  const head = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ role: "anon", exp: 4102444800 })).toString("base64url");
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
})();
const status = { "API URL": "http://127.0.0.1:54341", "DB URL": "postgresql://x:p@127.0.0.1:54342/postgres",
  "anon key": anon, "JWT secret": secret };
const oid = "a".repeat(40);
const credentials = { secret_key: "", management_token: "", database_access: "" };
const loopbackNetwork = JSON.stringify([{ Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } }]);
const SCRIPT = "select cron.schedule('sampleapp-posta', '* * * * *', 'select 1');";

type Answer = { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean } | undefined;
const workers = { schedule_sql: ["supabase/ops/schedule.sql"], autostart: false };

/** Runs an operation against a scripted process; every command is recorded with the stdin it was fed. */
function harness(answer: (argv: readonly string[], stdin?: string) => Answer = () => undefined,
  options: { runtime?: Record<string, unknown>; capabilities?: string[]; fetch?: () => Promise<Response>; resolve?: () => Promise<string>; mode?: string } = {}) {
  const calls: { argv: string; stdin?: string }[] = [];
  const process: LiveProcess = { async run(input) {
    calls.push({ argv: input.argv.join(" "), ...(input.stdin === undefined ? {} : { stdin: input.stdin }) });
    const override = answer(input.argv, input.stdin);
    if (override) return { stdout: "", stderr: "", ...override };
    if (input.argv[0] === "git" && input.argv[3] === "show") return { exitCode: 0, stdout: SCRIPT, stderr: "" };
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${oid}\n${oid}\n`, stderr: "" };
    if (input.argv[0] === "supabase" && input.argv[1] === "status") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "docker") return { exitCode: 0, stdout: loopbackNetwork, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const project = { target: "local", repo: "/fixture", chamber: "local", project_ref: "", credentials,
    capabilities: options.capabilities ?? ["edge-functions", "secrets"], mode: options.mode ?? "live", migrations: "owner", migration_driver: "supabase",
    local_functions: { probe: { identity: "anon" } }, local_worker_jobs: ["sampleapp-posta"],
    local_runtime: { secrets: ["CRON_SECRET"], probe: "probe", workers, ...options.runtime },
    managed_secrets: { CRON_SECRET: "vault://fixture/cron" } } as unknown as ProjectConfig;
  const executor = new LiveSupabaseExecutor({ process, resolveReference: options.resolve ?? (async () => "fixture-secret"),
    fetch: options.fetch ?? (async () => new Response("ok")) });
  const run = (operation: string, payload: Record<string, unknown> = {}) => executor.execute(
    { id: "job", project: "app", operation, payload, repo_sha: oid, capability: "edge-functions", status: "running" } as unknown as Job,
    project, credentials);
  /** The SQL each psql session was fed, in order. */
  const sessions = () => calls.filter(call => call.argv.startsWith("psql")).map(call => call.stdin ?? "");
  return { calls, run, sessions };
}
const isStop = (sql: string) => sql === stopLocalWorkerSql(["sampleapp-posta"]);
/** The rejection of a promise that must reject. */
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as Error);

test("workers are stopped, scheduled from the pinned commit, verified, then activated, in that order", async () => {
  const h = harness();
  const result = await h.run("functions.workers.activate");
  const [stop, schedule, verify, activate] = h.sessions();
  expect(h.sessions()).toHaveLength(4);
  expect(isStop(stop!)).toBe(true);
  expect(schedule).toBe(`${SCRIPT}\n${stopLocalWorkerSql(["sampleapp-posta"])}`);
  expect(verify).toBe(verifyLocalWorkersSql(["sampleapp-posta"]));
  expect(activate).toBe(activateLocalWorkerSql(["sampleapp-posta"]));
  expect(h.calls.find(call => call.argv.includes(" show "))?.argv).toBe(`git -C /fixture show ${oid}:supabase/ops/schedule.sql`);
  expect(result.output).toEqual({ workers_active: true, jobs: 1 });
});

test("the schedule script is fed together with the stop, so its active jobs are stopped in the same session", async () => {
  const h = harness();
  await h.run("functions.workers.activate");
  const schedule = h.sessions()[1]!;
  expect(schedule.indexOf(SCRIPT)).toBeGreaterThanOrEqual(0);
  expect(schedule.indexOf("active := false")).toBeGreaterThan(schedule.indexOf(SCRIPT));
});

test.each([
  ["schedule", 1, "Local worker schedule failed"],
  ["verification", 2, "Local worker verification failed"],
  ["activation", 3, "Local worker activation failed"]
])("a failed %s leaves the workers stopped and never reaches the next step", async (_label, failing, message) => {
  let session = -1;
  const h = harness(argv => argv[0] === "psql" && ++session === failing
    ? { exitCode: 1, stderr: "relation leaked-canary does not exist" } : undefined);
  const error = await failure(h.run("functions.workers.activate"));
  expect(error.message).toBe(message);
  expect(error.message).not.toContain("leaked-canary");
  const sessions = h.sessions();
  expect(isStop(sessions.at(-1)!)).toBe(true);
  expect(sessions.some(sql => sql === activateLocalWorkerSql(["sampleapp-posta"]))).toBe(failing === 3);
  if (failing < 2) expect(sessions.some(sql => sql === verifyLocalWorkersSql(["sampleapp-posta"]))).toBe(false);
});

test("a failing runtime probe stops before anything is scheduled", async () => {
  const h = harness(() => undefined, { fetch: async () => new Response("down", { status: 500 }) });
  await expect(h.run("functions.workers.activate")).rejects.toThrow("Local function returned HTTP 500");
  expect(h.calls.some(call => call.argv.includes(" show "))).toBe(false);
  expect(h.sessions().every(isStop)).toBe(true);
  expect(h.sessions()).toHaveLength(2);
});

test("a schedule script that carries a psql command is refused and nothing is scheduled", async () => {
  for (const script of ["\\! touch /tmp/x", "select 1;\n  \\copy t from '/etc/passwd'", "select 1; \\! touch /tmp/x", "select 1; \\\\! touch /tmp/x"]) {
    const h = harness(argv => argv[0] === "git" && argv[3] === "show" ? { exitCode: 0, stdout: script } : undefined);
    await expect(h.run("functions.workers.activate")).rejects.toThrow("Local worker schedule script is not acceptable");
    expect(h.sessions().every(isStop)).toBe(true);
  }
});

test("a script that is not in the pinned commit is not read from the working tree", async () => {
  const h = harness(argv => argv[0] === "git" && argv[3] === "show" ? { exitCode: 128, stderr: "fatal: path leaked-canary" } : undefined);
  const error = await failure(h.run("functions.workers.activate"));
  expect(error.message).toBe("Local worker schedule script is not in the pinned commit");
  expect(h.sessions().every(isStop)).toBe(true);
});

test("an unregistered or unreadable schedule never runs, whatever the capabilities say", async () => {
  await expect(harness(() => undefined, { runtime: { workers: undefined } }).run("functions.workers.activate"))
    .rejects.toThrow("Local worker activation requires");
  await expect(harness(() => undefined, { capabilities: ["edge-functions"] }).run("functions.workers.activate"))
    .rejects.toThrow("Local worker activation requires");
  await expect(harness(() => undefined, { capabilities: ["secrets"] }).run("functions.workers.activate"))
    .rejects.toThrow("Local worker activation requires");
  await expect(harness(() => undefined, { mode: "dry-run" }).run("functions.workers.activate")).rejects.toThrow("Local worker activation requires");
  const h = harness();
  await expect(h.run("functions.workers.activate", { names: ["other"] })).rejects.toThrow("Local worker activation requires");
  expect(h.sessions()).toHaveLength(0);
});

test("a schedule path outside the repository is refused before git is asked", async () => {
  const h = harness(() => undefined, { runtime: { workers: { ...workers, schedule_sql: ["../outside.sql"] } } });
  await expect(h.run("functions.workers.activate")).rejects.toThrow("Worker schedule script must be inside the project repository");
  expect(h.calls.some(call => call.argv.includes(" show "))).toBe(false);
  expect(h.sessions().every(isStop)).toBe(true);
});

test("a secret that cannot be resolved stops the activation before the runtime is touched", async () => {
  const h = harness(() => undefined, { resolve: async () => { throw new Error("vault leaked-canary"); } });
  const error = await failure(h.run("functions.workers.activate"));
  expect(error.message).not.toContain("leaked-canary");
  expect(h.calls.some(call => call.argv.includes(" show "))).toBe(false);
  expect(h.sessions().every(isStop)).toBe(true);
});

test("a psql session that times out counts as failed", async () => {
  let session = -1;
  const h = harness(argv => argv[0] === "psql" && ++session === 2 ? { exitCode: 0, timedOut: true } : undefined);
  const error = await failure(h.run("functions.workers.activate"));
  expect(error.message).toBe("Local worker verification failed");
  expect(h.sessions().some(sql => sql === activateLocalWorkerSql(["sampleapp-posta"]))).toBe(false);
});

test("starting real workers needs an approval", () => {
  expect(operationCatalog["functions.workers.activate"]).toEqual({ capability: "edge-functions", approval: true });
});

test("the registered names are the only jobs the SQL can name", () => {
  expect(() => scheduleLocalWorkersSql([SCRIPT], ["x'; drop table t; --"])).toThrow("Local worker jobs are not registered");
  expect(() => verifyLocalWorkersSql([])).toThrow("Local worker jobs are not registered");
  expect(() => activateLocalWorkerSql(["a", "a"])).toThrow("Local worker jobs are not registered");
  expect(verifyLocalWorkersSql(["a", "b"]).match(/<> 2/g)).toHaveLength(2);
  expect(activateLocalWorkerSql(["a", "b"]).match(/<> 2/g)).toHaveLength(1);
  expect(() => scheduleLocalWorkersSql([], ["a"])).toThrow("Local worker schedule script is not acceptable");
});

// The SQL's behaviour is proven on a disposable stack (tools/local-edge-runtime-probe.ts); these pin what it says.
test("verification refuses a job that is already running, activation enables only the registered jobs", () => {
  const verify = verifyLocalWorkersSql(["a", "b"]);
  expect(verify).toContain("jobname in ('a','b') and active");
  expect(verify).toContain("Local worker jobs are already active");
  const activate = activateLocalWorkerSql(["a", "b"]);
  expect(activate).toContain("jobname in ('a','b')");
  expect(activate).toContain("active := true");
  expect(activate).not.toContain("active := false");
  expect(stopLocalWorkerSql(["a", "b"])).toContain("active := false");
});

test.each([
  ["a psql command at the start of a line", "select 1;\n\\i /etc/hosts"],
  ["an indented psql command", "select 1;\n   \\gexec"],
  ["a psql command after a statement on the same line", "select 1; \\! touch /tmp/x"],
  ["a psql command after a statement, no space", "select 1;\\gexec"],
  ["a backslash in a comment", "-- \\! touch /tmp/x\nselect 1;"],
  ["an empty script", "  \n"],
  ["an oversized script", `select '${"x".repeat(LOCAL_WORKER_SCHEDULE_MAX_BYTES)}';`]
])("%s is not a schedule script", (_label, script) => {
  expect(() => scheduleLocalWorkersSql([script], ["a"])).toThrow("Local worker schedule script is not acceptable");
  expect(() => scheduleLocalWorkersSql([SCRIPT, script], ["a"])).toThrow("Local worker schedule script is not acceptable");
});

// Refusing is the point: telling a string from a command needs the server's lexer, which the broker does not have.
test("a backslash inside a string is refused too, and a script without one is passed through untouched", () => {
  expect(() => scheduleLocalWorkersSql(["select 'a\\b', E'\\n';"], ["a"])).toThrow("Local worker schedule script is not acceptable");
  expect(scheduleLocalWorkersSql(["select 'a/b', 1;\n"], ["a"])).toBe(`select 'a/b', 1;\n${stopLocalWorkerSql(["a"])}`);
});

test("the activation is an operation of its own, with an empty payload", () => {
  const submit = (payload: Record<string, unknown>) => JobSubmissionSchema.safeParse({
    project: "app", operation: "functions.workers.activate", repo_sha: "abcdef0", idempotency_key: "k", payload });
  expect(submit({}).success).toBe(true);
  expect(submit({ names: ["other"] }).success).toBe(false);
  expect(submit({ sql: "select 1" }).success).toBe(false);
});

const runtimeFixture = (workersBlock: string, jobs = "    local_worker_jobs: [sampleapp-posta]\n") => {
  const file = join(mkdtempSync(join(tmpdir(), "supadrum-local-workers-")), "config.yml");
  writeFileSync(file, `version: 1
database: queue.sqlite
executor: command
approval_mode: automatic
chambers:
  local:
    target: local
    managed_secrets:
      CRON_SECRET: vault://fixture/local/cron
${jobs}    local_runtime:
      secrets: [CRON_SECRET]
      probe: probe
${workersBlock}    local_functions:
      probe: { identity: anon }
projects:
  app:
    chamber: local
    repo: /fixture
    mode: live
    capabilities: [edge-functions, secrets]
`);
  return file;
};

test("workers need registered job names, and a schedule that stays inside the repository", () => {
  const ok = loadConfig(runtimeFixture("      workers:\n        schedule_sql: [supabase/ops/schedule.sql]\n"));
  expect(ok.projects.app?.local_runtime?.workers).toEqual({ schedule_sql: ["supabase/ops/schedule.sql"], autostart: false });
  const auto = loadConfig(runtimeFixture("      workers:\n        schedule_sql: [supabase/ops/schedule.sql]\n        autostart: true\n"));
  expect(auto.projects.app?.local_runtime?.workers?.autostart).toBe(true);
  expect(() => loadConfig(runtimeFixture("      workers:\n        schedule_sql: [supabase/ops/schedule.sql]\n", "")))
    .toThrow(/workers need local_worker_jobs/);
  for (const bad of ["[]", "[../outside.sql]", "[/etc/passwd]", "[a.sql, a.sql]", "[\"a b.sql\"]"]) {
    expect(() => loadConfig(runtimeFixture(`      workers:\n        schedule_sql: ${bad}\n`))).toThrow();
  }
  expect(() => loadConfig(runtimeFixture("      workers:\n        schedule_sql: [a.sql]\n        cron: '* * * * *'\n"))).toThrow();
});

test("a restart with autostart activates the workers; without it the workers stay stopped", async () => {
  const idle = harness();
  const stopped = await idle.run("functions.runtime.restart");
  expect(stopped.output).toEqual({ runtime_ready: true, workers_stopped: true });
  expect(idle.calls.some(call => call.argv.includes(" show "))).toBe(false);
  expect(idle.sessions().every(isStop)).toBe(true);

  const auto = harness(() => undefined, { runtime: { workers: { ...workers, autostart: true } } });
  const started = await auto.run("functions.runtime.restart");
  expect(started.output).toEqual({ runtime_ready: true, workers_stopped: false, workers_active: true });
  const sessions = auto.sessions();
  expect(sessions.at(-1)).toBe(activateLocalWorkerSql(["sampleapp-posta"]));
  const start = auto.calls.findIndex(call => call.argv.startsWith("supabase start"));
  const firstSchedule = auto.calls.findIndex(call => call.stdin?.startsWith(SCRIPT));
  expect(start).toBeGreaterThan(-1);
  expect(firstSchedule).toBeGreaterThan(start);
});

test("an autostart that fails reports the restart and the failed activation, with the workers stopped", async () => {
  const h = harness((argv, stdin) => argv[0] === "psql" && stdin?.startsWith(SCRIPT) ? { exitCode: 1, stderr: "leaked-canary" } : undefined,
    { runtime: { workers: { ...workers, autostart: true } } });
  const error = await failure(h.run("functions.runtime.restart"));
  expect(error.message).toBe("Local runtime restarted; worker activation failed: Local worker schedule failed");
  expect(isStop(h.sessions().at(-1)!)).toBe(true);
  expect(error.message).not.toContain("leaked-canary");
});

test("a secret update restarts with autostart too, so a new secret never runs on old workers", async () => {
  const h = harness(() => undefined, { runtime: { workers: { ...workers, autostart: true } } });
  const result = await h.run("secrets.set", { names: ["CRON_SECRET"] });
  expect(result.output).toMatchObject({ workers_active: true });
  expect(h.calls.some(call => call.argv.startsWith("supabase start"))).toBe(true);
});

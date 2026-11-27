import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { loadConfig, type ProjectConfig } from "../src/config.js";
import type { Job } from "../src/domain.js";
import { LiveSupabaseExecutor, type LiveProcess } from "../src/live-executor.js";
import { createHandlers } from "../src/mcp.js";
import { Runner } from "../src/runner.js";
import { SqliteStore } from "../src/store.js";

const secret = "local-fixture-jwt-secret-32-characters";
const key = (role: string) => {
  const head = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ role, exp: 4102444800 })).toString("base64url");
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
};
const status = { "API URL": "http://127.0.0.1:54341", "DB URL": "postgresql://x:p@127.0.0.1:54342/postgres",
  "anon key": key("anon"), "JWT secret": secret };
const process: LiveProcess = { async run(input) {
  if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
  return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
} };
const project = { target: "local", repo: "/fixture", chamber: "local", project_ref: "",
  credentials: { secret_key: "", management_token: "", database_access: "" },
  capabilities: ["edge-functions"], mode: "live", migrations: "owner", migration_driver: "supabase",
  local_functions: { probe: { identity: "anon" } } } as unknown as ProjectConfig;
const credentials = { secret_key: "", management_token: "", database_access: "" };
const job = (payload: Record<string, unknown>) => ({ id: "job", project: "app", operation: "functions.invoke",
  payload, repo_sha: "a".repeat(40), capability: "edge-functions", status: "running" }) as unknown as Job;

test("a registered local function is invoked on loopback with bounded input, without exposing its key", async () => {
  let target = "", received = "", auth = "";
  const executor = new LiveSupabaseExecutor({ process, fetch: async (url, init) => {
    target = String(url); received = String(init?.body); auth = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ answer: "ok" });
  } });
  const result = await executor.execute(job({ name: "probe", body: { input: "hello" } }), project, credentials);
  expect(target).toBe("http://127.0.0.1:54341/functions/v1/probe");
  expect(JSON.parse(received)).toEqual({ input: "hello" });
  expect(auth).toBe(`Bearer ${key("anon")}`);
  expect(result.output).toEqual({ status: 200, response_bytes: 15 });
  expect(JSON.stringify(result)).not.toContain(key("anon"));
});

test("function responses are never exposed, even if they contain unrelated runtime secrets", async () => {
  const providerSecret = "provider-canary-3827";
  const executor = new LiveSupabaseExecutor({ process, fetch: async () => Response.json({ secret: providerSecret }) });
  const result = await executor.execute(job({ name: "probe" }), project, credentials);
  expect(JSON.stringify(result)).not.toContain(providerSecret);
});

test("an unregistered or path-like function cannot cause an HTTP request", async () => {
  let called = false;
  const executor = new LiveSupabaseExecutor({ process, fetch: async () => { called = true; return new Response(); } });
  for (const name of ["other", "../probe", "probe?x=1"]) {
    await expect(executor.execute(job({ name }), project, credentials)).rejects.toThrow();
  }
  expect(called).toBe(false);
});

test("a remote API URL and a redirect are refused without leaking credentials", async () => {
  const remoteProcess: LiveProcess = { async run(input) {
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    return { exitCode: 0, stdout: JSON.stringify({ ...status, "API URL": "http://remote.example" }), stderr: "" };
  } };
  let calls = 0;
  const remote = new LiveSupabaseExecutor({ process: remoteProcess, fetch: async () => { calls++; return new Response(); } });
  await expect(remote.execute(job({ name: "probe" }), project, credentials)).rejects.toThrow(/loopback/i);
  expect(calls).toBe(0);
  const redirect = new LiveSupabaseExecutor({ process, fetch: async (_url, init) => {
    expect(init?.redirect).toBe("error"); throw new Error(`redirect ${key("anon")}`);
  } });
  await expect(redirect.execute(job({ name: "probe" }), project, credentials))
    .rejects.toThrow("Local function request failed");
});

test("a function returning an error is a failed job, not a successful invocation", async () => {
  const executor = new LiveSupabaseExecutor({ process, fetch: async () =>
    new Response(`error ${key("anon")}`, { status: 500 }) });
  await expect(executor.execute(job({ name: "probe" }), project, credentials))
    .rejects.toThrow("Local function returned HTTP 500");
});

test("an HTTP failure cannot expose a secret through stream cancellation", async () => {
  const executor = new LiveSupabaseExecutor({ process, fetch: async () => new Response(new ReadableStream({
    cancel() { throw new Error(`cancel ${key("anon")}`); }
  }), { status: 502 }) });
  await expect(executor.execute(job({ name: "probe" }), project, credentials))
    .rejects.toThrow("Local function returned HTTP 502");
});

test("a function registered with an account receives only that account's signed identity", async () => {
  let authorization = "";
  const executor = new LiveSupabaseExecutor({ process, fetch: async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ ok: true });
  } });
  const configured = { ...project, local_functions: { probe: { identity: "account", account: "coach" } },
    auth_password_accounts: { coach: { user_id: "11111111-1111-4111-8111-111111111111", email: "coach@example.test", password_ref: "vault://fixture/coach" } } } as unknown as ProjectConfig;
  const result = await executor.execute(job({ name: "probe" }), configured, credentials);
  const bearer = authorization.replace(/^Bearer /, "");
  const claims = JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString());
  expect(claims.sub).toBe("11111111-1111-4111-8111-111111111111");
  expect(claims.role).toBe("authenticated");
  expect(JSON.stringify(result)).not.toContain(bearer);
});

test("an inherited account name cannot grant an authenticated identity", async () => {
  let calls = 0;
  const executor = new LiveSupabaseExecutor({ process, fetch: async () => { calls++; return new Response(); } });
  const configured = { ...project, local_functions: { probe: { identity: "account", account: "constructor" } },
    auth_password_accounts: {} } as unknown as ProjectConfig;
  await expect(executor.execute(job({ name: "probe" }), configured, credentials))
    .rejects.toThrow("Local function account is not registered");
  expect(calls).toBe(0);
});

test("oversized requests never reach the gateway and oversized responses are refused", async () => {
  let calls = 0;
  const executor = new LiveSupabaseExecutor({ process, fetch: async () => {
    calls++;
    return new Response("x".repeat(65537));
  } });
  await expect(executor.execute(job({ name: "probe", body: { text: "x".repeat(65537) } }), project, credentials))
    .rejects.toThrow(/request is too large/);
  expect(calls).toBe(0);
  await expect(executor.execute(job({ name: "probe" }), project, credentials))
    .rejects.toThrow(/response is too large/);
  expect(calls).toBe(1);
});

test("stream failures cannot reveal the local key", async () => {
  const executor = new LiveSupabaseExecutor({ process, fetch: async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error(`failed ${key("anon")}`)); }
  })) });
  await expect(executor.execute(job({ name: "probe" }), project, credentials))
    .rejects.toThrow("Local function response failed");
});

test("the broker queues and completes a registered local invocation without exposing response contents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "supadrum-local-function-job-"));
  const file = join(dir, "config.yml");
  writeFileSync(file, `version: 1
database: queue.sqlite
executor: command
approval_mode: automatic
chambers:
  local:
    target: local
    local_functions:
      probe: { identity: anon }
projects:
  app:
    chamber: local
    repo: /fixture
    mode: live
    capabilities: [edge-functions]
`);
  const config = loadConfig(file), store = new SqliteStore(config.database_path, undefined, "automatic");
  try {
    const broker = createHandlers(config, store);
    const queued = broker.jobsSubmit({ project: "app", operation: "functions.invoke", payload: { name: "probe" },
      repo_sha: "a".repeat(40), idempotency_key: "app:probe" });
    const executor = new LiveSupabaseExecutor({ process, fetch: async () => Response.json({ protected: "hidden" }) });
    const runner = new Runner(store, config, { async resolve() { return credentials; } }, executor);
    await runner.tick();
    const finished = broker.jobsStatus({ job_id: queued.id });
    expect(finished.status).toBe("completed");
    expect(finished.result).toMatchObject({ output: { status: 200 } });
    expect(JSON.stringify(finished)).not.toContain("hidden");
  } finally { store.close(); }
});

test("a local invocation reaches an actual loopback HTTP endpoint", async () => {
  let route = "", auth = "";
  const server = createServer((req, res) => {
    route = req.url ?? ""; auth = req.headers.authorization ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const httpProcess: LiveProcess = { async run(input) {
      if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ ...status, "API URL": `http://127.0.0.1:${address.port}` }), stderr: "" };
    } };
    const result = await new LiveSupabaseExecutor({ process: httpProcess }).execute(job({ name: "probe" }), project, credentials);
    expect(result.output).toEqual({ status: 200, response_bytes: 11 });
    expect(route).toBe("/functions/v1/probe");
    expect(auth).toBe(`Bearer ${key("anon")}`);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("worker stop uses only operator-registered job names on the local database", async () => {
  let sql = "";
  const testProcess: LiveProcess = { async run(input) {
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    sql = input.stdin ?? "";
    expect(input.env.PGHOST).toBe("127.0.0.1");
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const configured = { ...project, local_worker_jobs: ["sampleapp-posta", "sampleapp-avvisi"] } as unknown as ProjectConfig;
  const stop = { ...job({}), operation: "functions.workers.stop" } as unknown as Job;
  const result = await new LiveSupabaseExecutor({ process: testProcess }).execute(stop, configured, credentials);
  expect(sql).toContain("cron.alter_job");
  expect(sql).toContain("'sampleapp-posta'");
  expect(sql).toContain("'sampleapp-avvisi'");
  expect(sql).not.toContain("otherapp");
  expect(result.verification).toMatchObject({ target: "local" });
});

test("worker stop reports an unknown state if the database fails or times out", async () => {
  for (const timedOut of [false, true]) {
    const testProcess: LiveProcess = { async run(input) {
      if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
      if (input.argv[0] === "supabase") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
      return { exitCode: timedOut ? 0 : 1, timedOut, stdout: "", stderr: "db credential canary" };
    } };
    const configured = { ...project, local_worker_jobs: ["sampleapp-posta"] } as unknown as ProjectConfig;
    const stop = { ...job({}), operation: "functions.workers.stop" } as unknown as Job;
    await expect(new LiveSupabaseExecutor({ process: testProcess }).execute(stop, configured, credentials))
      .rejects.toThrow("Local worker stop failed; worker state is unknown");
  }
});

test("worker stop masks an unexpected process error", async () => {
  const testProcess: LiveProcess = { async run(input) {
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    throw new Error("process leaked-secret");
  } };
  const configured = { ...project, local_worker_jobs: ["sampleapp-posta"] } as unknown as ProjectConfig;
  const stop = { ...job({}), operation: "functions.workers.stop" } as unknown as Job;
  await expect(new LiveSupabaseExecutor({ process: testProcess }).execute(stop, configured, credentials))
    .rejects.toThrow("Local worker stop failed; worker state is unknown");
});

test("worker stop rejects caller-selected jobs and unsafe configured names before database access", async () => {
  let databaseCalls = 0;
  const testProcess: LiveProcess = { async run(input) {
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    databaseCalls++;
    return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
  } };
  const executor = new LiveSupabaseExecutor({ process: testProcess });
  const configured = { ...project, local_worker_jobs: ["worker'; select 1; --"] } as unknown as ProjectConfig;
  const stop = { ...job({}), operation: "functions.workers.stop" } as unknown as Job;
  await expect(executor.execute(stop, configured, credentials)).rejects.toThrow("Local worker jobs are not registered");
  await expect(executor.execute({ ...stop, payload: { names: ["otherapp"] } }, project, credentials))
    .rejects.toThrow(/empty payload/);
  expect(databaseCalls).toBe(0);
});

test("runtime restart first stops workers, injects only registered secrets, then probes readiness", async () => {
  const calls: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const testProcess: LiveProcess = { async run(input) {
    calls.push({ argv: input.argv, env: input.env });
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase" && input.argv.includes("status")) return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "docker") return { exitCode: 0, stdout: JSON.stringify([{ Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } }]), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const configured = { ...project, capabilities: ["edge-functions", "secrets"], local_worker_jobs: ["sampleapp-posta"],
    local_runtime: { secrets: ["CRON_SECRET"], probe: "probe" }, managed_secrets: { CRON_SECRET: "vault://fixture/cron" } } as unknown as ProjectConfig;
  const restart = { ...job({}), operation: "functions.runtime.restart" } as unknown as Job;
  const executor = new LiveSupabaseExecutor({ process: testProcess, resolveReference: async () => "sensitive-fixture",
    fetch: async () => new Response("ok") });
  const result = await executor.execute(restart, configured, credentials);
  const psql = calls.findIndex(call => call.argv[0] === "psql");
  const stop = calls.findIndex(call => call.argv[0] === "supabase" && call.argv[1] === "stop");
  const start = calls.findIndex(call => call.argv[0] === "supabase" && call.argv[1] === "start");
  expect(psql).toBeGreaterThan(-1); expect(stop).toBeGreaterThan(psql); expect(start).toBeGreaterThan(stop);
  expect(calls[start]!.env.CRON_SECRET).toBe("sensitive-fixture");
  expect(JSON.stringify(result)).not.toContain("sensitive-fixture");
  expect(result.output).toMatchObject({ runtime_ready: true, workers_stopped: true });
});

test("a missing secret leaves workers stopped and never restarts the stack", async () => {
  const calls: string[] = [];
  const testProcess: LiveProcess = { async run(input) {
    calls.push(input.argv[0] + ":" + (input.argv[1] ?? ""));
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const configured = { ...project, capabilities: ["edge-functions", "secrets"], local_worker_jobs: ["sampleapp-posta"],
    local_runtime: { secrets: ["CRON_SECRET"], probe: "probe" }, managed_secrets: {} } as unknown as ProjectConfig;
  const restart = { ...job({}), operation: "functions.runtime.restart" } as unknown as Job;
  await expect(new LiveSupabaseExecutor({ process: testProcess, resolveReference: async () => "unused" })
    .execute(restart, configured, credentials)).rejects.toMatchObject({ missing: ["CRON_SECRET"] });
  expect(calls.some(call => call.startsWith("psql:"))).toBe(true);
  expect(calls).not.toContain("supabase:stop"); expect(calls).not.toContain("supabase:start");
});

test("workers are stopped again after startup before a failed readiness probe", async () => {
  const calls: string[] = [];
  const testProcess: LiveProcess = { async run(input) {
    calls.push(input.argv[0] + ":" + (input.argv[1] ?? ""));
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase" && input.argv[1] === "status") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "docker") return { exitCode: 0, stdout: JSON.stringify([{ Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } }]), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const configured = { ...project, capabilities: ["edge-functions", "secrets"], local_worker_jobs: ["sampleapp-posta"],
    local_runtime: { secrets: ["CRON_SECRET"], probe: "probe" }, managed_secrets: { CRON_SECRET: "vault://fixture/cron" } } as unknown as ProjectConfig;
  const restart = { ...job({}), operation: "functions.runtime.restart" } as unknown as Job;
  const executor = new LiveSupabaseExecutor({ process: testProcess, resolveReference: async () => "value",
    fetch: async () => new Response("not ready", { status: 503 }) });
  await expect(executor.execute(restart, configured, credentials)).rejects.toThrow("Local function returned HTTP 503");
  expect(calls.filter(call => call.startsWith("psql:"))).toHaveLength(2);
});

test("a startup process failure triggers a scoped, data-preserving stop", async () => {
  const calls: string[] = [];
  const testProcess: LiveProcess = { async run(input) {
    calls.push(input.argv.join(" "));
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase" && input.argv[1] === "status") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "docker") return { exitCode: 0, stdout: JSON.stringify([{ Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } }]), stderr: "" };
    if (input.argv[0] === "supabase" && input.argv[1] === "start") throw new Error("child included secret");
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const configured = { ...project, capabilities: ["edge-functions", "secrets"], local_worker_jobs: ["sampleapp-posta"],
    local_runtime: { secrets: ["CRON_SECRET"], probe: "probe" }, managed_secrets: { CRON_SECRET: "vault://fixture/cron" } } as unknown as ProjectConfig;
  const restart = { ...job({}), operation: "functions.runtime.restart" } as unknown as Job;
  await expect(new LiveSupabaseExecutor({ process: testProcess, resolveReference: async () => "value" })
    .execute(restart, configured, credentials)).rejects.toThrow("Local runtime start failed; project stack stopped");
  expect(calls.filter(call => call === "supabase stop")).toHaveLength(2);
  expect(calls.some(call => call.includes("--no-backup") || call.includes("--all"))).toBe(false);
});

test("an unexpected stop process error cannot disclose its output", async () => {
  const testProcess: LiveProcess = { async run(input) {
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase" && input.argv[1] === "status") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "docker") return { exitCode: 0, stdout: JSON.stringify([{ Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } }]), stderr: "" };
    if (input.argv[0] === "supabase" && input.argv[1] === "stop") throw new Error("credential canary");
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const configured = { ...project, capabilities: ["edge-functions", "secrets"], local_worker_jobs: ["sampleapp-posta"],
    local_runtime: { secrets: ["CRON_SECRET"], probe: "probe" }, managed_secrets: { CRON_SECRET: "vault://fixture/cron" } } as unknown as ProjectConfig;
  const restart = { ...job({}), operation: "functions.runtime.restart" } as unknown as Job;
  await expect(new LiveSupabaseExecutor({ process: testProcess, resolveReference: async () => "value" })
    .execute(restart, configured, credentials)).rejects.toThrow("Local runtime stop failed; stack state is unknown");
});

test("local secret update restarts the runtime as one registered configuration", async () => {
  const calls: string[] = [];
  const testProcess: LiveProcess = { async run(input) {
    calls.push(input.argv[0] + ":" + (input.argv[1] ?? ""));
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase" && input.argv[1] === "status") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "docker") return { exitCode: 0, stdout: JSON.stringify([{ Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } }]), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const configured = { ...project, capabilities: ["edge-functions", "secrets"], local_worker_jobs: ["sampleapp-posta"],
    local_runtime: { secrets: ["CRON_SECRET", "MAIL_KEY"], probe: "probe" },
    managed_secrets: { CRON_SECRET: "vault://fixture/cron", MAIL_KEY: "vault://fixture/mail" } } as unknown as ProjectConfig;
  const update = { ...job({ names: ["CRON_SECRET", "MAIL_KEY"] }), operation: "secrets.set", capability: "secrets" } as unknown as Job;
  const executor = new LiveSupabaseExecutor({ process: testProcess, resolveReference: async () => "fixture-secret",
    fetch: async () => new Response("ok") });
  const result = await executor.execute(update, configured, credentials);
  expect(result.output).toMatchObject({ runtime_ready: true, workers_stopped: true });
  expect(calls).toContain("supabase:start");
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  await expect(executor.execute({ ...update, payload: { names: ["CRON_SECRET"] } }, configured, credentials))
    .rejects.toThrow("Local secret updates must cover the entire runtime configuration");
});

const loopbackNetwork = JSON.stringify([{ Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" } }]);
/** Runs a registered restart against a scripted process; `answer` overrides any command, `calls` records them all. */
async function restartWith(answer: (argv: readonly string[]) => { exitCode: number; stdout?: string; timedOut?: boolean } | undefined,
  runtime: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const testProcess: LiveProcess = { async run(input) {
    calls.push(input.argv.join(" "));
    const override = answer(input.argv);
    if (override) return { stdout: "", stderr: "", ...override };
    if (input.argv[0] === "git") return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" };
    if (input.argv[0] === "supabase" && input.argv[1] === "status") return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "docker") return { exitCode: 0, stdout: loopbackNetwork, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const configured = { ...project, capabilities: ["edge-functions", "secrets"], local_worker_jobs: ["sampleapp-posta"],
    local_runtime: { secrets: ["CRON_SECRET"], probe: "probe", ...runtime }, managed_secrets: { CRON_SECRET: "vault://fixture/cron" } } as unknown as ProjectConfig;
  const restart = { ...job({}), operation: "functions.runtime.restart" } as unknown as Job;
  const executor = new LiveSupabaseExecutor({ process: testProcess, resolveReference: async () => "value", fetch: async () => new Response("ok") });
  return { calls, outcome: executor.execute(restart, configured, credentials) };
}

test("the restart starts the stack on the operator's loopback network, not on a default one", async () => {
  const { calls, outcome } = await restartWith(() => undefined, { network: "fixture_net" });
  await outcome;
  expect(calls).toContain("docker network inspect fixture_net");
  expect(calls.find(call => call.startsWith("supabase start"))).toBe("supabase start --network-id fixture_net");
});

test("a network that is not bound to loopback is refused before the stack is touched", async () => {
  const { calls, outcome } = await restartWith(argv => argv[0] === "docker"
    ? { exitCode: 0, stdout: JSON.stringify([{ Options: {} }]) } : undefined);
  await expect(outcome).rejects.toThrow("Local runtime network is not bound to loopback");
  expect(calls.some(call => call.startsWith("supabase stop") || call.startsWith("supabase start"))).toBe(false);
});

const createLoopback = "docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 fixture_net";

test("a network that `supabase stop` removed is recreated bound to loopback before the stack starts again", async () => {
  // The CLI deletes a labeled network on stop and start would recreate it on every interface (observed on a real stack).
  let stopped = false;
  const { calls, outcome } = await restartWith(argv => {
    if (argv[0] === "supabase" && argv[1] === "stop") stopped = true;
    if (argv[0] === "docker" && argv[2] === "inspect" && stopped) return { exitCode: 1 };
    return undefined;
  }, { network: "fixture_net" });
  await outcome;
  expect(calls.filter(call => call === createLoopback)).toHaveLength(1);
  expect(calls.indexOf(createLoopback)).toBeGreaterThan(calls.findIndex(call => call.startsWith("supabase stop")));
  expect(calls.indexOf(createLoopback)).toBeLessThan(calls.findIndex(call => call.startsWith("supabase start")));
});

test("a network that appears after the stop without loopback binding keeps the stack from starting", async () => {
  let stopped = false;
  const { calls, outcome } = await restartWith(argv => {
    if (argv[0] === "supabase" && argv[1] === "stop") stopped = true;
    if (argv[0] === "docker" && argv[2] === "inspect" && stopped) return { exitCode: 0, stdout: JSON.stringify([{ Options: {} }]) };
    return undefined;
  });
  await expect(outcome).rejects.toThrow("Local runtime network is not bound to loopback");
  expect(calls.some(call => call.startsWith("supabase start"))).toBe(false);
});

test("a network that does not exist yet is created bound to loopback, and one that exists is not touched", async () => {
  const absent = await restartWith(argv => argv[0] === "docker" && argv[2] === "inspect" ? { exitCode: 1 } : undefined, { network: "fixture_net" });
  await absent.outcome;
  expect(absent.calls).toContain(createLoopback);
  const present = await restartWith(() => undefined, { network: "fixture_net" });
  await present.outcome;
  expect(present.calls.some(call => call.startsWith("docker network create"))).toBe(false);
});

test("a network that cannot be created keeps the stack from being touched", async () => {
  const { calls, outcome } = await restartWith(argv => argv[0] === "docker" ? { exitCode: 1 } : undefined);
  await expect(outcome).rejects.toThrow("Local runtime network could not be created");
  expect(calls.some(call => call.startsWith("supabase stop") || call.startsWith("supabase start"))).toBe(false);
});

test("a stop that exits badly or times out leaves the stack alone and says its state is unknown", async () => {
  for (const failure of [{ exitCode: 1 }, { exitCode: 0, timedOut: true }]) {
    const { calls, outcome } = await restartWith(argv => argv[0] === "supabase" && argv[1] === "stop" ? failure : undefined);
    await expect(outcome).rejects.toThrow("Local runtime stop failed; stack state is unknown");
    expect(calls.some(call => call.startsWith("supabase start"))).toBe(false);
  }
});

test("a start that exits badly stops the project stack, and says so only if that stop worked", async () => {
  let stops = 0;
  const bad = await restartWith(argv => argv[1] === "start" ? { exitCode: 1 } : undefined);
  await expect(bad.outcome).rejects.toThrow("Local runtime start failed; project stack stopped");
  const unsure = await restartWith(argv => {
    if (argv[0] === "supabase" && argv[1] === "stop" && ++stops > 1) return { exitCode: 1 };
    return argv[1] === "start" ? { exitCode: 1 } : undefined;
  });
  await expect(unsure.outcome).rejects.toThrow("Local runtime start failed; worker state is unknown");
});

test("workers that cannot be stopped after the restart take the project stack down with them", async () => {
  let psql = 0;
  const { calls, outcome } = await restartWith(argv => argv[0] === "psql" && ++psql > 1 ? { exitCode: 1 } : undefined);
  await expect(outcome).rejects.toThrow("Local worker stop failed; project stack stopped");
  expect(calls.filter(call => call === "supabase stop")).toHaveLength(2);
});

test("a stack left down by a failed restart comes back up without a worker stop it cannot run", async () => {
  let up = false;
  const { calls, outcome } = await restartWith(argv => {
    if (argv[0] === "supabase" && argv[1] === "start") { up = true; return undefined; }
    return argv[0] === "supabase" && argv[1] === "status" && !up ? { exitCode: 1 } : undefined;
  });
  const result = await outcome;
  const psql = calls.findIndex(call => call.startsWith("psql"));
  expect(calls.findIndex(call => call.startsWith("supabase start"))).toBeGreaterThan(-1);
  expect(psql).toBeGreaterThan(calls.findIndex(call => call.startsWith("supabase start")));
  expect(calls.filter(call => call.startsWith("psql"))).toHaveLength(1);
  expect(result.output).toMatchObject({ runtime_ready: true, workers_stopped: true });
});

test("a stack that cannot be told from running keeps the fail-closed worker stop", async () => {
  for (const status of [{ exitCode: 0, stdout: "not json" }, { exitCode: 0, stdout: JSON.stringify({ API_URL: "http://127.0.0.1:54321" }) }]) {
    const { calls, outcome } = await restartWith(argv => argv[0] === "supabase" && argv[1] === "status" ? status : undefined);
    await expect(outcome).rejects.toThrow(/Local Supabase status/);
    expect(calls.some(call => call.startsWith("supabase stop") || call.startsWith("supabase start"))).toBe(false);
  }
});

test("a running stack whose workers cannot be stopped is not restarted", async () => {
  const { calls, outcome } = await restartWith(argv => argv[0] === "psql" ? { exitCode: 1 } : undefined);
  await expect(outcome).rejects.toThrow("Local worker stop failed; worker state is unknown");
  expect(calls.some(call => call.startsWith("supabase stop") || call.startsWith("supabase start"))).toBe(false);
});

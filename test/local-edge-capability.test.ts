import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { inspectProject, loadConfig } from "../src/config.js";
import { JobSubmissionSchema } from "../src/domain.js";
import { createHandlers } from "../src/mcp.js";
import { SqliteStore } from "../src/store.js";

test("a local project can declare edge functions without remote credentials", () => {
  const file = join(mkdtempSync(join(tmpdir(), "supadrum-local-edge-")), "config.yml");
  writeFileSync(file, `version: 1
chambers:
  local:
    target: local
projects:
  sampleapp-local:
    chamber: local
    mode: live
    capabilities: [migrations, sql, edge-functions]
`);
  const config = loadConfig(file);
  const project = config.projects["sampleapp-local"]!;
  expect(inspectProject("sampleapp-local", config).capabilities).toContain("edge-functions");
  expect(Object.values(project.credentials).every(value => value === "")).toBe(true);
});

test("a caller cannot select which workers the broker stops", () => {
  const base = { project: "app", operation: "functions.workers.stop", repo_sha: "abcdef0", idempotency_key: "app:stop" };
  expect(JobSubmissionSchema.safeParse({ ...base, payload: {} }).success).toBe(true);
  expect(JobSubmissionSchema.safeParse({ ...base, payload: { names: ["otherapp"] } }).success).toBe(false);
});

test("a secret check names registered secrets only, once each, and nothing else", () => {
  const submit = (payload: unknown) => JobSubmissionSchema.safeParse({
    project: "app", operation: "secrets.check", repo_sha: "abcdef0", idempotency_key: "app:check", payload
  }).success;
  expect(submit({ names: ["CRON_SECRET"] })).toBe(true);
  expect(submit({})).toBe(false);
  expect(submit({ names: [] })).toBe(false);
  expect(submit({ names: ["CRON_SECRET", "CRON_SECRET"] })).toBe(false);
  expect(submit({ names: ["SUPABASE_URL"] })).toBe(false);
  expect(submit({ names: ["CRON_SECRET"], extra: 1 })).toBe(false);
  expect(submit({ names: Array.from({ length: 101 }, (_, i) => `NAME_${i}`) })).toBe(false);
});

test("an invocation carries a function name and a body, never a URL or headers", () => {
  const submit = (payload: unknown) => JobSubmissionSchema.safeParse({
    project: "app", operation: "functions.invoke", repo_sha: "abcdef0", idempotency_key: "app:invoke", payload
  }).success;
  expect(submit({ name: "probe", body: { a: 1 } })).toBe(true);
  expect(submit({ name: "probe", url: "http://127.0.0.1:1/x" })).toBe(false);
  expect(submit({ name: "probe", headers: { "x-test": "1" } })).toBe(false);
  expect(submit({ name: "../probe" })).toBe(false);
});

test("a function cannot impersonate an unregistered account", () => {
  const file = join(mkdtempSync(join(tmpdir(), "supadrum-local-edge-")), "config.yml");
  writeFileSync(file, `version: 1
chambers:
  local:
    target: local
    local_functions:
      probe: {identity: account, account: missing}
projects:
  app:
    chamber: local
    capabilities: [edge-functions]
`);
  expect(() => loadConfig(file)).toThrow(/function account.*not registered/i);
});

test("local secret registrations reach the executor but never appear in project inspection", () => {
  const file = join(mkdtempSync(join(tmpdir(), "supadrum-local-edge-")), "config.yml");
  writeFileSync(file, `version: 1
chambers:
  local:
    target: local
    managed_secrets:
      CRON_SECRET: vault://fixture/local/cron
projects:
  app:
    chamber: local
    capabilities: [edge-functions]
`);
  const config = loadConfig(file);
  expect(config.projects.app?.managed_secrets?.CRON_SECRET).toBe("vault://fixture/local/cron");
  expect(JSON.stringify(inspectProject("app", config))).not.toContain("fixture/local/cron");
});

const runtimeConfig = (extra: string, runtime = "secrets: [CRON_SECRET, MAIL_KEY]\n      probe: probe") => `version: 1
database: queue.sqlite
executor: command
approval_mode: automatic
chambers:
  local:
    target: local
    managed_secrets:
      CRON_SECRET: vault://fixture/local/cron
      MAIL_KEY: vault://fixture/local/mail
    local_runtime:
      ${runtime}
    local_functions:
      probe: { identity: anon }
${extra}projects:
  app:
    chamber: local
    repo: /fixture
    mode: live
    capabilities: [edge-functions, secrets]
`;
const writeTemp = (text: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "supadrum-local-edge-")), "config.yml");
  writeFileSync(file, text);
  return file;
};

test("a runtime restart cannot be configured with a secret or probe it could not resolve", () => {
  expect(() => loadConfig(writeTemp(runtimeConfig("")))).not.toThrow();
  expect(() => loadConfig(writeTemp(runtimeConfig("", "secrets: [UNMANAGED_SECRET]\n      probe: probe"))))
    .toThrow(/runtime secret.*not a managed secret/i);
  expect(() => loadConfig(writeTemp(runtimeConfig("", "secrets: [CRON_SECRET]\n      probe: other"))))
    .toThrow(/runtime probe.*not a registered local function/i);
});

test("a malformed local secret update is refused at submission, a remote one is not constrained by it", () => {
  const config = loadConfig(writeTemp(runtimeConfig(`  remote:
    target: remote
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/remote/secret
      management_token: vault://supabase/remote/management
      database_access: vault://supabase/remote/postgres
    managed_secrets:
      STRIPE_KEY: vault://supabase/remote/stripe
`).replace("projects:\n", `projects:
  hosted:
    chamber: remote
    capabilities: [secrets]
`)));
  const store = new SqliteStore(config.database_path, undefined, "automatic");
  try {
    const broker = createHandlers(config, store);
    const submit = (project: string, payload: Record<string, unknown>, key: string) => broker.jobsSubmit({
      project, operation: "secrets.set", payload, repo_sha: "a".repeat(40), idempotency_key: key });
    for (const [i, payload] of [{}, { names: [] }, { names: ["MAIL_KEY"] }, { names: ["CRON_SECRET", "OTHER_KEY"] },
      { names: ["CRON_SECRET", "CRON_SECRET"] }, { names: ["CRON_SECRET", "MAIL_KEY"], value: "x" },
      { names: ["CRON_SECRET", "SUPABASE_URL"] }].entries()) {
      expect(() => submit("app", payload, `app:bad-${i}`)).toThrow(/every registered runtime secret/);
    }
    expect(submit("app", { names: ["MAIL_KEY", "CRON_SECRET"] }, "app:good").status).toBe("queued");
    expect(submit("hosted", { names: ["STRIPE_KEY"] }, "hosted:good").status).toBe("queued");
  } finally { store.close(); }
});

test("a malformed local secret update is refused inside an active lease too", () => {
  const config = loadConfig(writeTemp(runtimeConfig("")));
  const store = new SqliteStore(config.database_path, undefined, "automatic");
  try {
    const broker = createHandlers(config, store);
    const opened = broker.sessionsOpen({ project: "app", capability: "secrets", repo_sha: "a".repeat(40),
      idempotency_key: "app:lease", ttl_ms: 60_000 });
    const granted = store.grantIfSchedulable(opened.open_job.id, new Date(Date.now() + 60_000).toISOString());
    store.transition(granted!.id, "running");
    store.activateSession(opened.session.id);
    store.transition(granted!.id, "verifying");
    store.transition(granted!.id, "completed", null, { lease_expires_at: null });
    const exec = (names: string[], key: string) => broker.sessionsExec({ session_id: opened.session.id,
      operation: "secrets.set", payload: { names }, idempotency_key: key });
    expect(() => exec(["MAIL_KEY"], "app:partial")).toThrow(/every registered runtime secret/);
    expect(exec(["CRON_SECRET", "MAIL_KEY"], "app:whole").status).toBe("queued");
  } finally { store.close(); }
});

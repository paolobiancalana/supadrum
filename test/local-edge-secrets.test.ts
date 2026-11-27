import { expect, test } from "vitest";
import { resolveLocalSecrets } from "../src/local-edge-secrets.js";
import { LiveSupabaseExecutor, type LiveProcess } from "../src/live-executor.js";
import type { Job } from "../src/domain.js";
import type { ProjectConfig } from "../src/config.js";

test("resolves only declared local secrets without exposing references", async () => {
  const references: string[] = [];
  const result = await resolveLocalSecrets(["CRON_SECRET", "MAIL_KEY"], {
    CRON_SECRET: "vault://fixture/cron", MAIL_KEY: "vault://fixture/mail"
  }, async reference => { references.push(reference); return reference.endsWith("cron") ? "cron-value" : "mail-value"; });
  expect(result).toEqual({ CRON_SECRET: "cron-value", MAIL_KEY: "mail-value" });
  expect(references).toEqual(["vault://fixture/cron", "vault://fixture/mail"]);
});

test("the broker checks registered local secrets and never exposes their values", async () => {
  const process: LiveProcess = { async run() { return { exitCode: 0, stdout: `${"a".repeat(40)}\n${"a".repeat(40)}\n`, stderr: "" }; } };
  const executor = new LiveSupabaseExecutor({ process, resolveReference: async () => "sensitive-value" });
  const project = { repo: "/fixture", chamber: "local", target: "local", project_ref: "", mode: "live",
    capabilities: ["secrets"], managed_secrets: { CRON_SECRET: "vault://fixture/cron" },
    credentials: { secret_key: "", management_token: "", database_access: "" }, migrations: "owner", migration_driver: "supabase" } as ProjectConfig;
  const job = { project: "local", operation: "secrets.check", capability: "secrets", payload: { names: ["CRON_SECRET"] }, repo_sha: "a".repeat(40) } as unknown as Job;
  const result = await executor.execute(job, project, { secret_key: "", management_token: "", database_access: "" });
  expect(result.output).toEqual({ checked: ["CRON_SECRET"] });
  expect(JSON.stringify(result)).not.toContain("sensitive-value");
  expect(JSON.stringify(result)).not.toContain("vault://");
});

test.each([
  ["no names", []],
  ["a repeated name", ["CRON_SECRET", "CRON_SECRET"]],
  ["a name the platform owns", ["SUPABASE_URL"]],
  ["a lowercase name", ["cron_secret"]],
  ["a name that is not an identifier", ["CRON;SECRET"]]
])("%s is refused before any reference is resolved", async (_label, names) => {
  let calls = 0;
  const references = { CRON_SECRET: "vault://fixture/cron", SUPABASE_URL: "vault://fixture/url",
    cron_secret: "vault://fixture/lower", "CRON;SECRET": "vault://fixture/odd" };
  await expect(resolveLocalSecrets(names, references, async () => { calls++; return "value"; }))
    .rejects.toThrow("Invalid local secret names");
  expect(calls).toBe(0);
});

test.each(["", "ab\0cd"])("a resolved value of %j is treated as missing, not injected", async value => {
  const error = await resolveLocalSecrets(["CRON_SECRET"], { CRON_SECRET: "vault://fixture/cron" },
    async () => value).catch(e => e as Error);
  expect(error).toMatchObject({ missing: ["CRON_SECRET"] });
});

test("missing or failed secrets report names only and never return a partial environment", async () => {
  let calls = 0;
  await expect(resolveLocalSecrets(["CRON_SECRET", "MAIL_KEY"], { CRON_SECRET: "vault://fixture/cron" },
    async () => { calls++; return "value"; })).rejects.toMatchObject({ missing: ["MAIL_KEY"] });
  expect(calls).toBe(0);
  const error = await resolveLocalSecrets(["CRON_SECRET"], { CRON_SECRET: "vault://fixture/cron" },
    async () => { throw new Error("provider leaked-secret"); }).catch(e => e as Error);
  expect(error.message).not.toContain("leaked-secret");
  expect(error).toMatchObject({ missing: ["CRON_SECRET"] });
});

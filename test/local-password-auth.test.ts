import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig, type ProjectConfig } from "../src/config.js";
import type { Job } from "../src/domain.js";
import { LiveSupabaseExecutor, type LiveProcessInput } from "../src/live-executor.js";

const userId = "5eed0000-0000-4000-8000-000000000001";
const email = "giulia@alfa.test";
const password = "local-password-canary-very-long";
const secret = "jwt-secret-canary-32-characters-long";
const oid = "abc123deadbeefabc123deadbeefabc123deadbe";
function jwt(role: string, sub?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, sub, aud: "authenticated", exp: 4102444800 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
  const status = {
  "API URL": "http://127.0.0.1:54331",
  "DB URL": "postgresql://postgres:db-canary@127.0.0.1:54332/postgres",
  "anon key": jwt("anon"),
  "service_role key": jwt("service_role"),
  "JWT secret": secret
};
function project(repo: string): ProjectConfig {
  return {
    repo, chamber: "atlas-local", target: "local", project_ref: "",
    credentials: { secret_key: "", management_token: "", database_access: "" },
    capabilities: ["auth-admin", "adapter-tests"], mode: "live", migrations: "consumer",
    migration_driver: "supabase",
    auth_password_accounts: { giulia: { user_id: userId, email, password_ref: "vault://atlas/local/giulia" } },
    adapter_tests: { login: {
      npm_script: "test:login", writer_password_ref: "vault://atlas/local/writer",
      personas: { student: userId, staff: "5eed0000-0000-4000-8000-000000000003", outsider: "5eed0000-0000-4000-8000-000000000004" },
      password_accounts: ["giulia"]
    } }
  };
}
function job(operation: "auth.admin" | "tests.run"): Job {
  return {
    id: "job-1", project: "atlas", operation,
    payload: operation === "auth.admin" ? { adapter: "supabase-password", action: "upsert", account: "giulia" } : { script: "login" },
    repo_sha: "abc123", idempotency_key: `atlas:${operation}`, capability: operation === "auth.admin" ? "auth-admin" : "adapter-tests",
    requires_approval: true, session_id: null, status: "running", created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z", lease_expires_at: null, approved_at: null,
    approved_by: null, result: null, error: null
  };
}
function harness() {
  const repo = mkdtempSync(join(tmpdir(), "supadrum-auth-"));
  const calls: LiveProcessInput[] = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let existingEmail = email;
  let signInStatus = 200;
  let bearerStatus = 200;
  let statusValue: Record<string, unknown> = status;
  let tokenSub = userId;
  let identityPresent = true;
  let vaultReads = 0;
  let reconcileExit = 0;
  const vault = new Map([["vault://atlas/local/giulia", password]]);
  const executor = new LiveSupabaseExecutor({
    process: { async run(input) {
      calls.push(input);
      if (input.argv[0] === "git" && input.argv.includes("rev-parse")) return { exitCode: 0, stdout: `${oid}\n${oid}\n`, stderr: "" };
      if (input.argv[0] === "git" && input.argv.includes("status")) return { exitCode: 0, stdout: "", stderr: "" };
      if (input.argv.includes("status")) return { exitCode: 0, stdout: JSON.stringify(statusValue), stderr: "" };
      if (input.argv[0] === "psql") return { exitCode: reconcileExit, stdout: "", stderr: "placeholder mismatch" };
      return { exitCode: 0, stdout: `${input.env.SUPADRUM_AUTH_GIULIA_PASSWORD ?? ""} ${Buffer.from(password).toString("base64")}`, stderr: password };
    } },
    passwordVault: { async get(reference) { vaultReads++; return vault.get(reference) ?? ""; }, async put(reference, value) { vault.set(reference, value); } },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith(`/auth/v1/admin/users/${userId}`) && init?.method === "GET")
        return Response.json({ id: userId, email: existingEmail });
      if (url.endsWith(`/auth/v1/admin/users/${userId}`) && init?.method === "PUT")
        return Response.json({ id: userId, email, identities: identityPresent ? [{ provider: "email", user_id: userId }] : [] });
      if (url.endsWith("/auth/v1/token?grant_type=password"))
        return Response.json(signInStatus === 200 ? { user: { id: userId }, access_token: jwt("authenticated", tokenSub) } : { error: "invalid_grant" }, { status: signInStatus });
      if (url.endsWith("/auth/v1/user"))
        return Response.json(bearerStatus === 200 ? { id: tokenSub, email } : { error_code: "bad_jwt" }, { status: bearerStatus });
      throw new Error("unexpected request");
    }
  });
  return { executor, repo, calls, requests, config: project(repo), vaultReads: () => vaultReads,
    setExistingEmail: (value: string) => { existingEmail = value; },
    setSignInStatus: (value: number) => { signInStatus = value; },
    setBearerStatus: (value: number) => { bearerStatus = value; },
    setTokenSub: (value: string) => { tokenSub = value; },
    setIdentityPresent: (value: boolean) => { identityPresent = value; },
    setStatus: (value: Record<string, unknown>) => { statusValue = value; },
    setReconcileExit: (value: number) => { reconcileExit = value; } };
}

describe("local Supabase password accounts", () => {
  test("config rejects duplicate account IDs", () => {
    const dir = mkdtempSync(join(tmpdir(), "supadrum-auth-config-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, `version: 1\nchambers:\n  local:\n    target: local\n    auth_password_accounts:\n      giulia: {user_id: ${userId}, email: ${email}, password_ref: vault://atlas/local/giulia}\n      other: {user_id: ${userId}, email: other@alfa.test, password_ref: vault://atlas/local/other}\nprojects:\n  atlas: {repo: ${dir}, chamber: local, capabilities: [auth-admin], mode: live}\n`);
    expect(() => loadConfig(file)).toThrow(/duplicate|shared/i);
  });

  test("config refuses one vault password shared by two different accounts", () => {
    const dir = mkdtempSync(join(tmpdir(), "supadrum-auth-config-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, `version: 1\nchambers:\n  local:\n    target: local\n    auth_password_accounts:\n      giulia: {user_id: ${userId}, email: ${email}, password_ref: vault://atlas/local/shared}\n      sara: {user_id: 5eed0000-0000-4000-8000-000000000004, email: sara@beta.test, password_ref: vault://atlas/local/shared}\nprojects:\n  atlas: {repo: ${dir}, chamber: local, capabilities: [auth-admin], mode: live}\n`);
    expect(() => loadConfig(file)).toThrow(/duplicate|shared/i);
  });

  test("upserts the registered placeholder twice, checks real password login and redacts secrets", async () => {
    const h = harness();
    for (let i = 0; i < 2; i++) {
      const result = await h.executor.execute(job("auth.admin"), h.config, {} as never);
      expect(result.verification).toMatchObject({ auth_adapter: "supabase-password", login_verified: true, email_identity_verified: true, user_id: userId });
      expect(JSON.stringify(result)).not.toContain(password);
      expect(JSON.stringify(result)).not.toContain(status["service_role key"]);
      expect(JSON.stringify(result)).not.toContain("access_token");
    }
    expect(h.requests.filter((request) => request.init?.method === "PUT")).toHaveLength(2);
    expect(h.requests.filter((request) => request.url.endsWith("/auth/v1/user"))).toHaveLength(2);
    expect(h.requests.every((request) => request.url.startsWith("http://127.0.0.1:54331/auth/v1/"))).toBe(true);
    expect(h.requests.every((request) => request.init?.redirect === "error")).toBe(true);
  });

  test("refuses an email mismatch before changing the account", async () => {
    const h = harness(); h.setExistingEmail("attacker@alfa.test");
    await expect(h.executor.execute(job("auth.admin"), h.config, {} as never)).rejects.toThrow(/does not match/i);
    expect(h.requests.some((request) => request.init?.method === "PUT")).toBe(false);
  });

  test("reconciles only the registered seed placeholder before Auth Admin", async () => {
    const h = harness();
    await h.executor.execute(job("auth.admin"), h.config, {} as never);
    const reconciliation = h.calls.find((call) => call.argv[0] === "psql");
    expect(reconciliation?.stdin).toContain(userId);
    expect(reconciliation?.stdin).toContain(email);
    expect(reconciliation?.stdin).toContain("instance_id");
    expect(reconciliation?.stdin).toContain("public.users");
    expect(reconciliation?.stdin).toContain("confirmation_token = coalesce(confirmation_token, '')");
    expect(reconciliation?.stdin).toContain("raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)");
    expect(reconciliation?.stdin).toContain("is_sso_user = coalesce(is_sso_user, false)");
    expect(reconciliation?.env.PGHOST).toBe("127.0.0.1");
    expect(h.requests).toHaveLength(4);
  });

  test("a mismatched or unlinked placeholder blocks Auth Admin before vault access", async () => {
    const h = harness(); h.setReconcileExit(3);
    await expect(h.executor.execute(job("auth.admin"), h.config, {} as never)).rejects.toThrow(/placeholder reconciliation failed/i);
    expect(h.requests).toHaveLength(0);
    expect(h.vaultReads()).toBe(0);
  });

  test("does not mark a password update complete if actual login fails", async () => {
    const h = harness(); h.setSignInStatus(400);
    await expect(h.executor.execute(job("auth.admin"), h.config, {} as never)).rejects.toThrow(/login verification failed/i);
  });

  test("refuses an Auth update that leaves the email identity absent", async () => {
    const h = harness(); h.setIdentityPresent(false);
    await expect(h.executor.execute(job("auth.admin"), h.config, {} as never)).rejects.toThrow(/email identity/i);
  });

  test("rejects a signed token for another user after password login", async () => {
    const h = harness(); h.setTokenSub("5eed0000-0000-4000-8000-000000000004");
    await expect(h.executor.execute(job("auth.admin"), h.config, {} as never)).rejects.toThrow(/login verification failed/i);
  });

  test("rejects a session whose bearer token Auth will not accept", async () => {
    const h = harness(); h.setBearerStatus(401);
    await expect(h.executor.execute(job("auth.admin"), h.config, {} as never)).rejects.toThrow(/bearer verification failed/i);
  });

  test("rejects arbitrary account selectors and remote API URLs before reading the vault", async () => {
    const h = harness();
    const forged = { ...job("auth.admin"), payload: { adapter: "supabase-password", action: "upsert", account: "constructor" } };
    await expect(h.executor.execute(forged, h.config, {} as never)).rejects.toThrow(/not registered/i);
    expect(h.requests).toHaveLength(0);
    expect(h.vaultReads()).toBe(0);
    h.setStatus({ ...status, "API URL": "https://evil.example.test" });
    await expect(h.executor.execute(job("auth.admin"), h.config, {} as never)).rejects.toThrow(/loopback/i);
    expect(h.requests).toHaveLength(0);
    expect(h.vaultReads()).toBe(0);
  });

  test("rejects the wrong admin key and a project without auth-admin", async () => {
    const h = harness();
    const denied = { ...h.config, capabilities: ["adapter-tests" as const] };
    await expect(h.executor.execute(job("auth.admin"), denied, {} as never)).rejects.toThrow(/lacks auth-admin/i);
    expect(h.vaultReads()).toBe(0);
    h.setStatus({ ...status, "service_role key": jwt("anon") });
    await expect(h.executor.execute(job("auth.admin"), h.config, {} as never)).rejects.toThrow(/service_role key is invalid/i);
    expect(h.requests).toHaveLength(0);
  });

  test("injects registered passwords only into the test child and redacts its streams", async () => {
    const h = harness();
    const result = await h.executor.execute(job("tests.run"), h.config, {} as never);
    const child = h.calls.find((call) => call.argv[0] === "npm");
    expect(child?.env.SUPADRUM_AUTH_GIULIA_EMAIL).toBe(email);
    expect(child?.env.SUPADRUM_AUTH_GIULIA_PASSWORD).toBe(password);
    expect(h.calls.filter((call) => call.argv[0] !== "npm").every((call) => !Object.values(call.env).includes(password))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(Buffer.from(password).toString("base64"));
    expect(result.output).toMatchObject({ stdout: "[SUPPRESSED: password-bearing test]", stderr: "[SUPPRESSED: password-bearing test]" });
  });
});

import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { loadConfig, type ProjectConfig } from "../src/config.js";
import type { Job } from "../src/domain.js";
import { LiveSupabaseExecutor, type LiveProcess, type LiveProcessInput } from "../src/live-executor.js";
import { personalLoginProvisionSql } from "../src/local-adapter-tests.js";

const oid = "abc123deadbeefabc123deadbeefabc123deadbe";
const jwtSecret = "jwt-secret-canary-32-characters-long";
const unsigned = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ iss: "supabase", role: "anon", exp: 4102444800 })).toString("base64url")
].join(".");
const anonKey = `${unsigned}.${createHmac("sha256", jwtSecret).update(unsigned).digest("base64url")}`;
const status = {
  "API URL": "http://127.0.0.1:54331",
  "DB URL": "postgresql://postgres:admin-canary@127.0.0.1:54332/postgres",
  "anon key": anonKey,
  "JWT secret": jwtSecret
};
const costOwner = "cost_owner_paolobiancalana";
const operator = "operator_paolobiancalana";

function project(repository: string, logins = [costOwner, operator]): ProjectConfig {
  return {
    repo: repository, chamber: "atlas-local", target: "local", project_ref: "",
    credentials: { secret_key: "", management_token: "", database_access: "" },
    capabilities: ["adapter-tests"], mode: "live", migrations: "consumer", migration_driver: "supabase",
    database_logins: {
      [costOwner]: { role: "atlas_cost_owner", person: "paolobiancalana", password_ref: "vault://tests/local/cost-owner" },
      [operator]: { role: "atlas_session_operator", person: "paolobiancalana", password_ref: "vault://tests/local/operator" }
    },
    adapter_tests: {
      reconciler: {
        npm_script: "test:reconciler",
        writer_password_ref: "vault://tests/local/writer",
        database_logins: logins,
        personas: {
          student: "c0470000-0000-4000-8000-1000000000a1",
          staff: "c0470000-0000-4000-8000-1000000000a3",
          outsider: "c0470000-0000-4000-8000-1000000000b1"
        }
      }
    }
  };
}

const job: Job = {
  id: "job-1", project: "atlas", operation: "tests.run", payload: { script: "reconciler" },
  repo_sha: "abc123", idempotency_key: "atlas:test", capability: "adapter-tests",
  requires_approval: true, session_id: null, status: "running",
  created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z", lease_expires_at: null,
  approved_at: null, approved_by: null, result: null, error: null
};

class Process implements LiveProcess {
  readonly calls: LiveProcessInput[] = [];
  failLogin = "";
  failStderr = "";
  failDisable = false;
  async run(input: LiveProcessInput) {
    this.calls.push(input);
    if (input.argv[0] === "git" && input.argv.includes("rev-parse")) return { exitCode: 0, stdout: `${oid}\n${oid}\n`, stderr: "" };
    if (input.argv[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
    if (input.argv.includes("status")) return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "psql") {
      if (this.failDisable && input.stdin?.includes(" nologin")) return { exitCode: 2, stdout: "", stderr: "" };
      const failing = this.failLogin && input.stdin?.includes(`create role supadrum_atlas_${this.failLogin} `);
      const verifier = input.stdin?.match(/SCRAM-SHA-256\$4096:[^']+/)?.[0] ?? "";
      return { exitCode: failing ? 3 : 0, stdout: "", stderr: failing ? this.failStderr.replace("{verifier}", verifier) : "" };
    }
    // The fake child prints each login URL and, separately, its bare password and the verifier it saw.
    const urls = Object.entries(input.env).filter(([key]) => key.startsWith("ATLAS_LOGIN_")).map(([, value]) => value ?? "");
    const passwords = urls.map((url) => decodeURIComponent(new URL(url).password));
    const verifiers = this.calls.flatMap((call) => call.stdin?.match(/SCRAM-SHA-256\$4096:[^']+/g) ?? []);
    return { exitCode: 0, stdout: [...urls, ...passwords].join(" "), stderr: verifiers.join(" ") };
  }
}

function setup(brokenRef = "", forgetfulRef = "") {
  const process = new Process();
  const stored = new Map<string, string>();
  const executor = new LiveSupabaseExecutor({
    process,
    passwordVault: {
      async put(reference, value) {
        if (reference === brokenRef) throw new Error("keychain locked");
        if (reference !== forgetfulRef) stored.set(reference, value);
      },
      async get(reference) { return stored.get(reference) ?? ""; }
    }
  });
  return { executor, process, stored, repository: mkdtempSync(join(tmpdir(), "supadrum-personal-logins-")) };
}

const provisioning = (process: Process, login: string) =>
  process.calls.find((call) => call.argv[0] === "psql" && call.stdin?.includes(`create role supadrum_atlas_${login} `));

describe("personal database logins", () => {
  test("recreates each selected login as a member of only its own role, from a SCRAM verifier", async () => {
    const { executor, process, stored, repository } = setup();
    await executor.execute(job, project(repository), {} as never);
    const sql = provisioning(process, costOwner)?.stdin ?? "";
    expect(sql).toContain(`drop role if exists supadrum_atlas_${costOwner};`);
    expect(sql).toContain(`grant atlas_cost_owner to supadrum_atlas_${costOwner};`);
    expect(sql).not.toContain("grant atlas_session_operator");
    expect(sql.match(/^grant /gm)).toHaveLength(1);
    expect(sql).toMatch(/password 'SCRAM-SHA-256\$4096:/);
    expect(sql).not.toContain(stored.get("vault://tests/local/cost-owner"));
    expect(provisioning(process, operator)?.stdin).toContain(`grant atlas_session_operator to supadrum_atlas_${operator};`);
  });

  test("gives the child one URL per selected login and redacts every one of them", async () => {
    const { executor, process, stored, repository } = setup();
    const result = await executor.execute(job, project(repository), {} as never);
    const child = process.calls.at(-1)!;
    const url = new URL(child.env.ATLAS_LOGIN_COST_OWNER_PAOLOBIANCALANA_DATABASE_URL ?? "");
    expect(url.username).toBe(`supadrum_atlas_${costOwner}`);
    expect(decodeURIComponent(url.password)).toBe(stored.get("vault://tests/local/cost-owner"));
    expect(new URL(child.env.ATLAS_LOGIN_OPERATOR_PAOLOBIANCALANA_DATABASE_URL ?? "").username)
      .toBe(`supadrum_atlas_${operator}`);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(stored.get("vault://tests/local/cost-owner"));
    expect(serialized).not.toContain(stored.get("vault://tests/local/operator"));
    expect(serialized).not.toContain("supadrum_atlas_cost_owner_paolobiancalana:");
    expect(serialized).not.toContain("SCRAM-SHA-256");
    expect(result.output).toMatchObject({ stderr: expect.stringContaining("[REDACTED]") });
  });

  test("records which person and role each provisioned login stands for", async () => {
    const { executor, repository } = setup();
    const result = await executor.execute(job, project(repository), {} as never);
    expect(result.verification).toMatchObject({
      database_logins: [
        { login: `supadrum_atlas_${costOwner}`, role: "atlas_cost_owner", person: "paolobiancalana" },
        { login: `supadrum_atlas_${operator}`, role: "atlas_session_operator", person: "paolobiancalana" }
      ]
    });
  });

  test("provisions only the logins the script selects", async () => {
    const { executor, process, repository } = setup();
    await executor.execute(job, project(repository, [operator]), {} as never);
    expect(provisioning(process, costOwner)).toBeUndefined();
    expect(process.calls.at(-1)!.env.ATLAS_LOGIN_COST_OWNER_PAOLOBIANCALANA_DATABASE_URL).toBeUndefined();
  });

  test("a failed login guard disables that login, names the failed check and never starts the tests", async () => {
    const { executor, process, repository } = setup();
    process.failLogin = operator;
    process.failStderr = "psql:<stdin>:40: ERROR:  Personal login can execute a function of atlas_cost_owner\n";
    await expect(executor.execute(job, project(repository), {} as never)).rejects.toThrow(
      `Personal login provisioning failed for supadrum_atlas_${operator} with exit code 3: ` +
      "psql:<stdin>:40: ERROR:  Personal login can execute a function of atlas_cost_owner");
    expect(process.calls.at(-1)?.stdin).toContain(`alter role supadrum_atlas_${operator} nologin`);
    expect(process.calls.every((call) => call.argv[0] !== "npm")).toBe(true);
  });

  test("a login that could not be disabled is named as possibly still able to log in", async () => {
    const { executor, process, repository } = setup();
    process.failLogin = operator;
    process.failDisable = true;
    process.failStderr = "ERROR:  atlas_session_operator has a member that is not a registered personal login\n";
    const failure = await executor.execute(job, project(repository), {} as never).catch((error: Error) => error);
    expect(String(failure)).toContain(`disabling supadrum_atlas_${operator} also failed, it may still log in`);
    expect(process.calls.every((call) => call.argv[0] !== "npm")).toBe(true);
  });

  test("the failure reason never carries the verifier psql may echo back", async () => {
    const { executor, process, repository } = setup();
    process.failLogin = costOwner;
    process.failStderr = "ERROR:  syntax error\nLINE 1: password 'SCRAM-SHA-256$4096:echoed'\n";
    const failure = await executor.execute(job, project(repository), {} as never).catch((error: Error) => error);
    expect(String(failure)).toContain("ERROR:  syntax error");
    process.failStderr = "ERROR:  bad verifier {verifier}\n";
    const leaked = await executor.execute(job, project(repository), {} as never).catch((error: Error) => error);
    expect(String(leaked)).toContain("ERROR:  bad verifier [REDACTED]");
    expect(String(leaked)).not.toContain("SCRAM-SHA-256");
  });

  test("a vault failure on a later login stops before the tests", async () => {
    const { executor, process, repository } = setup("vault://tests/local/operator");
    await expect(executor.execute(job, project(repository), {} as never))
      .rejects.toThrow("Personal login password vault is unavailable");
    expect(provisioning(process, operator)).toBeUndefined();
    expect(process.calls.every((call) => call.argv[0] !== "npm")).toBe(true);
  });

  test("a vault that does not keep the password stops before provisioning that login", async () => {
    const { executor, process, repository } = setup("", "vault://tests/local/cost-owner");
    await expect(executor.execute(job, project(repository), {} as never))
      .rejects.toThrow("Personal login password vault is unavailable");
    expect(provisioning(process, costOwner)).toBeUndefined();
  });

  test("each role's guard knows every registered login of that role, and only those", async () => {
    const { executor, process, repository } = setup();
    const config = project(repository, [costOwner]);
    const logins = { ...config.database_logins!,
      cost_owner_giulia: { role: "atlas_cost_owner" as const, person: "giulia", password_ref: "vault://tests/local/giulia" } };
    await executor.execute(job, { ...config, database_logins: logins }, {} as never);
    const sql = provisioning(process, costOwner)?.stdin ?? "";
    expect(sql).toContain(`array['supadrum_atlas_${costOwner}', 'supadrum_atlas_cost_owner_giulia']::text[]`);
  });

  // Names only: the behaviour of each check is proved on PostgreSQL in personal-login-guard.pg.test.ts.
  test("the provisioning SQL names every check of the guard", () => {
    const sql = personalLoginProvisionSql("supadrum_atlas_x", "atlas_cost_owner", "SCRAM-SHA-256$4096:x", ["supadrum_atlas_x"]);
    const roleCheck = sql.slice(0, sql.indexOf("drop role if exists"));
    for (const attribute of ["rolcanlogin", "rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"]) {
      expect(roleCheck).toContain(attribute);
    }
    expect(roleCheck).toContain("pg_auth_members where member = role_oid");
    const guard = sql.slice(sql.indexOf("grant atlas_cost_owner"));
    expect(guard).toContain("a.grantee = 0");
    expect(guard).toContain("has_function_privilege('atlas_session_writer', p.oid, 'EXECUTE')");
    expect(guard).toContain("has_any_column_privilege('supadrum_atlas_x'");
  });
});

describe("personal login registration", () => {
  const write = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "supadrum-logins-config-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, `version: 1\nchambers:\n  local:\n    target: local\n${body}projects:\n  atlas: {repo: ${dir}, chamber: local, capabilities: [adapter-tests], mode: live}\n`);
    return file;
  };
  const personas = "personas: {student: c0470000-0000-4000-8000-1000000000a1, staff: c0470000-0000-4000-8000-1000000000a3, outsider: c0470000-0000-4000-8000-1000000000b1}";
  const script = (logins: string) =>
    `    adapter_tests:\n      reconciler: {npm_script: test:reconciler, writer_password_ref: vault://atlas/local/writer, database_logins: [${logins}], ${personas}}\n`;
  const login = (name: string, role: string, person: string, ref: string) =>
    `      ${name}: {role: ${role}, person: ${person}, password_ref: ${ref}}\n`;

  test("loads a person's login for each role and a script that selects them", () => {
    const config = loadConfig(write(`    database_logins:\n${login("cost_owner_paolo", "atlas_cost_owner", "paolo", "vault://a/c")}${login("operator_paolo", "atlas_session_operator", "paolo", "vault://a/o")}${script("cost_owner_paolo, operator_paolo")}`));
    expect(config.projects.atlas?.database_logins?.operator_paolo).toMatchObject({ role: "atlas_session_operator", person: "paolo" });
  });

  test("refuses two logins for the same person in the same role", () => {
    expect(() => loadConfig(write(`    database_logins:\n${login("owner_paolo", "atlas_cost_owner", "paolo", "vault://a/1")}${login("cost_paolo", "atlas_cost_owner", "paolo", "vault://a/2")}`)))
      .toThrow(/one login per person and role/i);
  });

  test("refuses a role other than the two human roles", () => {
    expect(() => loadConfig(write(`    database_logins:\n${login("writer_paolo", "atlas_session_writer", "paolo", "vault://a/w")}`))).toThrow();
  });

  test("refuses a password reference shared with another login or with the writer", () => {
    expect(() => loadConfig(write(`    database_logins:\n${login("owner_paolo", "atlas_cost_owner", "paolo", "vault://a/same")}${login("operator_paolo", "atlas_session_operator", "paolo", "vault://a/same")}`)))
      .toThrow(/shared/i);
    expect(() => loadConfig(write(`    database_logins:\n${login("owner_paolo", "atlas_cost_owner", "paolo", "vault://atlas/local/writer")}${script("owner_paolo")}`)))
      .toThrow(/shared/i);
  });

  test("refuses a script that selects an unregistered login, or one login twice", () => {
    expect(() => loadConfig(write(script("ghost_paolo")))).toThrow(/not registered: ghost_paolo/);
    expect(() => loadConfig(write(`    database_logins:\n${login("owner_paolo", "atlas_cost_owner", "paolo", "vault://a/o")}${script("owner_paolo, owner_paolo")}`)))
      .toThrow(/duplicate adapter test database login/i);
  });

  test("refuses a login name that does not end with its person", () => {
    expect(() => loadConfig(write(`    database_logins:\n${login("writer", "atlas_cost_owner", "paolo", "vault://a/w")}`)))
      .toThrow(/must end with _<person>/);
    expect(() => loadConfig(write(`    database_logins:\n${login("owner_paolo", "atlas_cost_owner", "giulia", "vault://a/w")}`)))
      .toThrow(/must end with _<person>/);
    expect(loadConfig(write(`    database_logins:\n${login("owner_anna_maria", "atlas_cost_owner", "anna-maria", "vault://a/w")}`))
      .projects.atlas?.database_logins?.owner_anna_maria).toBeDefined();
  });

  test("refuses persons one of which ends with another, so the login name names one person", () => {
    expect(() => loadConfig(write(`    database_logins:\n${login("owner_maria", "atlas_cost_owner", "maria", "vault://a/1")}${login("operator_anna_maria", "atlas_session_operator", "anna-maria", "vault://a/2")}`)))
      .toThrow(/must not end with one another/);
  });

  test("refuses a password reference shared with a local auth account or a remote credential", () => {
    expect(() => loadConfig(write(`    auth_password_accounts:\n      giulia: {user_id: 5eed0000-0000-4000-8000-000000000001, email: g@alfa.test, password_ref: vault://a/auth}\n    database_logins:\n${login("owner_paolo", "atlas_cost_owner", "paolo", "vault://a/auth")}`)))
      .toThrow(/shared/i);
    const dir = mkdtempSync(join(tmpdir(), "supadrum-logins-config-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, `version: 1\nchambers:\n  remote:\n    project_ref: abcdefghijklmnopqrst\n    credentials: {secret_key: vault://r/secret, management_token: vault://r/mgmt, database_access: vault://r/db}\n  local:\n    target: local\n    database_logins:\n${login("owner_paolo", "atlas_cost_owner", "paolo", "vault://r/db")}projects:\n  atlas: {repo: ${dir}, chamber: local, capabilities: [adapter-tests], mode: live}\n`);
    expect(() => loadConfig(file)).toThrow(/shared/i);
  });
});

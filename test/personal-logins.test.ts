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
  async run(input: LiveProcessInput) {
    this.calls.push(input);
    if (input.argv[0] === "git" && input.argv.includes("rev-parse")) return { exitCode: 0, stdout: `${oid}\n${oid}\n`, stderr: "" };
    if (input.argv[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
    if (input.argv.includes("status")) return { exitCode: 0, stdout: JSON.stringify(status), stderr: "" };
    if (input.argv[0] === "psql") {
      const failing = this.failLogin && input.stdin?.includes(`create role supadrum_atlas_${this.failLogin} `);
      return { exitCode: failing ? 3 : 0, stdout: "", stderr: "" };
    }
    const urls = Object.entries(input.env).filter(([key]) => key.startsWith("ATLAS_LOGIN_")).map(([, value]) => value);
    return { exitCode: 0, stdout: urls.join(" "), stderr: "" };
  }
}

function setup() {
  const process = new Process();
  const stored = new Map<string, string>();
  const executor = new LiveSupabaseExecutor({
    process,
    passwordVault: {
      async put(reference, value) { stored.set(reference, value); },
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

  test("a failed login guard never starts the tests", async () => {
    const { executor, process, repository } = setup();
    process.failLogin = operator;
    await expect(executor.execute(job, project(repository), {} as never))
      .rejects.toThrow("Personal login provisioning failed with exit code 3");
    expect(process.calls.every((call) => call.argv[0] !== "npm")).toBe(true);
  });

  test("the guard refuses a privileged or inheriting role, PUBLIC and writer functions, table grants", () => {
    const sql = personalLoginProvisionSql("supadrum_atlas_x", "atlas_cost_owner", "SCRAM-SHA-256$4096:x");
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
    expect(() => loadConfig(write(`    database_logins:\n${login("owner_a", "atlas_cost_owner", "paolo", "vault://a/1")}${login("owner_b", "atlas_cost_owner", "paolo", "vault://a/2")}`)))
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

  test("refuses a script that selects an unregistered login", () => {
    expect(() => loadConfig(write(script("ghost_paolo")))).toThrow(/not registered: ghost_paolo/);
  });
});

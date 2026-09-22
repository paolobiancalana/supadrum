import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ProjectConfig } from "../src/config.js";
import type { Job } from "../src/domain.js";
import {
  LiveSupabaseExecutor,
  type LiveProcess,
  type LiveProcessInput
} from "../src/live-executor.js";
import { AdapterTestFailure, hasCompletedAdapterSetup } from "../src/local-adapter-tests.js";

const oid = "abc123deadbeefabc123deadbeefabc123deadbe";
const jwtSecret = "jwt-secret-canary-32-characters-long";
function apiKey(role: string) {
  const unsigned = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ iss: "supabase", role, exp: 4102444800 })).toString("base64url")
  ].join(".");
  return `${unsigned}.${createHmac("sha256", jwtSecret).update(unsigned).digest("base64url")}`;
}
const anonKey = apiKey("anon");
const localStatus = {
  "API URL": "http://127.0.0.1:54331",
  "DB URL": "postgresql://postgres:admin-canary@127.0.0.1:54332/postgres",
  "anon key": anonKey,
  "JWT secret": jwtSecret
};

function project(repository: string): ProjectConfig {
  return {
    repo: repository,
    chamber: "atlas-local",
    target: "local",
    project_ref: "",
    credentials: { secret_key: "", management_token: "", database_access: "" },
    capabilities: ["adapter-tests"],
    adapter_tests: {
      sessions: {
        npm_script: "test:adapter",
        writer_password_ref: "vault://tests/local/writer",
        personas: {
          student: "c0470000-0000-4000-8000-1000000000a1",
          staff: "c0470000-0000-4000-8000-1000000000a3",
          outsider: "c0470000-0000-4000-8000-1000000000b1"
        }
      }
    },
    mode: "live",
    migrations: "consumer",
    migration_driver: "supabase"
  };
}

function job(script = "sessions"): Job {
  return {
    id: "job-1", project: "atlas", operation: "tests.run",
    payload: { script }, repo_sha: "abc123", idempotency_key: "atlas:test",
    capability: "adapter-tests", requires_approval: true, session_id: null,
    status: "running", created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z", lease_expires_at: null,
    approved_at: null, approved_by: null, result: null, error: null
  };
}

class RecordingProcess implements LiveProcess {
  readonly calls: LiveProcessInput[] = [];
  dirty = false;
  testExit = 0;
  directGrant = false;
  verifier = "";
  status = localStatus;
  committedFixture = "select 1;\n";

  async run(input: LiveProcessInput) {
    this.calls.push(input);
    if (input.argv[0] === "git" && input.argv.includes("rev-parse")) {
      return { exitCode: 0, stdout: `${input.argv.includes("def456^{commit}") ? "def456deadbeefdef456deadbeefdef456deadbe" : oid}\n${oid}\n`, stderr: "" };
    }
    if (input.argv[0] === "git" && input.argv.includes("status")) {
      return { exitCode: 0, stdout: this.dirty ? " M package.json\n" : "", stderr: "" };
    }
    if (input.argv[0] === "git" && input.argv.includes("show")) {
      return { exitCode: 0, stdout: this.committedFixture, stderr: "" };
    }
    if (input.argv.includes("status")) {
      return { exitCode: 0, stdout: JSON.stringify(this.status), stderr: "" };
    }
    if (input.argv[0] === "psql") {
      this.verifier = input.stdin?.match(/SCRAM-SHA-256\$4096:[^']+/)?.[0] ?? "";
      if (this.directGrant && input.stdin?.includes("drop role if exists supadrum_atlas_writer;")) {
        return { exitCode: 3, stdout: "", stderr: "role has privileges on public.learning_outcomes" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return {
      exitCode: this.testExit,
      stdout: `${input.env.ATLAS_WRITER_DATABASE_URL} ${input.env.ATLAS_STUDENT_JWT} ${this.verifier}`,
      stderr: `failed: ${anonKey}`
    };
  }
}

function setup() {
  const process = new RecordingProcess();
  const stored = new Map<string, string>();
  const executor = new LiveSupabaseExecutor({
    process,
    passwordVault: {
      async put(reference, value) { stored.set(reference, value); },
      async get(reference) { return stored.get(reference) ?? ""; }
    }
  });
  const repository = mkdtempSync(join(tmpdir(), "supadrum-adapter-tests-"));
  return { executor, process, stored, repository };
}

describe("local adapter tests", () => {
  test("reapplies the pinned fixture on the current local stack before the test script", async () => {
    const { executor, process, repository } = setup();
    const fixture = "database/supabase/fixtures/contract.sql";
    mkdirSync(join(repository, "database/supabase/fixtures"), { recursive: true });
    writeFileSync(join(repository, fixture), process.committedFixture);
    const config = project(repository);
    config.adapter_tests!.sessions!.setup_sql_path = fixture;
    await executor.execute(job(), config, {} as never);
    const fixtureRun = process.calls.findIndex((call) => call.argv[0] === "psql" &&
      call.argv.includes("--file") && call.argv.includes(join(repository, fixture)));
    const scriptRun = process.calls.findIndex((call) => call.argv[0] === "npm");
    expect(fixtureRun).toBeGreaterThanOrEqual(0);
    expect(scriptRun).toBeGreaterThan(fixtureRun);
  });

  test("rejects a completed setup whose digest is not the fixture in the pinned commit", () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-setup-binding-"));
    const fixture = "database/supabase/fixtures/contract.sql";
    mkdirSync(join(repository, "database/supabase/fixtures"), { recursive: true });
    execFileSync("git", ["init", "-q", repository]);
    writeFileSync(join(repository, fixture), "select 'committed';\n");
    execFileSync("git", ["-C", repository, "add", fixture]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
    const sha = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const edited = "select 'uncommitted';\n";
    writeFileSync(join(repository, fixture), edited);
    const setupJob: Job = {
      ...job(), id: "setup", operation: "sql.execute", status: "completed", repo_sha: sha,
      payload: { path: fixture, digest: createHash("sha256").update(edited).digest("hex") },
      result: { output: { exit_code: 0 }, verification: { repo_sha_verified: true } }
    };
    const config = project(repository);
    config.adapter_tests!.sessions!.setup_sql_path = fixture;
    expect(hasCompletedAdapterSetup(() => setupJob, config, {
      project: "atlas", repo_sha: sha, payload: { script: "sessions", setup_job_id: "setup" }
    })).toBe(false);
  });

  test("writer provisioning checks column grants as well as table grants", () => {
    const { executor, process, repository } = setup();
    return executor.execute(job(), project(repository), {} as never).then(() => {
      const sql = process.calls.find((call) => call.argv[0] === "psql")?.stdin;
      expect(sql).toContain("has_any_column_privilege('supadrum_atlas_writer'");
    });
  });

  test("writer provisioning refuses a privileged group role before granting membership", async () => {
    const { executor, process, repository } = setup();
    await executor.execute(job(), project(repository), {} as never);
    const sql = process.calls.find((call) => call.argv[0] === "psql")?.stdin ?? "";
    const roleCheck = sql.slice(0, sql.indexOf("drop role if exists"));
    expect(roleCheck).toContain("rolbypassrls");
    expect(roleCheck).toContain("rolsuper");
    expect(roleCheck).toContain("rolcreaterole");
    expect(roleCheck).toContain("rolcreatedb");
    expect(roleCheck).toContain("rolreplication");
  });

  test("rejects remote chambers and unregistered scripts before starting tests", async () => {
    const { executor, process, repository } = setup();
    await expect(executor.execute(job(), { ...project(repository), target: "remote" }, {} as never))
      .rejects.toThrow(/only.*local/i);
    await expect(executor.execute(job("unknown"), project(repository), {} as never))
      .rejects.toThrow(/not registered/i);
    await expect(executor.execute(job("constructor"), project(repository), {} as never))
      .rejects.toThrow(/not registered/i);
    expect(process.calls).toEqual([]);
  });

  test("rejects a dirty checkout before inspecting the stack or vault", async () => {
    const { executor, process, stored, repository } = setup();
    process.dirty = true;
    await expect(executor.execute(job(), project(repository), {} as never))
      .rejects.toThrow(/clean checkout/i);
    expect(process.calls.map((call) => call.argv[0])).toEqual(["git", "git"]);
    expect(stored.size).toBe(0);
  });

  test("rejects a mismatched commit before stack inspection", async () => {
    const { executor, process, repository } = setup();
    await expect(executor.execute({ ...job(), repo_sha: "def456" }, project(repository), {} as never))
      .rejects.toThrow(/repository SHA mismatch/i);
    expect(process.calls).toHaveLength(1);
  });

  test("runs the pinned script with only scoped credentials and redacts output", async () => {
    const { executor, process, stored, repository } = setup();
    const result = await executor.execute(job(), project(repository), {} as never);
    const child = process.calls.at(-1);
    expect(child?.argv).toEqual(["npm", "run", "test:adapter"]);
    expect(child?.cwd).toBe(repository);
    expect(child?.env.ATLAS_WRITER_DATABASE_URL).toMatch(/^postgresql:\/\/supadrum_atlas_writer:/);
    expect(child?.env.ATLAS_DATA_API_URL).toBe("http://127.0.0.1:54331");
    expect(child?.env.ATLAS_ANON_KEY).toBe(anonKey);
    expect(child?.env.ATLAS_STUDENT_JWT).toMatch(/^eyJ/);
    expect(child?.env.ATLAS_STAFF_JWT).toMatch(/^eyJ/);
    expect(child?.env.ATLAS_OUTSIDER_JWT).toMatch(/^eyJ/);
    const studentClaims = JSON.parse(Buffer.from(
      child?.env.ATLAS_STUDENT_JWT?.split(".")[1] ?? "", "base64url"
    ).toString()) as Record<string, unknown>;
    expect(studentClaims).toMatchObject({
      sub: "c0470000-0000-4000-8000-1000000000a1",
      role: "authenticated"
    });
    expect(child?.env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
    expect(child?.env.PGPASSWORD).toBeUndefined();
    expect(stored.get("vault://tests/local/writer")).toBeTruthy();
    const provisioning = process.calls.find((call) => call.argv[0] === "psql");
    expect(provisioning?.stdin).toContain("drop role if exists supadrum_atlas_writer;");
    expect(provisioning?.stdin).toContain("grant atlas_session_writer to supadrum_atlas_writer;");
    expect(provisioning?.stdin).toContain("has_function_privilege('supadrum_atlas_writer'");
    expect(provisioning?.stdin).toContain("has_table_privilege('supadrum_atlas_writer'");
    expect(provisioning?.stdin).not.toContain(stored.get("vault://tests/local/writer"));
    expect(JSON.stringify(result)).not.toContain(anonKey);
    expect(JSON.stringify(result)).not.toContain("jwt-secret-canary");
    expect(JSON.stringify(result)).not.toContain("eyJ");
    expect(JSON.stringify(result)).not.toContain("SCRAM-SHA-256");
    expect(result.output).toMatchObject({ exit_code: 0 });
  });

  test("preserves a failed script exit code and redacted streams", async () => {
    const { executor, process, repository } = setup();
    process.testExit = 7;
    let failure: unknown;
    try {
      await executor.execute(job(), project(repository), {} as never);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AdapterTestFailure);
    const result = (failure as AdapterTestFailure).result;
    expect(result.output).toMatchObject({ exit_code: 7, stderr: "failed: [REDACTED]" });
    expect(JSON.stringify(result)).not.toContain(anonKey);
    expect(JSON.stringify(result)).not.toContain("eyJ");
  });

  test("refuses an API URL outside loopback before vault or script", async () => {
    const { executor, process, stored, repository } = setup();
    process.status = { ...localStatus, "API URL": "https://remote.example.test" };
    await expect(executor.execute(job(), project(repository), {} as never))
      .rejects.toThrow(/loopback/i);
    expect(stored.size).toBe(0);
    expect(process.calls.every((call) => call.argv[0] !== "npm")).toBe(true);
  });

  test("refuses a service-role key mislabeled as anon", async () => {
    const { executor, process, stored, repository } = setup();
    process.status = { ...localStatus, "anon key": apiKey("service_role") };
    await expect(executor.execute(job(), project(repository), {} as never))
      .rejects.toThrow(/anon key/i);
    expect(stored.size).toBe(0);
  });

  test("refuses a database host with a loopback-looking remote name", async () => {
    const { executor, process, stored, repository } = setup();
    process.status = { ...localStatus,
      "DB URL": "postgresql://postgres:admin-canary@127.attacker.test:5432/postgres" };
    await expect(executor.execute(job(), project(repository), {} as never))
      .rejects.toThrow(/loopback/i);
    expect(stored.size).toBe(0);
  });

  test("a pre-existing direct table grant blocks role replacement and never starts tests", async () => {
    const { executor, process, stored, repository } = setup();
    process.directGrant = true;
    await expect(executor.execute(job(), project(repository), {} as never))
      .rejects.toThrow("Writer login provisioning failed with exit code 3");
    expect(process.calls.every((call) => call.argv[0] !== "npm")).toBe(true);
    const password = stored.get("vault://tests/local/writer");
    expect(password).toBeTruthy();
    expect(process.calls.find((call) => call.argv[0] === "psql")?.stdin).not.toContain(password);
  });
});

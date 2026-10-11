import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ProjectConfig } from "../src/config.js";
import type { Job } from "../src/domain.js";
import {
  LiveSupabaseExecutor,
  type LiveProcess,
  type LiveProcessInput,
  type LiveProcessResult
} from "../src/live-executor.js";
import { PgtapRunFailure, type PgtapReason } from "../src/pgtap-reasons.js";

const TREE = "0123456789abcdef0123456789abcdef01234567";
const PROBE_TAG = "public.ecr.aws/supabase/postgres:17.6.1.011";
const DB_IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.054";
const STACK = "supadrum-tmp-atlas";
const TREE_CONFIG = [
  'project_id = "atlas"',
  "",
  "[api]",
  "port = 54321",
  "",
  "[db]",
  "port = 54322",
  "shadow_port = 54320",
  "major_version = 17",
  ""
].join("\n");
const TREE_FILES = {
  "supabase/config.toml": TREE_CONFIG,
  "supabase/tests/rls.test.sql": "select plan(1);\n"
};

type Reply = Partial<LiveProcessResult>;
type Override = (argv: readonly string[], process: PgtapProcess) => Reply | undefined;

/** The commands a pgTAP run makes, answered as a healthy host would. */
class PgtapProcess implements LiveProcess {
  readonly calls: LiveProcessInput[] = [];

  constructor(
    readonly override: Override = () => undefined,
    readonly files: Record<string, string> = TREE_FILES
  ) {}

  ran(verb: string): boolean {
    return this.calls.some((call) => call.argv[0] === "supabase" && call.argv[1] === verb);
  }

  async run(input: LiveProcessInput): Promise<LiveProcessResult> {
    this.calls.push(input);
    const reply = this.override(input.argv, this) ?? this.#reply(input.argv);
    return { exitCode: 0, stdout: "", stderr: "", ...reply };
  }

  #reply(argv: readonly string[]): Reply {
    const [command, verb, sub] = argv;
    if (command === "git") {
      if (argv[3] === "cat-file") return { stdout: "tree\n" };
      if (argv[3] === "rev-list") return { stdout: `${TREE}\n` };
      return { exitCode: 1, stderr: `unexpected git ${argv[3]}` };
    }
    if (command === "bash") {
      const destination = String(argv.at(-1));
      for (const [path, content] of Object.entries(this.files)) {
        mkdirSync(dirname(join(destination, path)), { recursive: true });
        writeFileSync(join(destination, path), content);
      }
      return {};
    }
    if (command === "docker") {
      if (verb === "images") return { stdout: `public.ecr.aws/supabase/postgres:<none>\n${PROBE_TAG}\n` };
      if (verb === "image") return sub === "inspect" && argv[3] === PROBE_TAG ? {} : { exitCode: 1 };
      if (verb === "run") {
        return { stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 99999999 1 99999998 1% /\n" };
      }
      if (verb === "inspect") return { stdout: `${DB_IMAGE}\n` };
      return {};
    }
    if (command === "supabase") {
      if (verb === "--version") return { stdout: "2.116.0\n" };
      if (verb === "start") return { stdout: "Started supabase local development setup.\n" };
      if (verb === "test") {
        const workdir = String(argv[argv.indexOf("--workdir") + 1]);
        const port = /\[db\]\nport = (\d+)/.exec(readFileSync(join(workdir, "supabase", "config.toml"), "utf8"))?.[1];
        return {
          stdout: `Connecting to postgresql://postgres:postgres@127.0.0.1:${port}/postgres\n` +
            "1..1\nok 1 - postgres owns the public schema\n"
        };
      }
    }
    return { exitCode: 1, stderr: `unexpected ${argv.join(" ")}` };
  }
}

function pgtapJob(): Job {
  return {
    id: "job-1",
    project: "atlas",
    operation: "pgtap.run",
    payload: {},
    repo_sha: TREE,
    idempotency_key: `atlas:${TREE}:pgtap.run`,
    capability: "pgtap",
    requires_approval: false,
    session_id: null,
    status: "running",
    created_at: "2026-10-11T10:00:00.000Z",
    updated_at: "2026-10-11T10:00:00.000Z",
    lease_expires_at: null,
    approved_at: null,
    approved_by: null,
    result: null,
    error: null
  };
}

function pgtapProject(repository: string, pgtap: Record<string, unknown> = {}): ProjectConfig {
  return {
    repo: repository,
    chamber: "atlas",
    target: "local",
    project_ref: "atlas-local",
    credentials: {
      secret_key: "vault://supabase/atlas/secret",
      management_token: "vault://supabase/atlas/management",
      database_access: "vault://supabase/atlas/postgres"
    },
    capabilities: ["pgtap"],
    mode: "live",
    migrations: "owner",
    migration_driver: "supabase",
    pgtap: { tests_path: "supabase/tests", start_timeout_ms: 300_000, test_timeout_ms: 120_000, ...pgtap }
  } as ProjectConfig;
}

const credentials = {
  secret_key: "secret-canary",
  management_token: "management-canary",
  database_access: "postgresql://postgres:db-canary@db.example.test:5432/postgres"
};

function setup(override?: Override, files?: Record<string, string>, pgtap?: Record<string, unknown>) {
  const repository = mkdtempSync(join(tmpdir(), "supadrum-pgtap-repo-"));
  const cacheRoot = mkdtempSync(join(tmpdir(), "supadrum-pgtap-cache-"));
  const process = new PgtapProcess(override, files);
  const executor = new LiveSupabaseExecutor({ process, cacheRoot });
  const run = () => executor.execute(pgtapJob(), pgtapProject(repository, pgtap), credentials);
  return { process, cacheRoot, run };
}

async function failure(run: () => Promise<unknown>): Promise<PgtapRunFailure> {
  const error = await run().then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PgtapRunFailure);
  return error as PgtapRunFailure;
}

function verification(error: PgtapRunFailure): Record<string, unknown> {
  return error.result.verification as Record<string, unknown>;
}

const is = (argv: readonly string[], ...prefix: string[]) => prefix.every((word, index) => argv[index] === word);
const isCreation = (argv: readonly string[]) =>
  is(argv, "docker", "network", "create") || is(argv, "supabase", "start");
const isCleanupListing = (argv: readonly string[]) =>
  is(argv, "docker", "ps", "-a") && argv.includes(`label=com.supabase.cli.project=${STACK}`);
const timedOut: Reply = { exitCode: 143, timedOut: true };

describe("pgtap.run in the live executor", () => {
  test("runs the four phases in order and reports every field of a green run", async () => {
    const { process, cacheRoot, run } = setup();

    const result = await run();

    const argv = process.calls.map((call) => call.argv);
    const directory = join(cacheRoot, STACK);
    const start = argv.findIndex((args) => is(args, "supabase", "start"));
    const network = argv.findIndex((args) => is(args, "docker", "network", "create"));
    expect(argv[start]).toEqual([
      "supabase", "start", "--workdir", directory, "--network-id", `supabase_network_${STACK}`,
      "-x", "gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor"
    ]);
    expect(argv.find((args) => is(args, "supabase", "test"))).toEqual([
      "supabase", "test", "db", "--workdir", directory, "supabase/tests"
    ]);
    // No creation before every probe and the whole cleanup-before.
    const lastProbe = argv.findIndex((args) => is(args, "docker", "run"));
    const lastCleanupBefore = argv.findLastIndex((args, index) => index < start && is(args, "docker", "network", "ls"));
    expect(network).toBeGreaterThan(lastProbe);
    expect(network).toBeGreaterThan(lastCleanupBefore);
    expect(argv.findIndex(isCreation)).toBe(network);
    // The tree is read by object only, never through the checkout.
    expect(argv.filter((args) => args[0] === "git").map((args) => args[3])).toEqual(["cat-file", "rev-list"]);
    expect(argv.some((args) => args.includes("--db-url") || args.includes("--linked") || args.includes("--project-ref"))).toBe(false);
    // Cleanup-after ran and removed the folder.
    expect(argv.slice(start).some(isCleanupListing)).toBe(true);
    expect(existsSync(directory)).toBe(false);

    expect(result.verification).toEqual({
      target: "local",
      tree_oid: TREE,
      db_image: DB_IMAGE,
      duration_ms: expect.any(Number),
      phases: {
        prepare_ms: expect.any(Number),
        start_ms: expect.any(Number),
        test_ms: expect.any(Number),
        cleanup_ms: expect.any(Number)
      },
      reason: null
    });
    // Only the test output: a start that succeeded leaves no trace in it.
    expect(result.output).toEqual({ exit_code: 0, stdout: expect.any(String), stderr: "" });
    expect(JSON.stringify(result.output)).not.toContain("Started supabase");
  });

  test("redacts the disposable database URL and leaves the word postgres in the TAP", async () => {
    const { run } = setup();

    const result = await run();

    const stdout = (result.output as { stdout: string }).stdout;
    expect(stdout).toBe("Connecting to [REDACTED]\n1..1\nok 1 - postgres owns the public schema\n");
  });

  test("rewrites the extracted config before start, under the disposable project id", async () => {
    const { process, run } = setup((argv) => {
      if (!is(argv, "supabase", "start")) return undefined;
      const config = readFileSync(join(String(argv[3]), "supabase", "config.toml"), "utf8");
      return config.includes(`project_id = "${STACK}"`) && !config.includes("54322") ? {} : { exitCode: 9 };
    });

    await run();
    expect(process.ran("test")).toBe(true);
  });

  test("reads the start and test caps from the chamber, and fixes prepare and cleanup at 60 s", async () => {
    const { process, run } = setup(undefined, undefined, {
      start_timeout_ms: 7_000,
      test_timeout_ms: 3_000,
      prepare_timeout_ms: 1,
      cleanup_timeout_ms: 1
    });

    await run();

    const argv = process.calls.map((call) => call.argv);
    const start = argv.findIndex((args) => is(args, "supabase", "start"));
    const test = argv.findIndex((args) => is(args, "supabase", "test"));
    const caps = process.calls.map((call) => call.timeoutMs ?? 0);
    const within = (cap: number, values: number[]) =>
      values.length > 0 && values.every((value) => value <= cap && value > cap - 1_000);
    expect(within(60_000, caps.slice(0, start))).toBe(true);
    expect(within(7_000, caps.slice(start, test))).toBe(true);
    expect(within(3_000, [caps[test] ?? 0])).toBe(true);
    expect(within(60_000, caps.slice(test + 1))).toBe(true);
  });

  test("takes db_image from docker inspect of the stack's db container", async () => {
    const { process, run } = setup();

    const result = await run();

    expect(process.calls.map((call) => call.argv)).toContainEqual(
      ["docker", "inspect", "--format", "{{.Config.Image}}", `supabase_db_${STACK}`]
    );
    expect((result.verification as { db_image: string }).db_image).toBe(DB_IMAGE);
  });

  test.each<[string, PgtapReason, Override, Record<string, string>?]>([
    ["a commit instead of a tree", "tree_invalid", (argv) => argv[3] === "cat-file" ? { stdout: "commit\n" } : undefined],
    ["missing objects", "tree_incomplete", (argv) => argv[3] === "rev-list" ? { exitCode: 128 } : undefined],
    ["a failed extraction", "extraction_failed", (argv) => argv[0] === "bash" ? { exitCode: 2 } : undefined],
    ["Docker down", "docker_unreachable", (argv) => is(argv, "docker", "info") ? { exitCode: 1 } : undefined],
    ["no Supabase CLI", "supabase_cli_missing", (argv) => is(argv, "supabase", "--version") ? { exitCode: 127 } : undefined],
    ["an old Supabase CLI", "supabase_cli_too_old", (argv) => is(argv, "supabase", "--version") ? { stdout: "2.115.9\n" } : undefined],
    ["no local postgres image", "no_probe_image", (argv) => is(argv, "docker", "images") ? { stdout: "" } : undefined],
    ["a failed df", "space_probe_failed", (argv) => is(argv, "docker", "run") ? { exitCode: 125 } : undefined],
    ["a full disk", "insufficient_space", (argv) => is(argv, "docker", "run")
      ? { stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 9 8 1 99% /\n" }
      : undefined],
    ["a residue before the run", "cleanup_before_failed", (argv, process) =>
      !process.ran("--version") || !is(argv, "docker", "volume", "ls") ? undefined : { stdout: `supabase_db_${STACK}\n` }],
    ["a tree without tests_path", "tests_path_missing", () => undefined, { "supabase/config.toml": TREE_CONFIG }],
    ["a reserved project_id", "reserved_project_id", () => undefined,
      { ...TREE_FILES, "supabase/config.toml": TREE_CONFIG.replace('"atlas"', '"supadrum-tmp-x"') }],
    ["a port that is not an integer", "original_port_left", () => undefined,
      { ...TREE_FILES, "supabase/config.toml": TREE_CONFIG.replace("port = 54321", 'port = "env(API_PORT)"') }],
    ["a failed start", "start_failed", (argv) => is(argv, "supabase", "start") ? { exitCode: 1 } : undefined],
    ["no db container after start", "start_failed", (argv) => is(argv, "docker", "inspect") ? { exitCode: 1 } : undefined],
    ["a red suite", "tests_failed", (argv) => is(argv, "supabase", "test") ? { exitCode: 3, stdout: "not ok 1\n" } : undefined]
  ])("refuses %s with %s", async (_cause, reason, override, files) => {
    const { run } = setup(override, files);

    const error = await failure(run);

    expect(error.reason).toBe(reason);
    expect(verification(error).reason).toBe(reason);
  });

  test.each<[string, Override]>([
    // `docker info` is swallowed by the probe; the kill must still read as a timeout.
    ["prepare", (argv) => is(argv, "docker", "info") ? timedOut : undefined],
    ["start", (argv) => is(argv, "supabase", "start") ? timedOut : undefined],
    ["test", (argv) => is(argv, "supabase", "test") ? timedOut : undefined],
    ["cleanup", (argv, process) => process.ran("test") && is(argv, "docker", "ps") ? timedOut : undefined]
  ])("ends a %s phase that runs out of time as phase_timeout naming the phase", async (phase, override) => {
    const { run } = setup(override);

    const error = await failure(run);

    expect(error.reason).toBe("phase_timeout");
    expect(verification(error)).toMatchObject({ reason: "phase_timeout", phase });
    expect(error.message).toContain(`${phase} phase`);
  });

  test("suggests a retry when start runs out of time", async () => {
    const { run } = setup((argv) => is(argv, "supabase", "start") ? timedOut : undefined);

    expect((await failure(run)).message).toMatch(/Supabase CLI upgrade\? Retry/);
  });

  test("creates nothing when a probe or cleanup-before refuses, and has nothing to clean after", async () => {
    for (const override of [
      ((argv) => is(argv, "docker", "info") ? { exitCode: 1 } : undefined) satisfies Override,
      ((argv) => is(argv, "supabase", "--version") ? { stdout: "2.0.0\n" } : undefined) satisfies Override,
      ((argv) => is(argv, "docker", "run") ? { exitCode: 125 } : undefined) satisfies Override,
      ((argv) => is(argv, "docker", "network", "ls") ? { exitCode: 1 } : undefined) satisfies Override
    ]) {
      const { process, run } = setup(override);

      await failure(run);

      const argv = process.calls.map((call) => call.argv);
      expect(argv.some(isCreation)).toBe(false);
      expect(argv.some((args) => args[0] === "bash")).toBe(false);
    }
  });

  test.each<[string, Override]>([
    ["start fails", (argv) => is(argv, "supabase", "start") ? { exitCode: 1 } : undefined],
    ["start times out", (argv) => is(argv, "supabase", "start") ? timedOut : undefined],
    ["the suite is red", (argv) => is(argv, "supabase", "test") ? { exitCode: 1 } : undefined]
  ])("cleans up after the run when %s", async (_case, override) => {
    const { process, cacheRoot, run } = setup(override);

    await failure(run);

    const argv = process.calls.map((call) => call.argv);
    const start = argv.findIndex((args) => is(args, "supabase", "start"));
    expect(argv.slice(start).some(isCleanupListing)).toBe(true);
    expect(existsSync(join(cacheRoot, STACK))).toBe(false);
  });

  test("reports a residue after the run beside the verdict, not as it", async () => {
    const { run } = setup((argv, process) =>
      process.ran("test") && is(argv, "docker", "ps") && argv.includes(`name=${STACK}`)
        ? { stdout: `supabase_db_${STACK}\n` }
        : undefined);

    const result = await run();

    expect(result.verification).toMatchObject({
      reason: null,
      cleanup_residue: `container supabase_db_${STACK}`
    });
  });

  test("keeps the verdict of a red suite when cleanup also leaves a residue", async () => {
    const { run } = setup((argv, process) => {
      if (is(argv, "supabase", "test")) return { exitCode: 1 };
      return process.ran("test") && is(argv, "docker", "volume", "ls") ? { exitCode: 1 } : undefined;
    });

    const error = await failure(run);

    expect(error.reason).toBe("tests_failed");
    expect(verification(error).cleanup_residue).toMatch(/volumes unverified/);
  });

  test("refuses to rewrite a config.toml that is a symlink, leaving its target untouched", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "supadrum-pgtap-target-")), "victim.toml");
    writeFileSync(target, "untouched\n");
    const { process, run } = setup((argv) => {
      if (argv[0] !== "bash") return undefined;
      const destination = String(argv.at(-1));
      mkdirSync(join(destination, "supabase", "tests"), { recursive: true });
      symlinkSync(target, join(destination, "supabase", "config.toml"));
      return {};
    });

    await expect(run()).rejects.toThrow(/no regular file supabase\/config.toml/);

    expect(readFileSync(target, "utf8")).toBe("untouched\n");
    expect(process.ran("start")).toBe(false);
  });

  test("keeps the start output when start fails, in place of a test output", async () => {
    const { process, run } = setup((argv) =>
      is(argv, "supabase", "start") ? { exitCode: 1, stdout: "pulling\n", stderr: "port is already allocated\n" } : undefined);

    const error = await failure(run);

    expect(error.result.output).toEqual({ exit_code: 1, stdout: "pulling\n", stderr: "port is already allocated\n" });
    expect(process.ran("test")).toBe(false);
  });
});

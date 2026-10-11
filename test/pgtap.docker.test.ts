import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ProjectConfig } from "../src/config.js";
import type { Job } from "../src/domain.js";
import {
  LiveSupabaseExecutor,
  NodeLiveProcess,
  type LiveProcess,
  type LiveProcessInput,
  type LiveProcessResult
} from "../src/live-executor.js";
import { runCommand } from "../src/local-stack.js";
import { PgtapRunFailure } from "../src/pgtap-reasons.js";
import { removeDisposableStack } from "../src/pgtap-stack.js";

// pgtap.run on a real Docker: a disposable Supabase stack is started, `supabase test db` runs
// against it and the stack is removed. It needs Docker, the Supabase CLI (2.116.0 or newer) and
// a local public.ecr.aws/supabase/postgres image, and it is slow the first time (the CLI pulls
// the images it needs). It never runs in `npm test`; run it by hand before closing a change to
// the pgtap code:
//   SUPADRUM_DOCKER_TESTS=1 npx vitest run test/pgtap.docker.test.ts
//
// What it touches: objects labelled com.supabase.cli.project=supadrum-tmp-pgtapfixture,
// =supadrum-tmp-pgtapnb or =pgtapnb. Nothing else; in particular nothing of a stack started by
// hand (its label is its own project id). The teardown below removes by those exact ids only,
// and not through the code under test, so a broken cleanup in src/ cannot hide a leftover.
const ALIAS = "pgtapfixture";
const STACK = `supadrum-tmp-${ALIAS}`;
const LABEL = "com.supabase.cli.project";
const OURS = new Set([STACK, "supadrum-tmp-pgtapnb", "pgtapnb"]);

const CONFIG_TOML = [
  'project_id = "pgtapfixture"',
  "",
  "[api]",
  "port = 55421",
  "",
  "[db]",
  "port = 55422",
  "shadow_port = 55420",
  "major_version = 17",
  ""
].join("\n");
const MIGRATION = "create table public.widgets (id int primary key, name text not null);\n";
const GREEN_TEST = [
  "begin;",
  "select plan(2);",
  "select has_table('public', 'widgets', 'the migration created widgets');",
  "select col_not_null('public', 'widgets', 'name', 'widgets.name is mandatory');",
  "select * from finish();",
  "rollback;",
  ""
].join("\n");
// The same file with one assertion that the migration makes false.
const RED_TEST = GREEN_TEST.replace(
  "select col_not_null('public', 'widgets', 'name', 'widgets.name is mandatory');",
  "select col_is_null('public', 'widgets', 'name', 'widgets.name is optional');"
);

type Kind = "container" | "volume" | "network";
const KINDS: readonly { kind: Kind; list: string[]; format: string; remove: string[] }[] = [
  { kind: "container", list: ["ps", "-a"], format: "{{.Names}}", remove: ["rm", "-f"] },
  { kind: "volume", list: ["volume", "ls"], format: "{{.Name}}", remove: ["volume", "rm", "-f"] },
  { kind: "network", list: ["network", "ls"], format: "{{.Name}}", remove: ["network", "rm"] }
];

function docker(...args: string[]): string {
  const run = spawnSync("docker", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout.trim();
}

function match(filter: string): string[] {
  return KINDS.flatMap(({ kind, list, format }) =>
    docker(...list, "--filter", filter, "--format", format)
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => `${kind} ${name}`)
  ).sort();
}

/** Objects carrying exactly this project id in their label. */
const labelled = (id: string) => match(`label=${LABEL}=${id}`);

/** Objects of the disposable stack `id` by label or by name: the cleanup's definition of a residue. */
const leftovers = (id: string) => [...new Set([...labelled(id), ...match(`name=${id}`)])].sort();

/** Teardown of this file: by exact label, for the ids above only. */
function forceRemove(id: string): void {
  if (!OURS.has(id)) throw new Error(`Refusing to remove ${id}: not an object of this test`);
  for (const { list, format, remove } of KINDS) {
    const names = docker(...list, "--filter", `label=${LABEL}=${id}`, "--format", format)
      .split(/\s+/)
      .filter(Boolean);
    if (names.length > 0) spawnSync("docker", [...remove, ...names], { encoding: "utf8" });
  }
}

function git(repository: string, ...args: string[]): string {
  const run = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout.trim();
}

function write(repository: string, path: string, content: string): void {
  mkdirSync(join(repository, path, ".."), { recursive: true });
  writeFileSync(join(repository, path), content);
}

/** The tree git would commit: everything in the checkout, staged, then `write-tree`. */
function stagedTree(repository: string): string {
  git(repository, "add", "-A");
  return git(repository, "write-tree");
}

function job(tree: string): Job {
  return {
    id: "docker-job",
    project: ALIAS,
    operation: "pgtap.run",
    payload: {},
    repo_sha: tree,
    idempotency_key: `${ALIAS}:${tree}:pgtap.run`,
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

function project(repository: string): ProjectConfig {
  return {
    repo: repository,
    chamber: ALIAS,
    target: "local",
    project_ref: "pgtapfixture-local",
    credentials: {
      secret_key: "vault://supabase/pgtapfixture/secret",
      management_token: "vault://supabase/pgtapfixture/management",
      database_access: "vault://supabase/pgtapfixture/postgres"
    },
    capabilities: ["pgtap"],
    mode: "live",
    migrations: "owner",
    migration_driver: "supabase",
    // Inside the file's 180 s, so the executor's own limit speaks before vitest's: a pull that is
    // too slow is a phase_timeout with its phase named, and the stack is still cleaned.
    pgtap: { tests_path: "supabase/tests", start_timeout_ms: 120_000, test_timeout_ms: 40_000 }
  } as ProjectConfig;
}

// pgtap.run reads no credential; these only fill the parameter.
const credentials = { secret_key: "unused", management_token: "unused", database_access: "unused" };

/**
 * The real process, watched. At the moment `supabase test db` is launched the stack exists, so
 * this is where the test asks Docker what the database image is and which objects there are:
 * after the run the first is gone and the second must be too.
 */
class ObservedProcess implements LiveProcess {
  readonly #real = new NodeLiveProcess();
  dbImage: string | undefined;
  objects: string[] = [];
  folderExisted = false;

  constructor(private readonly cacheRoot: string) {}

  async run(input: LiveProcessInput): Promise<LiveProcessResult> {
    const [command, verb, sub] = input.argv;
    if (command === "supabase" && verb === "test" && sub === "db") {
      this.dbImage = docker("inspect", "--format", "{{.Config.Image}}", `supabase_db_${STACK}`);
      this.objects = leftovers(STACK);
      this.folderExisted = existsSync(join(this.cacheRoot, STACK, "supabase", "migrations"));
    }
    return this.#real.run(input);
  }
}

interface TestOutput {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe.skipIf(!process.env.SUPADRUM_DOCKER_TESTS)("pgtap.run on a real Docker", { timeout: 180_000 }, () => {
  let repository = "";
  // Under $HOME, not tmpdir(): Colima shares $HOME with its VM and not /private/tmp, and the
  // folder is bind-mounted into the containers.
  let cacheRoot = "";
  let greenTree = "";
  let redTree = "";

  beforeAll(() => {
    repository = mkdtempSync(join(tmpdir(), "supadrum-pgtap-docker-repo-"));
    mkdirSync(join(homedir(), ".cache"), { recursive: true });
    cacheRoot = mkdtempSync(join(homedir(), ".cache", "supadrum-pgtap-docker-"));
    git(repository, "init", "-q");
    write(repository, "supabase/config.toml", CONFIG_TOML);
    write(repository, "supabase/migrations/20260101000000_create_widgets.sql", MIGRATION);
    write(repository, "supabase/tests/widgets.test.sql", GREEN_TEST);
    greenTree = stagedTree(repository);
    write(repository, "supabase/tests/widgets.test.sql", RED_TEST);
    redTree = stagedTree(repository);
    expect(redTree).not.toBe(greenTree);
  }, 60_000);

  afterAll(() => {
    for (const id of OURS) forceRemove(id);
    rmSync(repository, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }, 60_000);

  function executor(observed: LiveProcess) {
    return new LiveSupabaseExecutor({ process: observed, cacheRoot });
  }

  /** What a finished run must have removed: stack objects, the folder, and nothing new beside it. */
  function expectNothingLeft(): void {
    expect(leftovers(STACK)).toEqual([]);
    expect(readdirSync(cacheRoot)).toEqual([]);
  }

  function expectStackWasUp(observed: ObservedProcess): void {
    expect(observed.objects).toContain(`container supabase_db_${STACK}`);
    expect(observed.objects).toContain(`network supabase_network_${STACK}`);
    expect(observed.objects.some((object) => object.startsWith("volume "))).toBe(true);
    expect(observed.folderExisted).toBe(true);
  }

  test("a green tree passes, reports the image Docker ran, and leaves nothing behind", async () => {
    const observed = new ObservedProcess(cacheRoot);

    const result = await executor(observed).execute(job(greenTree), project(repository), credentials);

    const output = result.output as TestOutput;
    expect(output.exit_code, output.stderr).toBe(0);
    // pg_prove's own summary of the two assertions of the fixture, not just an exit code.
    expect(output.stdout).toContain("Tests=2");
    expect(output.stdout).toContain("Result: PASS");
    const verification = result.verification as Record<string, unknown>;
    expect(verification.reason).toBeNull();
    expect(verification.tree_oid).toBe(greenTree);
    // The tag Docker reported while the proof ran, not one the test or the config could supply:
    // the fixture pins no image, so only the container can say which one it was.
    expect(observed.dbImage).toMatch(/^\S+:\S+$/);
    expect(verification.db_image).toBe(observed.dbImage);
    expect(verification).not.toHaveProperty("cleanup_residue");
    expectStackWasUp(observed);
    expectNothingLeft();
  });

  test("a red tree fails with tests_failed and a non-zero exit code, and leaves nothing behind", async () => {
    const observed = new ObservedProcess(cacheRoot);

    const error = await executor(observed)
      .execute(job(redTree), project(repository), credentials)
      .then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(PgtapRunFailure);
    const failure = error as PgtapRunFailure;
    expect(failure.reason).toBe("tests_failed");
    const output = failure.result.output as TestOutput;
    expect(output.exit_code).not.toBe(0);
    // The failure is pg_prove's verdict on the one assertion made false, not a failed start or
    // a connection error that would also exit non-zero.
    expect(output.stdout).toContain('Failed test 2: "widgets.name is optional"');
    expect(output.stdout).toContain("Result: FAIL");
    const verification = failure.result.verification as Record<string, unknown>;
    expect(verification.reason).toBe("tests_failed");
    expect(verification.tree_oid).toBe(redTree);
    expect(verification.db_image).toBe(observed.dbImage);
    expect(verification).not.toHaveProperty("cleanup_residue");
    expectStackWasUp(observed);
    expectNothingLeft();
  });

  // The cleanup of #44 against a neighbour it must not touch. The spec says "objects labelled
  // presnap next to supadrum-tmp-presnap", but a stack started by hand under that very project id
  // is running on the machine this is meant to be run on, and a broken cleanup is exactly what
  // this test must be able to catch. So the neighbour is made up: pgtapnb, whose id is, like
  // presnap's, the tail of the disposable id supadrum-tmp-pgtapnb. That is the shape that fools a
  // filter by name or by "contains", and it cannot match anything of a real project.
  test("cleaning a disposable stack removes it and leaves the stack whose id ends its own", async () => {
    const neighbour = "pgtapnb";
    const disposable = "supadrum-tmp-pgtapnb";
    const image = docker("images", "public.ecr.aws/supabase/postgres", "--format", "{{.Repository}}:{{.Tag}}")
      .split(/\s+/)
      .find((tag) => tag && !tag.endsWith(":<none>"));
    if (!image) throw new Error("No local public.ecr.aws/supabase/postgres image to create a container from");
    const folder = join(cacheRoot, disposable);
    try {
      for (const id of [neighbour, disposable]) {
        docker("network", "create", "--label", `${LABEL}=${id}`, `supabase_network_${id}`);
        docker("volume", "create", "--label", `${LABEL}=${id}`, `supabase_db_${id}`);
        docker("create", "--pull=never", "--network", "none", "--label", `${LABEL}=${id}`,
          "--name", `supabase_db_${id}`, image);
      }
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "marker"), "");
      expect(leftovers(disposable)).toHaveLength(3);

      const residue = await removeDisposableStack(disposable, runCommand, cacheRoot);

      expect(residue).toBe("");
      expect(leftovers(disposable)).toEqual([]);
      expect(existsSync(folder)).toBe(false);
      expect(labelled(neighbour)).toEqual([
        `container supabase_db_${neighbour}`,
        `network supabase_network_${neighbour}`,
        `volume supabase_db_${neighbour}`
      ]);
    } finally {
      forceRemove(neighbour);
      forceRemove(disposable);
    }
  });
});

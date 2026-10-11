import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type {
  LiveProcess,
  LiveProcessInput,
  LiveProcessResult
} from "../src/live-executor.js";
import {
  PgtapTreeError,
  extractTree,
  verifyTree,
  type TreeSource
} from "../src/pgtap-tree.js";

const OID = "a".repeat(40);

async function reasonOf(attempt: Promise<unknown>): Promise<unknown> {
  const error = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(PgtapTreeError);
  return error instanceof PgtapTreeError ? error.reason : error;
}

describe("pgtap tree with a recording process", () => {
  class RecordingProcess implements LiveProcess {
    readonly calls: LiveProcessInput[] = [];

    constructor(
      private readonly answer: (argv: readonly string[]) => Partial<LiveProcessResult> = (
        argv
      ) => (argv.includes("cat-file") ? { stdout: "tree\n" } : {})
    ) {}

    async run(input: LiveProcessInput): Promise<LiveProcessResult> {
      this.calls.push(input);
      return { exitCode: 0, stdout: "", stderr: "", ...this.answer(input.argv) };
    }
  }

  function setup(answer?: ConstructorParameters<typeof RecordingProcess>[0]) {
    const process = new RecordingProcess(answer);
    const source: TreeSource = { process, git: "git", repository: "/repo" };
    return { process, source };
  }

  // Exactly these two calls: no rev-parse, status or write-tree.
  test("verification asks git for the type and the completeness of the OID it was given, and nothing else", async () => {
    const { process, source } = setup();
    await verifyTree(source, OID);
    expect(process.calls.map((call) => call.argv)).toEqual([
      ["git", "-C", "/repo", "cat-file", "-t", OID],
      ["git", "-C", "/repo", "rev-list", "--objects", OID]
    ]);
  });

  test.each(["blob", "commit", "tag"])("rejects an OID that is a %s", async (type) => {
    const { process, source } = setup(() => ({ stdout: `${type}\n` }));
    expect(await reasonOf(verifyTree(source, OID))).toBe("tree_invalid");
    expect(process.calls).toHaveLength(1);
  });

  test("rejects an OID that git does not know", async () => {
    const { source } = setup(() => ({ exitCode: 128 }));
    expect(await reasonOf(verifyTree(source, OID))).toBe("tree_invalid");
  });

  test("rejects a tree whose objects are not all present", async () => {
    const { source } = setup((argv) =>
      argv.includes("rev-list") ? { exitCode: 128 } : { stdout: "tree\n" }
    );
    expect(await reasonOf(verifyTree(source, OID))).toBe("tree_incomplete");
  });

  test.each(["HEAD", "main", "abc123", "HEAD^{tree}", "--output=/tmp/x", `${OID}\n`])(
    "rejects %j before running anything: only a full object name is accepted",
    async (name) => {
      const { process, source } = setup();
      expect(await reasonOf(verifyTree(source, name))).toBe("tree_invalid");
      expect(await reasonOf(extractTree(source, name, "/out"))).toBe("tree_invalid");
      expect(process.calls).toEqual([]);
    }
  );

  test("extraction runs git archive with a neutral configuration and passes the paths as parameters", async () => {
    const { process, source } = setup();
    await extractTree(source, OID, "/out");
    const [call] = process.calls;
    const script = call?.argv.join(" ") ?? "";
    expect(script).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(script).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(script).toContain("-c filter.lfs.smudge=");
    expect(script).toContain("-c filter.lfs.required=false");
    expect(script).toContain("archive --format=tar");
    expect(call?.argv.slice(-4)).toEqual(["git", "/repo", OID, "/out"]);
    expect(call?.argv.slice(0, -4).join(" ")).not.toMatch(/\/repo|\/out|a{40}/);
  });

  test("a failed extraction is reported as such", async () => {
    const { source } = setup(() => ({ exitCode: 2, stderr: "tar: No such directory\n" }));
    expect(await reasonOf(extractTree(source, OID, "/out"))).toBe("extraction_failed");
  });
});

// Many git, bash and tar processes per test: slow on a loaded machine.
describe("pgtap tree with real git", { timeout: 30_000 }, () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  // The names carry shell syntax: a command built from them would run it, in
  // the repository folder, and leave an `injected-*` file there.
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "supadrum-pgtap-tree-"));
    roots.push(root);
    const repository = join(root, "repo $(touch injected-repo)");
    const out = join(root, "out; touch injected-out");
    mkdirSync(repository);
    mkdirSync(out);
    git(repository, ["init", "-q"]);
    return { root, repository, out };
  }

  // Test git calls ignore the user's configuration.
  function git(repository: string, args: string[]): string {
    return execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
    }).trim();
  }

  function write(repository: string, name: string, content: string): void {
    writeFileSync(join(repository, name), content);
  }

  // Runs for real, in an environment that also carries `extraEnv`.
  class RealProcess implements LiveProcess {
    constructor(private readonly extraEnv: NodeJS.ProcessEnv = {}) {}

    async run(input: LiveProcessInput): Promise<LiveProcessResult> {
      const [program = "", ...args] = input.argv;
      const result = spawnSync(program, args, {
        cwd: input.cwd,
        env: { ...input.env, ...this.extraEnv },
        encoding: "utf8"
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    }
  }

  function source(repository: string, extraEnv?: NodeJS.ProcessEnv): TreeSource {
    return { process: new RealProcess(extraEnv), git: "git", repository };
  }

  test("extracts what is staged: not HEAD, not the working tree", async () => {
    const { root, repository, out } = setup();
    write(repository, "a.sql", "X\n");
    git(repository, ["add", "a.sql"]);
    git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "x"]);
    write(repository, "a.sql", "Y\n");
    git(repository, ["add", "a.sql"]);
    write(repository, "a.sql", "Z\n");
    write(repository, "b.sql", "B\n");
    const tree = git(repository, ["write-tree"]);
    const head = git(repository, ["rev-parse", "HEAD"]);
    const blob = git(repository, ["rev-parse", ":a.sql"]);
    const statusBefore = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);

    await verifyTree(source(repository), tree);
    await extractTree(source(repository), tree, out);

    expect(readFileSync(join(out, "a.sql"), "utf8")).toBe("Y\n");
    expect(existsSync(join(out, "b.sql"))).toBe(false);
    // Neither the repository nor the disk were touched, and the names did not inject.
    expect(git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(repository, "a.sql"), "utf8")).toBe("Z\n");
    expect([...readdirSync(root), ...readdirSync(repository)].filter((name) => name.startsWith("injected"))).toEqual([]);
    // A commit and a blob are objects, but not trees.
    expect(await reasonOf(verifyTree(source(repository), head))).toBe("tree_invalid");
    expect(await reasonOf(verifyTree(source(repository), blob))).toBe("tree_invalid");
  });

  test("a tree with a missing blob is incomplete", async () => {
    const { repository } = setup();
    write(repository, "a.sql", "A\n");
    write(repository, "b.sql", "B\n");
    git(repository, ["add", "."]);
    const tree = git(repository, ["write-tree"]);
    const blob = git(repository, ["rev-parse", ":b.sql"]);
    rmSync(join(repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    expect(await reasonOf(verifyTree(source(repository), tree))).toBe("tree_incomplete");
  });

  // tar alone would succeed on the empty stream of a failed git archive.
  test("extraction of an object git cannot archive fails", async () => {
    const { repository, out } = setup();
    expect(await reasonOf(extractTree(source(repository), OID, out))).toBe("extraction_failed");
  });

  // `where` is the configuration that holds the filter; the control run first
  // proves the filter does run when archive reads that configuration.
  test.each([
    { where: "global config", filter: "sentinel", variable: "GIT_CONFIG_GLOBAL" },
    { where: "system config", filter: "sentinel", variable: "GIT_CONFIG_SYSTEM" },
    { where: "repository config", filter: "lfs", variable: undefined }
  ])("a smudge filter in the $where does not run", async ({ filter, variable }) => {
    const { root, repository, out } = setup();
    const sentinel = join(root, "smudge-ran");
    write(repository, ".gitattributes", `*.sql filter=${filter}\n`);
    write(repository, "a.sql", "A\n");
    git(repository, ["add", "."]);
    const tree = git(repository, ["write-tree"]);
    const config = variable ? join(root, "gitconfig") : join(repository, ".git", "config");
    git(repository, ["config", "--file", config, `filter.${filter}.smudge`, `touch ${sentinel} && cat`]);
    // As `git lfs install` leaves it: an emptied smudge alone would make git die.
    git(repository, ["config", "--file", config, `filter.${filter}.required`, "true"]);
    const hostile = variable ? { [variable]: config } : {};

    const control: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...hostile };
    delete control.GIT_CONFIG_NOSYSTEM;
    execFileSync("git", ["-C", repository, "archive", "--format=tar", tree], { env: control, stdio: "ignore" });
    expect(existsSync(sentinel)).toBe(true);
    rmSync(sentinel);

    await extractTree(source(repository, hostile), tree, out);
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(join(out, "a.sql"), "utf8")).toBe("A\n");
  });
});

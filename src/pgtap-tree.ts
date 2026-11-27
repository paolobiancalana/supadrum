import type { LiveProcess } from "./live-executor.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Verification and extraction of the git tree that `pgtap.run` tests.
 *
 * Both functions only read objects of the registered repository: they never
 * touch its index, `HEAD` or working tree, and they never resolve names
 * (`rev-parse`) or compute trees (`write-tree`, `status`).
 *
 * Not supported, because extraction is `git archive`:
 * - submodules: a gitlink becomes an empty directory;
 * - git-lfs: pointer files are extracted as they are, never resolved;
 * - `export-ignore` in a `.gitattributes` of the tree: those files are not
 *   extracted.
 */

export type PgtapTreeReason =
  | "tree_invalid"
  | "tree_incomplete"
  | "extraction_failed";

export class PgtapTreeError extends Error {
  constructor(
    readonly reason: PgtapTreeReason,
    message: string
  ) {
    super(message);
    this.name = "PgtapTreeError";
  }
}

export interface TreeSource {
  readonly process: LiveProcess;
  readonly git: string;
  readonly repository: string;
}

// A full object name only: git would also accept branches, prefixes and
// options in the same position.
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const TREE_COMMAND_TIMEOUT_MS = 60_000;

function treeProcessEnvironment(config: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1"
  };
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "TEMP", "TMP"]) {
      if (process.env[name]) environment[name] = process.env[name];
    }
  }
  return environment;
}

function assertFullOid(oid: string): void {
  if (!FULL_OID.test(oid)) {
    throw new PgtapTreeError(
      "tree_invalid",
      "Tree must be a full hexadecimal object name"
    );
  }
}

/** Resolves only if `oid` is a tree and every object under it is present. */
export async function verifyTree(
  source: TreeSource,
  oid: string
): Promise<void> {
  assertFullOid(oid);
  const run = (...args: string[]) =>
    source.process.run({
      argv: [source.git, "-C", source.repository, ...args],
      cwd: source.repository,
      env: { PATH: process.env.PATH }
    });
  const type = await run("cat-file", "-t", oid);
  if (type.exitCode !== 0 || type.stdout.trim() !== "tree") {
    throw new PgtapTreeError("tree_invalid", `${oid} is not a tree`);
  }
  const objects = await run("rev-list", "--objects", oid);
  if (objects.exitCode !== 0) {
    throw new PgtapTreeError(
      "tree_incomplete",
      `Tree ${oid} is missing objects: ${objects.stderr.trim()}`
    );
  }
}

/**
 * Extracts the tree into `destination`, which must already exist; the caller
 * owns its lifecycle. Call `verifyTree` first.
 */
export async function extractTree(
  source: TreeSource,
  oid: string,
  destination: string
): Promise<void> {
  assertFullOid(oid);
  const directory = await mkdtemp(join(tmpdir(), "supadrum-tree-"));
  const archive = join(directory, "tree.tar");
  const config = join(directory, "gitconfig.empty");
  const deadline = Date.now() + TREE_COMMAND_TIMEOUT_MS;
  try {
    await writeFile(config, "", { encoding: "utf8", mode: 0o600 });
    const archived = await source.process.run({
      argv: [
        source.git,
        "-C",
        source.repository,
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.required=false",
        "archive",
        "--format=tar",
        `--output=${archive}`,
        oid
      ],
      cwd: source.repository,
      env: treeProcessEnvironment(config),
      timeoutMs: Math.max(deadline - Date.now(), 1)
    });
    if (archived.exitCode !== 0 || archived.timedOut) {
      throw new PgtapTreeError(
        "extraction_failed",
        `Creating tree archive ${oid} failed with exit code ${archived.exitCode}: ${archived.stderr.trim()}`
      );
    }
    const extracted = await source.process.run({
      argv: ["tar", "-xf", archive, "-C", destination],
      cwd: source.repository,
      env: treeProcessEnvironment(config),
      timeoutMs: Math.max(deadline - Date.now(), 1)
    });
    if (extracted.exitCode !== 0 || extracted.timedOut) {
      throw new PgtapTreeError(
        "extraction_failed",
        `Extracting tree ${oid} failed with exit code ${extracted.exitCode}: ${extracted.stderr.trim()}`
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

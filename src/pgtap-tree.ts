import type { LiveProcess } from "./live-executor.js";

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

// One constant script. The executable, repository, OID and destination reach
// it only as positional parameters, so no path can inject shell syntax. The
// neutral configuration keeps the user's and the system's filters (git-lfs
// smudge, for one) from running in the runner while `git archive` converts
// blobs.
const EXTRACT_SCRIPT =
  'GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 "$1" -C "$2" ' +
  "-c filter.lfs.smudge= -c filter.lfs.required=false " +
  'archive --format=tar "$3" | tar -x -f - -C "$4"';

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
  const result = await source.process.run({
    argv: [
      "bash",
      "-o",
      "pipefail",
      "-c",
      EXTRACT_SCRIPT,
      "bash",
      source.git,
      source.repository,
      oid,
      destination
    ],
    cwd: source.repository,
    env: { PATH: process.env.PATH }
  });
  if (result.exitCode !== 0) {
    throw new PgtapTreeError(
      "extraction_failed",
      `Extracting tree ${oid} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`
    );
  }
}

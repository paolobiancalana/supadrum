import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolves `candidate` under `root`, or returns null when it escapes.
 *
 * The check cannot be only lexical. `resolve` with an absolute second argument
 * drops the first, `../` walks out, and — the one a spelling check can never
 * see — a symlink *inside* the root can point anywhere, so `repo/database`
 * reads as contained while the bytes live in another project entirely.
 * Following it is exactly the confusion the caller asked to prevent, so the
 * real path of the deepest ancestor that exists is what gets compared.
 *
 * Shared rather than written twice: both the SQL/types paths and supabase_dir
 * need it, and the first attempt at this fix applied it to one and not the
 * other.
 */
export function containedPath(root: string, candidate: string): string | null {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, candidate);
  if (escapes(relative(absoluteRoot, absolute))) return null;
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const real = relative(realpathSync(absoluteRoot), realpathSync(ancestor));
  return escapes(real) ? null : absolute;
}

function escapes(path: string): boolean {
  return isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
}

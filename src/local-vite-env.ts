import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function requiredMatch(text: string, pattern: RegExp, label: string): string {
  const value = text.match(pattern)?.[1]?.trim();
  if (!value) throw new Error(`Local Supabase ${label} is unavailable`);
  return value;
}

function isViteProject(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(manifest.dependencies?.vite || manifest.devDependencies?.vite);
  } catch {
    return false;
  }
}

/** Writes the public local-stack values consumed by Vite without logging them. */
export function writeLocalViteEnvironment(
  repository: string,
  statusEnvironment: string,
  supabaseDir = repository
): boolean {
  const config = readFileSync(join(supabaseDir, "supabase", "config.toml"), "utf8");
  const auth = config.split(/^\[auth\]\s*$/m)[1]?.split(/^\[/m)[0];
  const urlMatch = auth?.match(/^external_url\s*=\s*(?:"([^"]+)"|'([^']+)')/m);
  const url = (urlMatch?.[1] ?? urlMatch?.[2])?.trim();
  if (!url) return false;
  const viteRoot = [join(repository, "frontend"), repository].find(isViteProject);
  if (!viteRoot) return false;
  const key = requiredMatch(statusEnvironment, /^ANON_KEY=["']?([^"'\r\n]+)["']?$/m, "anon key");
  const path = join(viteRoot, ".env.development.local");
  let existing = "";
  try { existing = readFileSync(path, "utf8"); } catch { /* first local start */ }
  const kept = existing.split(/\r?\n/)
    .filter((line) => !/^VITE_SUPABASE_(URL|ANON_KEY)=/.test(line));
  const output = [...kept.filter(Boolean),
    `VITE_SUPABASE_URL=${url}`,
    `VITE_SUPABASE_ANON_KEY=${key}`].join("\n");
  writeFileSync(path, `${output}\n`, { mode: 0o600 });
  return true;
}

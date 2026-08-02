import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const TOML_START = "# >>> supadrum managed: start";
const TOML_END = "# <<< supadrum managed: end";
const AGENTS_START = "<!-- supadrum managed: start -->";
const AGENTS_END = "<!-- supadrum managed: end -->";

export interface CodexAgentSetupInput {
  readonly repository: string;
  readonly configPath: string;
  readonly skillSource: string;
  readonly mcpCommand: string;
  readonly mcpArgs?: readonly string[];
  readonly mcpCwd?: string;
}

export interface CodexAgentSetupReport {
  readonly repository: string;
  readonly skillPath: string;
  readonly codexConfigPath: string;
  readonly agentsPath: string;
  readonly restartRequired: true;
}

export interface CodexAgentSetupStatus {
  readonly skill: boolean;
  readonly mcp: boolean;
  readonly instructions: boolean;
  readonly ready: boolean;
}

function atomicWrite(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${path.split("/").at(-1)}.supadrum-${randomUUID()}`
  );
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  let created = false;
  try {
    writeFileSync(temporaryPath, source, {
      encoding: "utf8",
      mode,
      flag: "wx"
    });
    created = true;
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
    created = false;
  } finally {
    if (created) unlinkSync(temporaryPath);
  }
}

function withoutManagedBlock(
  source: string,
  start: string,
  end: string
): string {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) return source;
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex === -1) {
    throw new Error(`Unterminated managed block: ${start}`);
  }
  return (
    source.slice(0, startIndex) +
    source.slice(endIndex + end.length)
  );
}

function appendManagedBlock(source: string, block: string): string {
  const base = source.trimEnd();
  return `${base}${base ? "\n\n" : ""}${block.trim()}\n`;
}

function tableRanges(lines: readonly string[]): ReadonlyArray<{
  readonly start: number;
  readonly end: number;
  readonly header: string;
}> {
  const starts = lines
    .map((line, index) =>
      /^\s*\[[^\]]+\]\s*$/.test(line) ? index : -1
    )
    .filter((index) => index >= 0);
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? lines.length,
    header: lines[start] as string
  }));
}

function withoutExistingSupadrumTables(source: string): string {
  const lines = source.split("\n");
  const removed = new Set<number>();
  for (const range of tableRanges(lines)) {
    if (
      /^\s*\[mcp_servers\.supadrum(?:\.[^\]]+)?\]\s*$/.test(
        range.header
      )
    ) {
      for (let index = range.start; index < range.end; index += 1) {
        removed.add(index);
      }
    }
  }
  return lines
    .filter((_, index) => !removed.has(index))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function disableDirectSupabaseServers(source: string): string {
  const lines = source.split("\n");
  for (const range of [...tableRanges(lines)].reverse()) {
    const match = range.header.match(
      /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/
    );
    if (!match || match[1] === "supadrum") continue;
    const block = lines.slice(range.start, range.end).join("\n");
    const directSupabase =
      match[1] === "supabase" ||
      /https:\/\/mcp\.supabase\.com(?:\/|["'?])/i.test(block);
    if (!directSupabase) continue;
    const enabledIndex = lines
      .slice(range.start + 1, range.end)
      .findIndex((line) => /^\s*enabled\s*=/.test(line));
    if (enabledIndex >= 0) {
      lines[range.start + 1 + enabledIndex] = "enabled = false";
    } else {
      lines.splice(range.start + 1, 0, "enabled = false");
    }
  }
  return lines.join("\n");
}

function tomlBlock(input: {
  readonly configPath: string;
  readonly mcpCommand: string;
  readonly mcpArgs?: readonly string[];
  readonly mcpCwd?: string;
}): string {
  return [
    TOML_START,
    "[mcp_servers.supadrum]",
    `command = ${JSON.stringify(input.mcpCommand)}`,
    ...(input.mcpArgs
      ? [`args = ${JSON.stringify(input.mcpArgs)}`]
      : []),
    ...(input.mcpCwd
      ? [`cwd = ${JSON.stringify(input.mcpCwd)}`]
      : []),
    "required = true",
    "default_tools_approval_mode = \"auto\"",
    "",
    "[mcp_servers.supadrum.env]",
    `SUPADRUM_CONFIG = ${JSON.stringify(input.configPath)}`,
    TOML_END
  ].join("\n");
}

function agentsBlock(): string {
  return [
    AGENTS_START,
    "## Supadrum",
    "",
    "For every Supabase task, invoke `$supadrum` before any action and use",
    "the Supadrum MCP broker as the only Supabase access path. Never use a",
    "direct Supabase MCP server, CLI login, Management API, or database",
    "credential as a substitute for the broker workflow.",
    AGENTS_END
  ].join("\n");
}

export function installCodexAgentSetup(
  input: CodexAgentSetupInput
): CodexAgentSetupReport {
  const repository = resolve(input.repository);
  const skillSource = resolve(input.skillSource);
  const sourceSkill = join(skillSource, "SKILL.md");
  if (!existsSync(sourceSkill)) {
    throw new Error(`Supadrum skill source not found: ${sourceSkill}`);
  }

  const skillDirectory = join(
    repository,
    ".agents",
    "skills",
    "supadrum"
  );
  mkdirSync(dirname(skillDirectory), { recursive: true });
  cpSync(skillSource, skillDirectory, { recursive: true, force: true });

  const codexConfigPath = join(repository, ".codex", "config.toml");
  const currentCodexConfig = existsSync(codexConfigPath)
    ? readFileSync(codexConfigPath, "utf8")
    : "";
  const unmanagedCodexConfig = withoutExistingSupadrumTables(
    withoutManagedBlock(currentCodexConfig, TOML_START, TOML_END)
  );
  const codexConfig = appendManagedBlock(
    disableDirectSupabaseServers(unmanagedCodexConfig),
    tomlBlock(input)
  );
  atomicWrite(codexConfigPath, codexConfig);

  const agentsPath = join(repository, "AGENTS.md");
  const currentAgents = existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf8")
    : "";
  atomicWrite(
    agentsPath,
    appendManagedBlock(
      withoutManagedBlock(currentAgents, AGENTS_START, AGENTS_END),
      agentsBlock()
    )
  );

  const status = inspectCodexAgentSetup({
    repository,
    configPath: input.configPath,
    mcpCommand: input.mcpCommand,
    ...(input.mcpArgs ? { mcpArgs: input.mcpArgs } : {}),
    ...(input.mcpCwd ? { mcpCwd: input.mcpCwd } : {})
  });
  if (!status.ready) {
    throw new Error("Codex agent setup verification failed");
  }

  return {
    repository,
    skillPath: join(skillDirectory, "SKILL.md"),
    codexConfigPath,
    agentsPath,
    restartRequired: true
  };
}

export function inspectCodexAgentSetup(input: {
  readonly repository: string;
  readonly configPath: string;
  readonly mcpCommand: string;
  readonly mcpArgs?: readonly string[];
  readonly mcpCwd?: string;
}): CodexAgentSetupStatus {
  const repository = resolve(input.repository);
  const skillPath = join(
    repository,
    ".agents",
    "skills",
    "supadrum",
    "SKILL.md"
  );
  const codexConfigPath = join(repository, ".codex", "config.toml");
  const agentsPath = join(repository, "AGENTS.md");
  const skill =
    existsSync(skillPath) &&
    /^name:\s*supadrum\s*$/m.test(readFileSync(skillPath, "utf8"));
  const expectedToml = tomlBlock(input);
  const mcp =
    existsSync(codexConfigPath) &&
    readFileSync(codexConfigPath, "utf8").includes(expectedToml);
  const expectedAgents = agentsBlock();
  const instructions =
    existsSync(agentsPath) &&
    readFileSync(agentsPath, "utf8").includes(expectedAgents);
  return {
    skill,
    mcp,
    instructions,
    ready: skill && mcp && instructions
  };
}

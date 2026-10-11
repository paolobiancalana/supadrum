import { createServer } from "node:net";

/**
 * Builds the disposable `config.toml` for a pgTAP run. The tree's own config is
 * rewritten line by line: no TOML parser is available, and the only keys that
 * matter here (`project_id`, `port`, `*_port`, `[db.seed] enabled`) are plain
 * single-line assignments, so anything fancier would be dead weight.
 */

export const pgtapConfigReasons = [
  "reserved_project_id",
  "original_port_left",
  "ports_exhausted"
] as const;

export type PgtapConfigReason = (typeof pgtapConfigReasons)[number];

export class PgtapConfigError extends Error {
  readonly reason: PgtapConfigReason;

  constructor(reason: PgtapConfigReason, message: string) {
    super(message);
    this.name = "PgtapConfigError";
    this.reason = reason;
  }
}

/** Candidate ports examined after the base before giving up. */
const SCAN_WIDTH = 1000;
const MAX_PORT = 65535;
const TEMPORARY_PREFIX = "supadrum-tmp-";

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const ASSIGNMENT = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)([^#]*?)(\s*(#.*)?)$/;

export type PortProbe = (port: number) => Promise<boolean>;

interface Assignment {
  readonly indent: string;
  readonly key: string;
  readonly eq: string;
  readonly value: string;
  readonly tail: string;
}

function parseAssignment(line: string): Assignment | null {
  const match = ASSIGNMENT.exec(line);
  if (!match) return null;
  return {
    indent: match[1] ?? "",
    key: match[2] ?? "",
    eq: match[3] ?? "",
    value: (match[4] ?? "").trim(),
    tail: match[5] ?? ""
  };
}

/** Reports whether nothing is listening on the port, by binding it briefly. */
export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function isPortKey(key: string): boolean {
  return key === "port" || key.endsWith("_port");
}

function integerValue(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

/**
 * Picks `count` ports in order from `base`. A candidate is skipped when it is
 * an original port of the tree, or when something already listens on it.
 * Stops with a typed error when the scan window runs out first.
 */
async function pickPorts(
  count: number,
  base: number,
  originals: ReadonlySet<number>,
  isFree: PortProbe
): Promise<number[]> {
  const ports: number[] = [];
  const ceiling = Math.min(base + SCAN_WIDTH, MAX_PORT + 1);
  let cursor = base;
  while (ports.length < count) {
    if (cursor >= ceiling) {
      throw new PgtapConfigError("ports_exhausted",
        `Only ${ports.length} of ${count} free ports found from ${base}`);
    }
    const port = cursor++;
    if (originals.has(port)) continue;
    if (!(await isFree(port))) continue;
    ports.push(port);
  }
  return ports;
}

/**
 * Returns the disposable config for `project`. `isFree` is injectable so tests
 * can control which ports look taken; production uses a real loopback bind.
 */
export async function buildPgtapConfig(input: {
  readonly tree: string;
  readonly project: string;
  readonly portBase: number;
  readonly isFree?: PortProbe;
}): Promise<string> {
  const isFree = input.isFree ?? isLoopbackPortFree;
  const lines = input.tree.split("\n");
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();

  // Pass 1: what the tree already says. Originals are every port the tree
  // declares, so no assigned port can ever equal one of them.
  const originals = new Set<number>();
  let table = "";
  let seedHeader = -1;
  let seedEnabled = -1;
  let projectId: string | null = null;
  let portKeys = 0;
  for (const [index, line] of lines.entries()) {
    const header = TABLE_HEADER.exec(line);
    if (header) {
      table = header[1] ?? "";
      if (table === "db.seed") seedHeader = index;
      continue;
    }
    const assignment = parseAssignment(line);
    if (!assignment) continue;
    if (assignment.key === "project_id") projectId = unquote(assignment.value);
    if (assignment.key === "enabled" && table === "db.seed") seedEnabled = index;
    if (isPortKey(assignment.key)) {
      const port = integerValue(assignment.value);
      if (port === null) {
        // Anything but a bare integer cannot be rewritten and would keep the
        // tree's original value, i.e. a port of the developer's own stack.
        throw new PgtapConfigError("original_port_left",
          `${assignment.key} = ${assignment.value} is not a bare integer and would stay original`);
      }
      portKeys += 1;
      originals.add(port);
    }
  }

  if (projectId?.startsWith(TEMPORARY_PREFIX)) {
    throw new PgtapConfigError("reserved_project_id",
      `project_id ${projectId} already uses the ${TEMPORARY_PREFIX} prefix`);
  }

  const ports = await pickPorts(portKeys, input.portBase, originals, isFree);

  // Pass 2: rewrite in place, assigning ports in order of appearance.
  let next = 0;
  table = "";
  const out = lines.map((line, index) => {
    const header = TABLE_HEADER.exec(line);
    if (header) {
      table = header[1] ?? "";
      return line;
    }
    const assignment = parseAssignment(line);
    if (!assignment) return line;
    const { indent, key, eq, tail } = assignment;
    if (key === "project_id") {
      return `${indent}${key}${eq}"${TEMPORARY_PREFIX}${input.project}"`;
    }
    if (key === "enabled" && index === seedEnabled) {
      return `${indent}${key}${eq}false${tail}`;
    }
    if (isPortKey(key)) {
      return `${indent}${key}${eq}${ports[next++]}${tail}`;
    }
    return line;
  });

  // The seed table is forced off: the key is added after its header when the
  // table lacks it, or the table is appended at the end when it is missing.
  if (seedEnabled === -1 && seedHeader !== -1) {
    out.splice(seedHeader + 1, 0, "enabled = false");
  } else if (seedHeader === -1) {
    out.push("", "[db.seed]", "enabled = false");
  }

  if (projectId === null) out.unshift(`project_id = "${TEMPORARY_PREFIX}${input.project}"`);
  return out.join("\n") + (trailingNewline ? "\n" : "");
}

import {
  createHash,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const vaultSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface VaultBackend {
  get(reference: string): Promise<string>;
  put(reference: string, value: string): Promise<void>;
}

export interface EncryptedBackup {
  writeAndVerify(
    values: Readonly<Record<string, string>>
  ): Promise<void>;
}

export interface MigrationEntry {
  readonly name: string;
  readonly reference: string;
  readonly verified: true;
}

export interface MigrationReport {
  readonly applied: boolean;
  readonly entries: readonly MigrationEntry[];
}

export interface DotenvMigrationInput {
  readonly path: string;
  readonly mappings: Readonly<Record<string, string>>;
  readonly vault: VaultBackend;
  readonly backup: EncryptedBackup;
  readonly apply: boolean;
}

interface ParsedAssignment {
  readonly name: string;
  readonly value: string;
  readonly lineIndex: number;
  readonly newline: string;
}

export function parseVaultReference(reference: string): readonly string[] {
  if (!reference.startsWith("vault://")) {
    throw new Error("Expected a vault reference");
  }
  const body = reference.slice("vault://".length);
  if (body.includes("?") || body.includes("#")) {
    throw new Error("Vault reference cannot contain query or fragment");
  }
  const segments = body.split("/");
  if (
    segments.length < 3 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !vaultSegmentPattern.test(segment)
    )
  ) {
    throw new Error("Vault reference contains an unsafe segment");
  }
  return segments;
}

function decodeDotenvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new Error("Invalid quoted dotenv value");
    }
  }
  return value;
}

function parseAssignments(
  source: string,
  names: ReadonlySet<string>
): {
  readonly lines: string[];
  readonly assignments: ReadonlyMap<string, ParsedAssignment>;
} {
  const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const assignments = new Map<string, ParsedAssignment>();

  lines.forEach((line, lineIndex) => {
    const newline = line.endsWith("\r\n")
      ? "\r\n"
      : line.endsWith("\n")
        ? "\n"
        : "";
    const content = newline.length > 0 ? line.slice(0, -newline.length) : line;
    const match = content.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
    );
    if (!match) return;
    const [, name, rawValue] = match;
    if (!name || rawValue === undefined || !names.has(name)) return;
    if (assignments.has(name)) {
      throw new Error(`Duplicate dotenv assignment: ${name}`);
    }
    assignments.set(name, {
      name,
      value: decodeDotenvValue(rawValue),
      lineIndex,
      newline
    });
  });

  return { lines, assignments };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function valuesMatch(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export async function migrateDotenv(
  input: DotenvMigrationInput
): Promise<MigrationReport> {
  const entries = Object.entries(input.mappings);
  if (entries.length === 0) throw new Error("Migration mappings cannot be empty");
  for (const [, reference] of entries) parseVaultReference(reference);

  const source = await readFile(input.path, "utf8");
  const names = new Set(entries.map(([name]) => name));
  const { lines, assignments } = parseAssignments(source, names);
  const missing = entries
    .map(([name]) => name)
    .filter((name) => !assignments.get(name)?.value);
  if (missing.length > 0) {
    throw new Error(`Missing or empty dotenv assignments: ${missing.join(", ")}`);
  }

  const backupValues: Record<string, string> = {};
  const reportEntries: MigrationEntry[] = [];
  for (const [name, reference] of entries) {
    const assignment = assignments.get(name);
    if (!assignment) throw new Error(`Missing dotenv assignment: ${name}`);
    await input.vault.put(reference, assignment.value);
    const resolved = await input.vault.get(reference);
    if (!valuesMatch(assignment.value, resolved)) {
      throw new Error(`Vault round-trip mismatch: ${name}`);
    }
    backupValues[reference] = assignment.value;
    reportEntries.push({ name, reference, verified: true });
  }

  await input.backup.writeAndVerify(backupValues);

  if (!input.apply) {
    return { applied: false, entries: reportEntries };
  }

  for (const [name, reference] of entries) {
    const assignment = assignments.get(name);
    if (!assignment) throw new Error(`Missing dotenv assignment: ${name}`);
    lines[assignment.lineIndex] =
      `# vault-managed: ${name} -> ${reference}${assignment.newline}`;
  }
  const sanitized = lines.join("");
  const temporaryPath = join(
    dirname(input.path),
    `.${basename(input.path)}.supadrum-${randomUUID()}`
  );
  let temporaryCreated = false;
  try {
    await writeFile(temporaryPath, sanitized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    temporaryCreated = true;
    await rename(temporaryPath, input.path);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  return { applied: true, entries: reportEntries };
}

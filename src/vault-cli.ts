#!/usr/bin/env node

import {
  createHash,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isEntrypoint } from "./entrypoint.js";
import {
  migrateDotenv,
  parseVaultReference,
  type EncryptedBackup,
  type VaultBackend
} from "./vault.js";

export const AGE_IDENTITY_REFERENCE = "vault://supadrum/keys/age";
const KEYCHAIN_VALUE_PREFIX = "supadrum:v1:";

export interface ProcessInvocation {
  readonly argv: readonly string[];
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProcessOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessOutcome>;
}

export interface KeychainImportSource {
  readonly service: string;
  readonly account: string;
}

export interface KeychainBackend extends VaultBackend {
  import(
    reference: string,
    source: KeychainImportSource
  ): Promise<{ readonly reference: string; readonly verified: true }>;
}

export interface VaultCliIo {
  readonly readStdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface VaultCliDependencies {
  readonly keychain: VaultBackend | KeychainBackend;
  readonly runner?: ProcessRunner;
}

export class MissingVaultValueError extends Error {
  constructor(reference: string) {
    super(`Vault value is missing: ${reference}`);
    this.name = "MissingVaultValueError";
  }
}

function trimTerminalNewline(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function equalValues(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function encodeKeychainValue(value: string): string {
  return `${KEYCHAIN_VALUE_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
}

function decodeKeychainValue(stored: string): string {
  if (!stored.startsWith(KEYCHAIN_VALUE_PREFIX)) {
    throw new Error("Keychain item has an unsupported Supadrum format");
  }
  const encoded = stored.slice(KEYCHAIN_VALUE_PREFIX.length);
  const value = Buffer.from(encoded, "base64").toString("utf8");
  if (Buffer.from(value, "utf8").toString("base64") !== encoded) {
    throw new Error("Keychain item has invalid Supadrum encoding");
  }
  return value;
}

export const nodeProcessRunner: ProcessRunner = {
  async run(invocation): Promise<ProcessOutcome> {
    const [program, ...args] = invocation.argv;
    if (!program) throw new Error("Process argv cannot be empty");

    return new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        env: invocation.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      });
      child.stdin.end(invocation.stdin);
    });
  }
};

export class MacOsKeychainBackend implements KeychainBackend {
  readonly #runner: ProcessRunner;
  readonly #account: string;

  constructor(
    runner: ProcessRunner = nodeProcessRunner,
    account = process.env.USER
  ) {
    if (!account) throw new Error("Keychain account is required");
    if (!/^[a-zA-Z0-9._@-]+$/.test(account)) {
      throw new Error("Keychain account contains unsafe characters");
    }
    this.#runner = runner;
    this.#account = account;
  }

  async #readItem(service: string, account: string): Promise<string> {
    const result = await this.#runner.run({
      argv: [
        "security",
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w"
      ]
    });
    const value = trimTerminalNewline(result.stdout);
    if (result.exitCode === 44) {
      throw new MissingVaultValueError(service);
    }
    if (result.exitCode !== 0) {
      throw new Error("Keychain item is inaccessible");
    }
    if (value.length === 0) {
      throw new Error("Keychain item is empty");
    }
    return value;
  }

  async get(reference: string): Promise<string> {
    parseVaultReference(reference);
    const stored = await this.#readItem(
      `supadrum:${reference}`,
      this.#account
    );
    return decodeKeychainValue(stored);
  }

  async put(reference: string, value: string): Promise<void> {
    parseVaultReference(reference);
    if (value.length === 0) throw new Error("Keychain value cannot be empty");
    const service = `supadrum:${reference}`;
    const encodedValue = encodeKeychainValue(value);
    const result = await this.#runner.run({
      argv: ["security", "-i"],
      stdin:
        `add-generic-password -U -s ${service} ` +
        `-a ${this.#account} -w ${encodedValue}\n`
    });
    if (result.exitCode !== 0) {
      throw new Error("Keychain write failed");
    }
  }

  async import(
    reference: string,
    source: KeychainImportSource
  ): Promise<{ readonly reference: string; readonly verified: true }> {
    parseVaultReference(reference);
    if (!source.service || !source.account) {
      throw new Error("Keychain import source is incomplete");
    }
    const value = await this.#readItem(source.service, source.account);
    await this.put(reference, value);
    const resolved = await this.get(reference);
    if (!equalValues(value, resolved)) {
      throw new Error("Keychain import round-trip mismatch");
    }
    return { reference, verified: true };
  }
}

function sopsExtractPath(reference: string): string {
  return parseVaultReference(reference)
    .map((segment) => `[${JSON.stringify(segment)}]`)
    .join("");
}

function sopsEnvironment(identity: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { SOPS_AGE_KEY: identity };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function parseJsonValue(output: string, purpose: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${purpose} returned invalid JSON`);
  }
}

function assertAgeRecipient(value: string): string {
  const recipient = trimTerminalNewline(value).trim();
  if (!/^age1[a-z0-9]+$/.test(recipient)) {
    throw new Error("age-keygen returned an invalid recipient");
  }
  return recipient;
}

export class SopsAgeBackend implements VaultBackend {
  readonly #encryptedFile: string;
  readonly #identityBackend: VaultBackend;
  readonly #runner: ProcessRunner;

  constructor(
    encryptedFile: string,
    identityBackend: VaultBackend,
    runner: ProcessRunner = nodeProcessRunner
  ) {
    if (!encryptedFile) throw new Error("SOPS encrypted file is required");
    this.#encryptedFile = encryptedFile;
    this.#identityBackend = identityBackend;
    this.#runner = runner;
  }

  async get(reference: string): Promise<string> {
    const extractPath = sopsExtractPath(reference);
    const identity = await this.#identityBackend.get(AGE_IDENTITY_REFERENCE);
    const result = await this.#runner.run({
      argv: [
        "sops",
        "decrypt",
        "--extract",
        extractPath,
        this.#encryptedFile
      ],
      env: sopsEnvironment(identity)
    });
    if (result.exitCode !== 0) {
      throw new Error("SOPS decrypt failed");
    }
    const value = result.stdout;
    if (value.length === 0) {
      throw new Error("SOPS extract did not return a non-empty string");
    }
    return value;
  }

  async put(): Promise<void> {
    throw new Error("SOPS reference backend is read-only");
  }
}

async function deriveAgeRecipient(
  identity: string,
  runner: ProcessRunner
): Promise<string> {
  const result = await runner.run({
    argv: ["age-keygen", "-y"],
    stdin: identity
  });
  if (result.exitCode !== 0) {
    throw new Error("age recipient derivation failed");
  }
  return assertAgeRecipient(result.stdout);
}

export async function bootstrapAgeIdentity(
  keychain: VaultBackend,
  runner: ProcessRunner = nodeProcessRunner
): Promise<string> {
  let identity: string;
  let generated = false;
  try {
    identity = await keychain.get(AGE_IDENTITY_REFERENCE);
  } catch (error) {
    if (!(error instanceof MissingVaultValueError)) throw error;
    const result = await runner.run({ argv: ["age-keygen"] });
    if (result.exitCode !== 0 || result.stdout.length === 0) {
      throw new Error("age identity generation failed");
    }
    identity = result.stdout;
    generated = true;
  }

  const recipient = await deriveAgeRecipient(identity, runner);
  if (generated) {
    await keychain.put(AGE_IDENTITY_REFERENCE, identity);
    const roundTrip = await keychain.get(AGE_IDENTITY_REFERENCE);
    if (!equalValues(identity, roundTrip)) {
      throw new Error("age identity Keychain round-trip mismatch");
    }
  }
  return recipient;
}

type SecretTree = Record<string, unknown>;

function buildSecretTree(
  values: Readonly<Record<string, string>>
): SecretTree {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new Error("SOPS backup cannot be empty");
  }
  const root: SecretTree = {};
  for (const [reference, value] of entries) {
    const segments = parseVaultReference(reference);
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = cursor[segment];
      if (existing === undefined) {
        const child: SecretTree = {};
        cursor[segment] = child;
        cursor = child;
      } else if (
        typeof existing === "object" &&
        existing !== null &&
        !Array.isArray(existing)
      ) {
        cursor = existing as SecretTree;
      } else {
        throw new Error("SOPS backup reference collision");
      }
    }
    const leaf = segments.at(-1);
    if (!leaf || cursor[leaf] !== undefined) {
      throw new Error("SOPS backup reference collision");
    }
    cursor[leaf] = value;
  }
  return root;
}

function treeValue(tree: unknown, reference: string): unknown {
  let cursor = tree;
  for (const segment of parseVaultReference(reference)) {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      Array.isArray(cursor)
    ) {
      return undefined;
    }
    cursor = (cursor as SecretTree)[segment];
  }
  return cursor;
}

export class SopsAgeBackup implements EncryptedBackup {
  readonly #path: string;
  readonly #recipient: string;
  readonly #identityBackend: VaultBackend;
  readonly #runner: ProcessRunner;

  constructor(
    path: string,
    recipient: string,
    identityBackend: VaultBackend,
    runner: ProcessRunner = nodeProcessRunner
  ) {
    if (!path) throw new Error("SOPS backup path is required");
    this.#path = path;
    this.#recipient = assertAgeRecipient(recipient);
    this.#identityBackend = identityBackend;
    this.#runner = runner;
  }

  async writeAndVerify(
    values: Readonly<Record<string, string>>
  ): Promise<void> {
    const tree = buildSecretTree(values);
    const plaintext = JSON.stringify(tree);
    const encrypted = await this.#runner.run({
      argv: [
        "sops",
        "encrypt",
        "--input-type",
        "json",
        "--output-type",
        "json",
        "--filename-override",
        "supadrum-secrets.json",
        "--age",
        this.#recipient
      ],
      stdin: plaintext
    });
    if (encrypted.exitCode !== 0 || encrypted.stdout.length === 0) {
      throw new Error("SOPS backup encryption failed");
    }

    const temporaryPath = join(
      dirname(this.#path),
      `.${basename(this.#path)}.supadrum-${randomUUID()}`
    );
    let temporaryCreated = false;
    try {
      await writeFile(temporaryPath, encrypted.stdout, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      temporaryCreated = true;

      const identity = await this.#identityBackend.get(
        AGE_IDENTITY_REFERENCE
      );
      const decrypted = await this.#runner.run({
        argv: [
          "sops",
          "decrypt",
          "--output-type",
          "json",
          temporaryPath
        ],
        env: sopsEnvironment(identity)
      });
      if (decrypted.exitCode !== 0) {
        throw new Error("SOPS backup verification failed");
      }
      const roundTrip = parseJsonValue(
        decrypted.stdout,
        "SOPS backup verification"
      );
      for (const [reference, value] of Object.entries(values)) {
        const resolved = treeValue(roundTrip, reference);
        if (typeof resolved !== "string" || !equalValues(value, resolved)) {
          throw new Error("SOPS backup round-trip mismatch");
        }
      }

      await rename(temporaryPath, this.#path);
      temporaryCreated = false;
    } finally {
      if (temporaryCreated) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * The argument after a command, unless the operator left it out and the next
 * option slid into its place — `keychain import --service X` must not read as
 * a request to import into a reference named `--service`.
 */
function positional(value: string | undefined): string | undefined {
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function options(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) {
      values.push(args[index + 1] as string);
      index += 1;
    }
  }
  return values;
}

function migrationMappings(
  args: readonly string[]
): Readonly<Record<string, string>> {
  const mappings: Record<string, string> = {};
  for (const mapping of options(args, "--map")) {
    const separator = mapping.indexOf("=");
    const name = mapping.slice(0, separator);
    const reference = mapping.slice(separator + 1);
    if (
      separator <= 0 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      !reference
    ) {
      throw new Error(
        "Each migration mapping must be NAME=vault://reference"
      );
    }
    if (mappings[name] !== undefined) {
      throw new Error(`Duplicate migration mapping: ${name}`);
    }
    parseVaultReference(reference);
    mappings[name] = reference;
  }
  if (Object.keys(mappings).length === 0) {
    throw new Error("Dotenv migration requires at least one --map");
  }
  return mappings;
}

function isKeychainBackend(
  backend: VaultBackend | KeychainBackend
): backend is KeychainBackend {
  return "import" in backend && typeof backend.import === "function";
}

export async function runVaultCli(
  args: readonly string[],
  io: VaultCliIo,
  dependencies: VaultCliDependencies
): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    io.stdout(
      [
        "Usage: supadrum-vault <keychain|sops|migrate> <command> [options]",
        "",
        "  keychain resolve",
        "  keychain put <vault-reference>",
        "  keychain import <vault-reference> --service NAME [--account NAME]",
        "  sops resolve --file PATH",
        "  sops bootstrap-age",
        "  migrate dotenv --source PATH --backup PATH --map NAME=vault://reference [--apply]",
        ""
      ].join("\n")
    );
    return 0;
  }

  const runner = dependencies.runner ?? nodeProcessRunner;

  if (args[0] === "migrate") {
    if (args[1] !== "dotenv") {
      io.stderr(
        "Usage: supadrum-vault migrate dotenv --source PATH --backup PATH --map NAME=vault://reference [--apply]\n"
      );
      return 1;
    }
    const source = option(args, "--source");
    const backupPath = option(args, "--backup");
    if (!source || !backupPath) {
      throw new Error("Dotenv migration requires --source and --backup");
    }
    // Settle the whole command line before bootstrapAgeIdentity, which mints
    // and stores a key: a migration that can never run must not leave an age
    // identity behind that no backup was ever encrypted to.
    const mappings = migrationMappings(args);
    const recipient = await bootstrapAgeIdentity(
      dependencies.keychain,
      runner
    );
    const report = await migrateDotenv({
      path: source,
      mappings,
      vault: dependencies.keychain,
      backup: new SopsAgeBackup(
        backupPath,
        recipient,
        dependencies.keychain,
        runner
      ),
      apply: args.includes("--apply")
    });
    io.stdout(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (args[0] === "sops") {
    const command = args[1];
    if (command === "resolve") {
      const file = option(args, "--file");
      if (!file) throw new Error("SOPS resolve requires --file");
      const reference = (await io.readStdin()).trim();
      const backend = new SopsAgeBackend(
        file,
        dependencies.keychain,
        runner
      );
      io.stdout(await backend.get(reference));
      return 0;
    }
    if (command === "bootstrap-age") {
      const recipient = await bootstrapAgeIdentity(
        dependencies.keychain,
        runner
      );
      io.stdout(`${recipient}\n`);
      return 0;
    }
    io.stderr(
      "Usage: supadrum-vault sops <resolve --file PATH|bootstrap-age>\n"
    );
    return 1;
  }

  if (args[0] !== "keychain") {
    io.stderr(
      "Usage: supadrum-vault <keychain|sops|migrate> <command> [options]\n"
    );
    return 1;
  }

  const command = args[1];
  if (command === "resolve") {
    const reference = (await io.readStdin()).trim();
    const value = await dependencies.keychain.get(reference);
    io.stdout(value);
    return 0;
  }
  if (command === "put") {
    const reference = positional(args[2]);
    if (!reference) throw new Error("Keychain put requires a vault reference");
    const value = trimTerminalNewline(await io.readStdin());
    await dependencies.keychain.put(reference, value);
    const resolved = await dependencies.keychain.get(reference);
    if (!equalValues(value, resolved)) {
      throw new Error("Keychain put round-trip mismatch");
    }
    io.stdout(`${JSON.stringify({ reference, verified: true })}\n`);
    return 0;
  }
  if (command === "import") {
    const reference = positional(args[2]);
    const service = option(args, "--service");
    const account = option(args, "--account") ?? process.env.USER;
    if (!reference || !service || !account) {
      throw new Error(
        "Keychain import requires a reference, --service, and account"
      );
    }
    if (!isKeychainBackend(dependencies.keychain)) {
      throw new Error("Configured backend cannot import Keychain items");
    }
    const report = await dependencies.keychain.import(reference, {
      service,
      account
    });
    io.stdout(`${JSON.stringify(report)}\n`);
    return 0;
  }

  io.stderr(
    "Usage: supadrum-vault keychain <resolve|put|import> [options]\n"
  );
  return 1;
}

/*
 * Process bootstrap: binds this module to the real process — its argv, its
 * stdio, its exit code. The guard is false by design whenever the module is
 * imported rather than executed, so a coverage instrument scoped to the test
 * process can never observe it. The logic it wires into is exported and
 * tested directly; excluded from the measurement so the reported number means
 * "code the instrument can see" rather than carrying a permanent red block.
 */
/* v8 ignore start */
async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const entrypoint = process.argv[1];
if (isEntrypoint(import.meta.url, entrypoint)) {
  runVaultCli(
    process.argv.slice(2),
    {
      readStdin: readProcessStdin,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text)
    },
    { keychain: new MacOsKeychainBackend() }
  )
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    });
}
/* v8 ignore stop */

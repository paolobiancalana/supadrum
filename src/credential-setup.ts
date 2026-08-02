import {
  createHash,
  timingSafeEqual
} from "node:crypto";
import { basename } from "node:path";

import type {
  CredentialBundle,
  SupadrumConfig
} from "./config.js";
import { databasePassword } from "./live-executor.js";
import { MissingVaultValueError } from "./vault-cli.js";
import type { VaultBackend } from "./vault.js";

export type CredentialName = keyof CredentialBundle;

export interface SecretPrompt {
  read(label: string): Promise<string>;
}

export interface CredentialSetupReport {
  readonly project: string;
  readonly configured: readonly CredentialName[];
  readonly existing: readonly CredentialName[];
  readonly ready: true;
}

const credentialOrder: readonly CredentialName[] = [
  "secret_key",
  "management_token",
  "database_access"
];

const credentialLabels: Readonly<Record<CredentialName, string>> = {
  secret_key: "Secret key",
  management_token: "Management token",
  database_access: "Database access"
};

function valuesMatch(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function isBundledKeychainCommand(
  command: readonly string[] | undefined,
  nodeExecutable = process.execPath
): boolean {
  if (!command || command.slice(-2).join(" ") !== "keychain resolve") {
    return false;
  }
  const launcher = command.slice(0, -2);
  if (launcher.length === 1) {
    return basename(launcher[0] ?? "") === "supadrum-vault";
  }
  return (
    launcher.length === 2 &&
    (launcher[0] === nodeExecutable ||
      basename(launcher[0] ?? "") === "node") &&
    basename(launcher[1] ?? "") === "vault-cli.js"
  );
}

export async function setupProjectCredentials(input: {
  readonly project: string;
  readonly config: SupadrumConfig;
  readonly vault: VaultBackend;
  readonly prompt: SecretPrompt;
  readonly replace?: readonly CredentialName[];
}): Promise<CredentialSetupReport> {
  const project = input.config.projects[input.project];
  if (!project) throw new Error(`Unknown project: ${input.project}`);

  const existing: CredentialName[] = [];
  const missing: CredentialName[] = [];
  const replace = new Set(input.replace ?? []);
  for (const name of credentialOrder) {
    if (replace.has(name)) {
      missing.push(name);
      continue;
    }
    try {
      await input.vault.get(project.credentials[name]);
      existing.push(name);
    } catch (error) {
      if (!(error instanceof MissingVaultValueError)) throw error;
      missing.push(name);
    }
  }

  const configured: CredentialName[] = [];
  for (const name of missing) {
    let value = "";
    while (value.length === 0) {
      value = await input.prompt.read(credentialLabels[name]);
    }
    if (name === "database_access") {
      try {
        databasePassword(value);
      } catch {
        throw new Error(
          "Database access must be a complete PostgreSQL URI with a percent-encoded password"
        );
      }
    }
    const reference = project.credentials[name];
    await input.vault.put(reference, value);
    const resolved = await input.vault.get(reference);
    if (!valuesMatch(value, resolved)) {
      throw new Error(`Credential round-trip mismatch: ${name}`);
    }
    configured.push(name);
  }

  return {
    project: input.project,
    configured,
    existing,
    ready: true
  };
}

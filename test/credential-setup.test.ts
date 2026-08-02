import { describe, expect, test } from "vitest";

import type { SupadrumConfig } from "../src/config.js";
import {
  isBundledKeychainCommand,
  setupProjectCredentials,
  type SecretPrompt
} from "../src/credential-setup.js";
import { MissingVaultValueError } from "../src/vault-cli.js";
import type { VaultBackend } from "../src/vault.js";

const references = {
  secret_key: "vault://supabase/example-ios/secret",
  management_token: "vault://supabase/example-ios/management",
  database_access: "vault://supabase/example-ios/postgres"
} as const;

const config: SupadrumConfig = {
  version: 1,
  database: "queue.sqlite",
  database_path: "/operator/queue.sqlite",
  config_path: "/operator/config.yml",
  executor: "dry-run",
  approval_mode: "automatic",
  vault_command: ["supadrum-vault", "keychain", "resolve"],
  chambers: {
    "example-ios": {
      project_ref: "abcdefghijklmnopqrst",
      credentials: references
    }
  },
  projects: {
    "example-ios": {
      chamber: "example-ios",
      project_ref: "abcdefghijklmnopqrst",
      credentials: references,
      capabilities: ["migrations"],
      mode: "dry-run",
      migrations: "owner",
      migration_driver: "supabase"
    }
  }
};

class MemoryVault implements VaultBackend {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ reference: string; value: string }> = [];
  corruptAfterWrite: string | null = null;

  async get(reference: string): Promise<string> {
    const value = this.values.get(reference);
    if (value === undefined) throw new MissingVaultValueError(reference);
    if (
      this.corruptAfterWrite === reference &&
      this.writes.some((write) => write.reference === reference)
    ) {
      return "different-value";
    }
    return value;
  }

  async put(reference: string, value: string): Promise<void> {
    this.writes.push({ reference, value });
    this.values.set(reference, value);
  }
}

function queuedPrompt(
  values: readonly string[]
): SecretPrompt & { readonly labels: string[] } {
  const labels: string[] = [];
  const queue = [...values];
  return {
    labels,
    async read(label) {
      labels.push(label);
      const value = queue.shift();
      if (value === undefined) throw new Error("Prompt queue exhausted");
      return value;
    }
  };
}

describe("project credential setup", () => {
  test("stores and verifies the complete missing bundle without returning values", async () => {
    const vault = new MemoryVault();
    const prompt = queuedPrompt([
      "secret-key-canary",
      "management-canary",
      "postgresql://postgres:database-canary@db.example.test/postgres"
    ]);

    const report = await setupProjectCredentials({
      project: "example-ios",
      config,
      vault,
      prompt
    });

    expect(prompt.labels).toEqual([
      "Secret key",
      "Management token",
      "Database access"
    ]);
    expect(report).toEqual({
      project: "example-ios",
      configured: [
        "secret_key",
        "management_token",
        "database_access"
      ],
      existing: [],
      ready: true
    });
    expect(JSON.stringify(report)).not.toContain("canary");
  });

  test("prompts only for credentials that are still missing", async () => {
    const vault = new MemoryVault();
    vault.values.set(references.secret_key, "existing-canary");
    const prompt = queuedPrompt([
      "management-canary",
      "postgresql://postgres:database-canary@db.example.test/postgres"
    ]);

    const report = await setupProjectCredentials({
      project: "example-ios",
      config,
      vault,
      prompt
    });

    expect(prompt.labels).toEqual([
      "Management token",
      "Database access"
    ]);
    expect(report.existing).toEqual(["secret_key"]);
    expect(vault.writes.map(({ reference }) => reference)).toEqual([
      references.management_token,
      references.database_access
    ]);
  });

  test("replaces only an explicitly selected existing credential", async () => {
    const vault = new MemoryVault();
    vault.values.set(references.secret_key, "existing-secret");
    vault.values.set(references.management_token, "existing-management");
    vault.values.set(references.database_access, "not-a-uri");
    const prompt = queuedPrompt([
      "postgresql://postgres:correct@db.example.test:5432/postgres"
    ]);

    const report = await setupProjectCredentials({
      project: "example-ios",
      config,
      vault,
      prompt,
      replace: ["database_access"]
    });

    expect(prompt.labels).toEqual(["Database access"]);
    expect(report.configured).toEqual(["database_access"]);
    expect(report.existing).toEqual([
      "secret_key",
      "management_token"
    ]);
    expect(vault.writes.map(({ reference }) => reference)).toEqual([
      references.database_access
    ]);
  });

  test("rejects an invalid database access value before writing", async () => {
    const vault = new MemoryVault();
    vault.values.set(references.secret_key, "existing-secret");
    vault.values.set(references.management_token, "existing-management");
    const prompt = queuedPrompt(["password-only"]);

    await expect(
      setupProjectCredentials({
        project: "example-ios",
        config,
        vault,
        prompt
      })
    ).rejects.toThrow(
      "Database access must be a complete PostgreSQL URI"
    );
    expect(vault.writes).toEqual([]);
  });

  test("stops on a credential round-trip mismatch without exposing its value", async () => {
    const vault = new MemoryVault();
    vault.corruptAfterWrite = references.management_token;
    const prompt = queuedPrompt([
      "secret-key-canary",
      "management-canary",
      "postgresql://postgres:database-canary@db.example.test/postgres"
    ]);

    await expect(
      setupProjectCredentials({
        project: "example-ios",
        config,
        vault,
        prompt
      })
    ).rejects.toThrow(
      "Credential round-trip mismatch: management_token"
    );
    expect(vault.writes).toHaveLength(2);
  });

  test("re-prompts an empty credential before writing it", async () => {
    const vault = new MemoryVault();
    vault.values.set(references.secret_key, "existing-secret");
    vault.values.set(references.management_token, "existing-management");
    const prompt = queuedPrompt([
      "",
      "postgresql://postgres:database-canary@db.example.test/postgres"
    ]);

    await setupProjectCredentials({
      project: "example-ios",
      config,
      vault,
      prompt
    });

    expect(prompt.labels).toEqual(["Database access", "Database access"]);
    expect(vault.writes).toEqual([
      {
        reference: references.database_access,
        value:
          "postgresql://postgres:database-canary@db.example.test/postgres"
      }
    ]);
  });

  test("recognizes only bundled Keychain resolver commands", () => {
    expect(
      isBundledKeychainCommand([
        "supadrum-vault",
        "keychain",
        "resolve"
      ])
    ).toBe(true);
    expect(
      isBundledKeychainCommand(
        [
          process.execPath,
          "/package/dist/vault-cli.js",
          "keychain",
          "resolve"
        ],
        process.execPath
      )
    ).toBe(true);
    expect(
      isBundledKeychainCommand([
        "node",
        "/opt/supadrum/dist/vault-cli.js",
        "keychain",
        "resolve"
      ])
    ).toBe(true);
    expect(
      isBundledKeychainCommand([
        "custom-resolver",
        "keychain",
        "resolve"
      ])
    ).toBe(false);
    expect(
      isBundledKeychainCommand([
        "supadrum-vault",
        "sops",
        "resolve"
      ])
    ).toBe(false);
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  migrateDotenv,
  parseVaultReference,
  type EncryptedBackup,
  type VaultBackend
} from "../src/vault.js";

class MemoryVault implements VaultBackend {
  readonly values = new Map<string, string>();
  failPut = false;
  corruptReads = false;

  async get(reference: string): Promise<string> {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error(`Missing reference: ${reference}`);
    return this.corruptReads ? `${value}-corrupted` : value;
  }

  async put(reference: string, value: string): Promise<void> {
    if (this.failPut) throw new Error("destination unavailable");
    this.values.set(reference, value);
  }
}

class MemoryBackup implements EncryptedBackup {
  values: Readonly<Record<string, string>> | null = null;
  fail = false;

  async writeAndVerify(
    values: Readonly<Record<string, string>>
  ): Promise<void> {
    if (this.fail) throw new Error("backup unavailable");
    this.values = { ...values };
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "supadrum-vault-"));
  const path = join(directory, ".env");
  const original = [
    "DATABASE_URL=canary-database",
    "SUPABASE_SERVICE_ROLE_KEY=canary-service-role",
    "PORT=3000",
    ""
  ].join("\n");
  writeFileSync(path, original, { mode: 0o600 });
  return { original, path };
}

const mappings = {
  DATABASE_URL: "vault://legacy/example-service-env/database-url",
  SUPABASE_SERVICE_ROLE_KEY:
    "vault://legacy/example-service-env/supabase-service-role-key"
} as const;

describe("vault references", () => {
  test("parses a normalized vault reference", () => {
    expect(
      parseVaultReference("vault://supabase/example-web/management")
    ).toEqual(["supabase", "example-web", "management"]);
  });

  test.each([
    "https://example.test/secret",
    "vault://supabase/../secret",
    "vault://supabase//secret",
    "vault://supabase"
  ])("rejects an unsafe vault reference: %s", (reference) => {
    expect(() => parseVaultReference(reference)).toThrow(
      /vault reference|segment/i
    );
  });
});

describe("atomic dotenv migration", () => {
  test("moves allow-listed values and rewrites only after verification", async () => {
    const { path } = fixture();
    const vault = new MemoryVault();
    const backup = new MemoryBackup();

    const report = await migrateDotenv({
      path,
      mappings,
      vault,
      backup,
      apply: true
    });

    const rewritten = readFileSync(path, "utf8");
    expect(rewritten).toContain("PORT=3000");
    expect(rewritten).toContain(
      "# vault-managed: DATABASE_URL -> vault://legacy/example-service-env/database-url"
    );
    expect(rewritten).not.toContain("canary-database");
    expect(rewritten).not.toContain("canary-service-role");
    expect(backup.values).toEqual({
      "vault://legacy/example-service-env/database-url": "canary-database",
      "vault://legacy/example-service-env/supabase-service-role-key":
        "canary-service-role"
    });
    expect(report).toEqual({
      applied: true,
      entries: [
        {
          name: "DATABASE_URL",
          reference: "vault://legacy/example-service-env/database-url",
          verified: true
        },
        {
          name: "SUPABASE_SERVICE_ROLE_KEY",
          reference:
            "vault://legacy/example-service-env/supabase-service-role-key",
          verified: true
        }
      ]
    });
    expect(JSON.stringify(report)).not.toContain("canary");
  });

  test("verification-only mode leaves the source byte-for-byte unchanged", async () => {
    const { original, path } = fixture();

    const report = await migrateDotenv({
      path,
      mappings,
      vault: new MemoryVault(),
      backup: new MemoryBackup(),
      apply: false
    });

    expect(readFileSync(path, "utf8")).toBe(original);
    expect(report.applied).toBe(false);
  });

  test.each(["put", "digest", "backup"] as const)(
    "leaves the source unchanged when %s verification fails",
    async (failure) => {
      const { original, path } = fixture();
      const vault = new MemoryVault();
      const backup = new MemoryBackup();
      vault.failPut = failure === "put";
      vault.corruptReads = failure === "digest";
      backup.fail = failure === "backup";

      await expect(
        migrateDotenv({
          path,
          mappings,
          vault,
          backup,
          apply: true
        })
      ).rejects.toThrow();

      expect(readFileSync(path, "utf8")).toBe(original);
    }
  );

  test("rejects missing and empty source assignments", async () => {
    const { path } = fixture();
    writeFileSync(path, "DATABASE_URL=\nPORT=3000\n");

    await expect(
      migrateDotenv({
        path,
        mappings,
        vault: new MemoryVault(),
        backup: new MemoryBackup(),
        apply: true
      })
    ).rejects.toThrow(/missing or empty.*DATABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/i);
  });
});

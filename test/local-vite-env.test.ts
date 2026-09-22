import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeLocalViteEnvironment } from "../src/local-vite-env.js";

describe("local Vite environment", () => {
  test("does not write frontend values into a backend-only repository", () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-backend-env-"));
    mkdirSync(join(repository, "supabase"));
    writeFileSync(join(repository, "supabase", "config.toml"),
      '[auth]\nexternal_url = "https://local.example.test"\n');

    expect(writeLocalViteEnvironment(repository, 'ANON_KEY="public-key"')).toBe(false);
    expect(existsSync(join(repository, ".env.development.local"))).toBe(false);
  });

  test("updates a nested Vite frontend rather than the repository root", () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-frontend-env-"));
    mkdirSync(join(repository, "supabase"));
    mkdirSync(join(repository, "frontend"));
    writeFileSync(join(repository, "supabase", "config.toml"),
      '[auth]\nexternal_url = "https://local.example.test"\n');
    writeFileSync(join(repository, "frontend", "package.json"),
      '{"devDependencies":{"vite":"^7.0.0"}}');

    expect(writeLocalViteEnvironment(repository, 'ANON_KEY="public-key"')).toBe(true);
    expect(existsSync(join(repository, ".env.development.local"))).toBe(false);
    expect(readFileSync(join(repository, "frontend", ".env.development.local"), "utf8"))
      .toContain("VITE_SUPABASE_ANON_KEY=public-key");
  });

  test("accepts TOML literal strings for the external URL", () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-literal-env-"));
    mkdirSync(join(repository, "supabase"));
    writeFileSync(join(repository, "package.json"),
      '{"devDependencies":{"vite":"^7.0.0"}}');
    writeFileSync(join(repository, "supabase", "config.toml"),
      "[auth]\nexternal_url = 'https://local.example.test'\n");

    expect(writeLocalViteEnvironment(repository, 'ANON_KEY="public-key"')).toBe(true);
    expect(readFileSync(join(repository, ".env.development.local"), "utf8"))
      .toContain("VITE_SUPABASE_URL=https://local.example.test");
  });

  test("uses the protected public URL and replaces stale Supabase values", () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-local-env-"));
    mkdirSync(join(repository, "supabase"));
    writeFileSync(join(repository, "package.json"),
      '{"devDependencies":{"vite":"^7.0.0"}}');
    writeFileSync(join(repository, "supabase", "config.toml"), `
[api]
port = 54321
[auth]
external_url = "https://dev.presnap.co/supabase"
[storage]
enabled = true
`);
    writeFileSync(join(repository, ".env.development.local"),
      "UNCHANGED=yes\nVITE_SUPABASE_URL=stale\nVITE_SUPABASE_ANON_KEY=stale\n");

    writeLocalViteEnvironment(repository, 'ANON_KEY="local-public-key"\n');

    expect(readFileSync(join(repository, ".env.development.local"), "utf8"))
      .toBe("UNCHANGED=yes\nVITE_SUPABASE_URL=https://dev.presnap.co/supabase\n" +
        "VITE_SUPABASE_ANON_KEY=local-public-key\n");
  });
});

import { describe, expect, test } from "vitest";

import {
  formatCredentialSetup,
  formatCredentialSecurityNotice,
  formatDatabaseAccessGuide,
  formatManagementTokenGuide,
  formatProjectAdded,
  formatProjectDoctor,
  formatSecretKeyGuide
} from "../src/cli-output.js";

describe("human CLI output", () => {
  test("project add shows one compact next action without vault plumbing", () => {
    const output = formatProjectAdded({
      alias: "example-ios",
      repository: "/home/operator/projects/example-ios",
      project_ref: "abcdefghijklmnopqrst",
      profile: "development",
      ready: false,
      configured_credentials: 0,
      executor: "dry-run"
    });

    expect(output).toBe(
      [
        "✓ Project example-ios added",
        "",
        "  Repository   /home/operator/projects/example-ios",
        "  Supabase     abcdefghijklmnopqrst",
        "  Profile      development",
        "  Mode         dry-run",
        "",
        "○ Credentials  0/3 configured",
        "",
        "Next:",
        "  supadrum project credentials set example-ios",
        ""
      ].join("\n")
    );
    expect(output).not.toMatch(/vault:\/\/|read -rs|supadrum-vault/);
  });

  test("doctor reports safe dry-run readiness with the same next action", () => {
    const output = formatProjectDoctor({
      project: "example-ios",
      chamber: "example-platform",
      mode: "dry-run",
      migrations: "consumer",
      migration_driver: "prisma",
      ready: false,
      repository: true,
      project_ref: true,
      credentials: {
        secret_key: false,
        management_token: false,
        database_access: false
      },
      missing_credentials: [
        "secret_key",
        "management_token",
        "database_access"
      ],
      invalid_credentials: [],
      executor: "dry-run"
    });

    expect(output).toBe(
      [
        "Supadrum doctor — example-ios",
        "",
        "✓ Repository",
        "✓ Supabase ref",
        "✓ Chamber      example-platform",
        "○ Migrations   consumer",
        "✓ Driver       prisma",
        "○ Credentials  0/3 valid",
        "○ Mode         dry-run (safe)",
        "",
        "Not ready",
        "",
        "Next:",
        "  supadrum project credentials set example-ios",
        ""
      ].join("\n")
    );
    expect(output).not.toMatch(/vault:\/\/|read -rs|supadrum-vault/);
  });

  test("credential setup reports only metadata and final readiness", () => {
    const output = formatCredentialSetup("example-ios", true);

    expect(output).toBe(
      [
        "",
        "✓ Credential bundle saved in macOS Keychain",
        "✓ Project ready",
        ""
      ].join("\n")
    );
  });

  test("credential setup explains the local secret boundary", () => {
    const output = formatCredentialSecurityNotice();

    expect(output).toBe(
      [
        "Security",
        "",
        "  Supadrum is local and open source. It does not send secret values",
        "  to its maintainers or a hosted Supadrum service, and never places",
        "  them in MCP messages or LLM prompts.",
        "  The masked CLI writes them to macOS Keychain, encrypted at rest",
        "  under operating-system access controls.",
        "",
        "  Secret values never enter jobs, the queue, config, the repository,",
        "  argv, shell history or CLI output. The broker resolves them only",
        "  in local process memory for operator-authorized command execution.",
        "",
        "  This reduces accidental exposure compared with plaintext .env files.",
        "  It is not a sandbox: a process with unrestricted shell access running",
        "  as your macOS user shares that user's security boundary. Use a dedicated",
        "  runner identity or policy-enforcing vault for hard agent isolation.",
        ""
      ].join("\n")
    );
  });

  test("secret key guide links to the configured Supabase project", () => {
    const output = formatSecretKeyGuide(
      "example-ios",
      "abcdefghijklmnopqrst"
    );

    expect(output).toBe(
      [
        "Secret key",
        "",
        "  Open:",
        "  https://supabase.com/dashboard/project/abcdefghijklmnopqrst/settings/api-keys",
        "",
        "  Project Settings → API Keys → Publishable and secret API keys",
        "  Use an existing sb_secret_… key, or choose New secret key,",
        '  name it "supadrum_example_ios", then choose Create API key.',
        "  Do not paste a publishable or anon key.",
        "",
        "  If Supabase redirects to Organizations, sign in with an account",
        "  that can access project abcdefghijklmnopqrst.",
        ""
      ].join("\n")
    );
  });

  test("management token guide explains the account-level credential", () => {
    const output = formatManagementTokenGuide("example-ios");

    expect(output).toBe(
      [
        "Management token",
        "",
        "  What:",
        "  A Supabase Personal Access Token for Management API and CLI.",
        "  It belongs to your account, not to one project, and normally",
        "  starts with sbp_. It can act on every project your account can access.",
        "",
        "  Open:",
        "  https://supabase.com/dashboard/account/tokens",
        "",
        "  Account → Access Tokens → Generate new token",
        '  Name it "supadrum_example_ios", choose an expiration, then generate it.',
        "  Copy the complete sbp_… token and paste it below.",
        "  Do not paste a project secret key or database password.",
        ""
      ].join("\n")
    );
  });

  test("database guide asks for a complete Postgres connection string", () => {
    const output = formatDatabaseAccessGuide("abcdefghijklmnopqrst");

    expect(output).toBe(
      [
        "Database access",
        "",
        "  What:",
        "  The complete PostgreSQL connection string, including its password.",
        "  It starts with postgres:// or postgresql:// and is used for SQL,",
        "  migrations, dumps and other native database operations.",
        "",
        "  Open:",
        "  https://supabase.com/dashboard/project/abcdefghijklmnopqrst",
        "",
        "  Choose Connect → Direct connection → URI, then copy the string.",
        "  Replace [YOUR-PASSWORD] with the project's database password.",
        "  Paste the complete URI, not the password by itself.",
        "  URL-encode reserved password characters when required (for example",
        "  / as %2F, # as %23 and ? as %3F).",
        "  If Direct connection cannot use IPv6 on your network, choose",
        "  Session pooler on port 5432 instead.",
        "  Do not paste the project URL, a secret key or a transaction pooler URL.",
        "",
        "  Reset a forgotten password in Database → Settings:",
        "  https://supabase.com/dashboard/project/abcdefghijklmnopqrst/database/settings",
        ""
      ].join("\n")
    );
  });
});

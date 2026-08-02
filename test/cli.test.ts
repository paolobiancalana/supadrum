import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";

import { runCli } from "../src/cli.js";
import { SqliteStore } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import type { SecretPrompt } from "../src/credential-setup.js";
import { addProject } from "../src/projects.js";
import { MissingVaultValueError } from "../src/vault-cli.js";
import type { VaultBackend } from "../src/vault.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const tsxLoader = join(
  repositoryRoot,
  "node_modules",
  "tsx",
  "dist",
  "loader.mjs"
);
const cliSource = join(repositoryRoot, "src", "cli.ts");

class MemoryVault implements VaultBackend {
  readonly values = new Map<string, string>();

  async get(reference: string): Promise<string> {
    const value = this.values.get(reference);
    if (value === undefined) throw new MissingVaultValueError(reference);
    return value;
  }

  async put(reference: string, value: string): Promise<void> {
    this.values.set(reference, value);
  }
}

function credentialConfig(
  vaultCommand: readonly string[]
): {
  readonly root: string;
  readonly configPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "supadrum-cli-credentials-"));
  const repository = join(root, "example-ios");
  const configPath = join(root, "config.yml");
  execFileSync("git", ["init", "--quiet", repository]);
  addProject({
    alias: "example-ios",
    repository,
    project_ref: "abcdefghijklmnopqrst",
    profile: "development",
    config_path: configPath,
    vault_command: vaultCommand
  });
  return { root, configPath };
}

/**
 * Collects what the CLI wrote and hands back a runtime whose every input is
 * declared here rather than inherited from the process, so a test can never
 * pass because of the developer's own environment.
 */
function cli(overrides: Partial<CliRuntimeShape> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const root = overrides.cwd ?? mkdtempSync(join(tmpdir(), "supadrum-cli-"));
  return {
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text)
    },
    runtime: {
      cwd: root,
      homeDirectory: root,
      environment: {},
      question: async () => {
        throw new Error("this command must not prompt");
      },
      defaultVaultCommand: undefined,
      promptSecret: { read: async () => "unused" },
      keychain: () => new MemoryVault(),
      ...overrides
    },
    root,
    stdout: () => out.join(""),
    stderr: () => err.join("")
  };
}

type CliRuntimeShape = Parameters<typeof runCli>[2] & object;

describe("operator CLI", () => {
  test("shows project wizard commands in root help", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cliSource, "--help"],
      { cwd: repositoryRoot }
    );

    expect(stdout).toContain("supadrum project add");
    expect(stdout).toContain("supadrum project credentials set");
    expect(stdout).toContain("supadrum project doctor");
    expect(stdout).toContain("supadrum project setup");
    expect(stdout).toContain("supadrum project migrations owner");
    expect(stdout).toContain("supadrum project migrations driver");
    expect(stdout).toContain("supadrum project live");
    expect(stderr).toBe("");
  });

  test("configures migration ownership and per-project mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-mode-"));
    const webRepository = join(root, "example-web");
    const iosRepository = join(root, "example-ios");
    const configPath = join(root, "config.yml");
    const resolver = join(root, "resolver.mjs");
    execFileSync("git", ["init", "--quiet", webRepository]);
    execFileSync("git", ["init", "--quiet", iosRepository]);
    writeFileSync(
      resolver,
      `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.stdout.write(
  input.includes("/postgres")
    ? "postgresql://postgres:configured@db.example.test/postgres"
    : "configured"
));`
    );
    writeFileSync(
      configPath,
      `
version: 1
database: queue.sqlite
vault_command:
  - ${process.execPath}
  - ${resolver}
chambers:
  example-platform:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/example-platform/secret
      management_token: vault://supabase/example-platform/management
      database_access: vault://supabase/example-platform/postgres
projects:
  example-web:
    repo: ${webRepository}
    chamber: example-platform
    migrations: consumer
    capabilities: [migrations]
  example-ios:
    repo: ${iosRepository}
    chamber: example-platform
    migrations: owner
    capabilities: [migrations]
`
    );
    const output: string[] = [];
    const runtime = {
      cwd: root,
      homeDirectory: root,
      environment: {},
      question: async () => "",
      defaultVaultCommand: undefined,
      promptSecret: { read: async () => "unused" },
      keychain: () => new MemoryVault()
    };
    const io = {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text)
    };

    expect(await runCli([
      "project", "migrations", "owner", "example-web",
      "--config", configPath
    ], io, runtime)).toBe(0);
    expect(await runCli([
      "project", "migrations", "driver", "example-web", "prisma",
      "--config", configPath
    ], io, runtime)).toBe(0);
    expect(await runCli([
      "project", "live", "example-web", "--config", configPath
    ], io, runtime)).toBe(0);
    expect(loadConfig(configPath).projects["example-web"]).toMatchObject({
      migrations: "owner",
      migration_driver: "prisma",
      mode: "live"
    });
    expect(loadConfig(configPath).projects["example-ios"]?.migrations)
      .toBe("consumer");

    expect(await runCli([
      "project", "dry-run", "example-web", "--config", configPath
    ], io, runtime)).toBe(0);
    expect(loadConfig(configPath).projects["example-web"]?.mode)
      .toBe("dry-run");
  });

  test("refuses live mode when database access is not a PostgreSQL URI", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-invalid-db-"));
    const repository = join(root, "example-ios");
    const resolver = join(root, "resolver.mjs");
    const configPath = join(root, "config.yml");
    execFileSync("git", ["init", "--quiet", repository]);
    writeFileSync(
      resolver,
      `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.stdout.write(
  input.includes("/postgres") ? "password-only" : "configured"
));`
    );
    addProject({
      alias: "example-ios",
      repository,
      project_ref: "abcdefghijklmnopqrst",
      profile: "development",
      config_path: configPath,
      vault_command: [process.execPath, resolver]
    });

    await expect(runCli(
      ["project", "live", "example-ios", "--config", configPath],
      {
        stdout: () => undefined,
        stderr: () => undefined
      },
      {
        cwd: root,
        homeDirectory: root,
        environment: {},
        question: async () => "",
        defaultVaultCommand: undefined,
        promptSecret: { read: async () => "unused" },
        keychain: () => new MemoryVault()
      }
    )).rejects.toThrow(
      "Project example-ios is not ready"
    );
    expect(loadConfig(configPath).projects["example-ios"]?.mode)
      .toBe("dry-run");
  });

  test("repairs an existing repository without re-discovering its configured ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-repair-"));
    const repository = join(root, "Documents", "example-service");
    const frontend = join(repository, "frontend");
    const configPath = join(root, "config.yml");
    mkdirSync(frontend, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository]);
    writeFileSync(
      join(repository, ".env"),
      "SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\n"
    );
    writeFileSync(
      join(frontend, ".env.local"),
      "VITE_SUPABASE_URL=https://zyxwvutsrqponmlkjihg.supabase.co\n"
    );
    writeFileSync(
      configPath,
      `
version: 1
projects:
  example-service:
    project_ref: zyxwvutsrqponmlkjihg
    credentials:
      secret_key: vault://supabase/example-service/secret
      management_token: vault://supabase/example-service/management
      database_access: vault://supabase/example-service/postgres
    capabilities: [project-management]
`
    );
    const output: string[] = [];

    expect(await runCli(
      ["project", "setup", "example-service", "--config", configPath],
      {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text)
      },
      {
        cwd: root,
        homeDirectory: root,
        environment: {},
        question: async () => "",
        defaultVaultCommand: undefined,
        promptSecret: { read: async () => "unused" },
        keychain: () => new MemoryVault()
      }
    )).toBe(0);
    expect(loadConfig(configPath).projects["example-service"]?.repo)
      .toContain("/Documents/example-service");
    expect(output.join("")).toContain(
      "supadrum project credentials set example-service"
    );
  });

  test("sets missing project credentials without exposing their values", async () => {
    const { root, configPath } = credentialConfig([
      process.execPath,
      "/package/dist/vault-cli.js",
      "keychain",
      "resolve"
    ]);
    const vault = new MemoryVault();
    const labels: string[] = [];
    const values = [
      "secret-key-canary",
      "management-canary",
      "postgresql://postgres:database-canary@db.example.test/postgres"
    ];
    const promptSecret: SecretPrompt = {
      async read(label) {
        labels.push(label);
        const value = values.shift();
        if (!value) throw new Error("Prompt queue exhausted");
        return value;
      }
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runtime = {
      cwd: root,
      homeDirectory: root,
      environment: {},
      question: async () => "",
      defaultVaultCommand: undefined,
      promptSecret,
      keychain: () => vault
    };

    const code = await runCli(
      [
        "project",
        "credentials",
        "set",
        "example-ios",
        "--config",
        configPath
      ],
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text)
      },
      runtime
    );

    expect(code).toBe(0);
    expect(labels).toEqual([
      "Secret key",
      "Management token",
      "Database access"
    ]);
    const output = stdout.join("");
    expect(output).toContain("Supadrum credentials — example-ios");
    expect(output).toContain(
      "It does not send secret values"
    );
    expect(output).toContain(
      "them in MCP messages or LLM prompts."
    );
    expect(output).toContain(
      "This reduces accidental exposure compared with plaintext .env files."
    );
    expect(output).toContain(
      "Use a dedicated"
    );
    expect(output).toContain(
      "https://supabase.com/dashboard/project/abcdefghijklmnopqrst/settings/api-keys"
    );
    expect(output).toContain(
      'name it "supadrum_example_ios", then choose Create API key.'
    );
    expect(output).toContain(
      "https://supabase.com/dashboard/account/tokens"
    );
    expect(output).toContain(
      "A Supabase Personal Access Token for Management API and CLI."
    );
    expect(output).toContain(
      "The complete PostgreSQL connection string, including its password."
    );
    expect(output).toContain(
      "https://supabase.com/dashboard/project/abcdefghijklmnopqrst/database/settings"
    );
    expect(output.indexOf("Secret key")).toBeLessThan(
      output.indexOf("✓ Project ready")
    );
    expect(output).toContain("✓ Project ready");
    expect(output).not.toMatch(
      /canary|vault:\/\/|supadrum-vault/
    );
    expect(stderr).toEqual([]);
  });

  test("replaces one selected credential through the masked wizard", async () => {
    const { root, configPath } = credentialConfig([
      process.execPath,
      "/package/dist/vault-cli.js",
      "keychain",
      "resolve"
    ]);
    const vault = new MemoryVault();
    vault.values.set(
      "vault://supabase/example-ios/secret",
      "existing-secret"
    );
    vault.values.set(
      "vault://supabase/example-ios/management",
      "existing-management"
    );
    vault.values.set(
      "vault://supabase/example-ios/postgres",
      "invalid-existing-value"
    );
    const labels: string[] = [];

    expect(await runCli(
      [
        "project",
        "credentials",
        "set",
        "example-ios",
        "--replace",
        "database_access",
        "--config",
        configPath
      ],
      {
        stdout: () => undefined,
        stderr: () => undefined
      },
      {
        cwd: root,
        homeDirectory: root,
        environment: {},
        question: async () => "",
        defaultVaultCommand: undefined,
        promptSecret: {
          read: async (label) => {
            labels.push(label);
            return "postgresql://postgres:correct@db.example.test/postgres";
          }
        },
        keychain: () => vault
      }
    )).toBe(0);
    expect(labels).toEqual(["Database access"]);
    expect(
      vault.values.get("vault://supabase/example-ios/postgres")
    ).toBe(
      "postgresql://postgres:correct@db.example.test/postgres"
    );
  });

  test("rejects a read-only resolver before prompting", async () => {
    const { root, configPath } = credentialConfig([
      "supadrum-vault",
      "sops",
      "resolve",
      "--file",
      "/operator/secrets.enc.json"
    ]);
    let prompts = 0;
    const runtime = {
      cwd: root,
      homeDirectory: root,
      environment: {},
      question: async () => "",
      defaultVaultCommand: undefined,
      promptSecret: {
        async read() {
          prompts += 1;
          return "must-not-be-read";
        }
      },
      keychain: () => new MemoryVault()
    };

    await expect(
      runCli(
        [
          "project",
          "credentials",
          "set",
          "example-ios",
          "--config",
          configPath
        ],
        {
          stdout: () => undefined,
          stderr: () => undefined
        },
        runtime
      )
    ).rejects.toThrow(
      "Configured vault backend does not support interactive writes"
    );
    expect(prompts).toBe(0);
  });

  test("creates initialized operator config with owner-only permissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-init-"));
    const configPath = join(root, "config", "supadrum.yml");

    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cliSource, "init", configPath],
      { cwd: repositoryRoot }
    );

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("runs an isolated end-to-end dry-run demo", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "demo"],
      { cwd: process.cwd() }
    );

    const result = JSON.parse(stdout) as {
      status: string;
      operation: string;
      credentials_persisted: boolean;
    };
    expect(result).toMatchObject({
      status: "completed",
      operation: "migration.plan",
      credentials_persisted: false
    });
    expect(stderr).toBe("");
  });

  test("adds a sibling project from an unrelated Supadrum root", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-add-"));
    const cwd = join(root, "supadrum");
    const project = join(root, "example-ios");
    const configHome = join(root, "operator");
    const configPath = join(
      configHome,
      "supadrum",
      "config.yml"
    );
    mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet", project]);
    mkdirSync(join(project, "supabase", ".temp"), { recursive: true });
    writeFileSync(
      join(project, "supabase", ".temp", "project-ref"),
      "abcdefghijklmnopqrst\n"
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        cliSource,
        "project",
        "add",
        "example-ios",
        "--json"
      ],
      {
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome }
      }
    );

    const result = JSON.parse(stdout) as {
      added: boolean;
      alias: string;
      repository: string;
      project_ref: string;
      ready: boolean;
      missing_credentials: string[];
      agent_setup: {
        ready: boolean;
        restart_required: boolean;
      };
    };
    const config = parse(readFileSync(configPath, "utf8")) as {
      executor: string;
      projects: Record<string, { repo: string }>;
    };
    expect(result).toMatchObject({
      added: true,
      alias: "example-ios",
      project_ref: "abcdefghijklmnopqrst",
      ready: false,
      missing_credentials: [
        "secret_key",
        "management_token",
        "database_access"
      ],
      agent_setup: {
        ready: true,
        restart_required: true
      }
    });
    expect(result.repository).toContain("/example-ios");
    expect(config.executor).toBe("dry-run");
    expect(config.projects["example-ios"]?.repo).toContain("/example-ios");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(
      readFileSync(
        join(project, ".agents", "skills", "supadrum", "SKILL.md"),
        "utf8"
      )
    ).toContain("name: supadrum");
    expect(
      readFileSync(join(project, ".codex", "config.toml"), "utf8")
    ).toContain(`SUPADRUM_CONFIG = ${JSON.stringify(configPath)}`);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain(
      "$supadrum"
    );
    expect(stderr).toBe("");

    const listed = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cliSource, "project", "list"],
      {
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome }
      }
    );
    expect(JSON.parse(listed.stdout)).toEqual([
      {
        name: "example-ios",
        project_ref: "abcdefghijklmnopqrst"
      }
    ]);
    expect(listed.stderr).toBe("");

    const inspected = await execFileAsync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        cliSource,
        "project",
        "inspect",
        "example-ios",
        "--json"
      ],
      {
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome }
      }
    );
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      name: "example-ios",
      repo: expect.stringContaining("/example-ios"),
      project_ref: "abcdefghijklmnopqrst",
      executor: "dry-run"
    });
    expect(inspected.stdout).not.toContain("vault://");
    expect(inspected.stderr).toBe("");
  });

  test("adds a local project without discovering or requesting a remote ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-local-"));
    const repository = join(root, "materic-ai");
    const configPath = join(root, "operator", "config.yml");
    execFileSync("git", ["init", "--quiet", repository]);

    const chunks: string[] = [];
    expect(await runCli(
      [
        "project",
        "add",
        "materic-ai-local",
        "--local",
        "--repo",
        repository,
        "--config",
        configPath,
        "--no-agent-setup",
        "--json"
      ],
      {
        stdout: (value) => chunks.push(value),
        stderr: () => undefined
      },
      {
        cwd: root,
        homeDirectory: root,
        environment: {},
        question: async () => {
          throw new Error("local setup must not prompt");
        },
        defaultVaultCommand: undefined,
        promptSecret: { read: async () => "unused" },
        keychain: () => new MemoryVault()
      }
    )).toBe(0);

    expect(JSON.parse(chunks.join(""))).toMatchObject({
      added: true,
      alias: "materic-ai-local",
      target: "local",
      ready: true
    });
    expect(loadConfig(configPath).projects["materic-ai-local"]).toMatchObject({
      target: "local",
      mode: "live",
      capabilities: ["migrations"]
    });
  });

  test("supports opting out and repairing Codex setup later", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-agent-"));
    const cwd = join(root, "supadrum");
    const project = join(root, "example-ios");
    const configHome = join(root, "operator");
    mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet", project]);
    mkdirSync(join(project, "supabase", ".temp"), { recursive: true });
    writeFileSync(
      join(project, "supabase", ".temp", "project-ref"),
      "abcdefghijklmnopqrst\n"
    );

    const added = await execFileAsync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        cliSource,
        "project",
        "add",
        "example-ios",
        "--no-agent-setup",
        "--json"
      ],
      {
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome }
      }
    );
    expect(JSON.parse(added.stdout)).toMatchObject({
      agent_setup: { skipped: true }
    });
    expect(
      existsSync(join(project, ".agents", "skills", "supadrum"))
    ).toBe(false);

    const repaired = await execFileAsync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        cliSource,
        "project",
        "setup",
        "example-ios"
      ],
      {
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome }
      }
    );

    expect(repaired.stdout).toContain("✓ Codex agent");
    expect(
      readFileSync(
        join(project, ".agents", "skills", "supadrum", "SKILL.md"),
        "utf8"
      )
    ).toContain("name: supadrum");
    expect(repaired.stderr).toBe("");
  });
});

describe("operator CLI: queue commands", () => {
  function queueConfig() {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-queue-"));
    const repository = join(root, "example-ios");
    const configPath = join(root, "config.yml");
    execFileSync("git", ["init", "--quiet", repository]);
    addProject({
      alias: "example-ios",
      repository,
      project_ref: "abcdefghijklmnopqrst",
      profile: "admin",
      config_path: configPath
    });
    // Setting the key through the parser rather than substituting the string
    // addProject happens to write: a substitution that stopped matching would
    // leave the queue on automatic approval, and only some of these tests
    // would notice.
    const document = parse(readFileSync(configPath, "utf8"));
    document.approval_mode = "manual";
    writeFileSync(configPath, stringify(document));
    const config = loadConfig(configPath);
    if (config.approval_mode !== "manual") {
      throw new Error("fixture failed to require approval");
    }
    const store = new SqliteStore(
      config.database_path,
      undefined,
      config.approval_mode
    );
    const job = store.submit({
      project: "example-ios",
      operation: "migration.apply",
      payload: { migration: "0001.sql" },
      repo_sha: "abc123",
      idempotency_key: "example-ios:abc123:apply"
    });
    store.transition(job.id, "waiting_approval");
    store.close();
    return { configPath, jobId: job.id };
  }

  test("records the approver from the declared environment", async () => {
    const { configPath, jobId } = queueConfig();
    const harness = cli({ environment: { USER: "declared-operator" } });

    expect(
      await runCli(
        ["approve", jobId, "--config", configPath],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    expect(JSON.parse(harness.stdout())).toMatchObject({
      id: jobId,
      approved_by: "declared-operator",
      status: "queued"
    });
  });

  test("prefers an explicit --actor over the environment", async () => {
    const { configPath, jobId } = queueConfig();
    const harness = cli({ environment: { USER: "declared-operator" } });

    await runCli(
      ["approve", jobId, "--actor", "release-bot", "--config", configPath],
      harness.io,
      harness.runtime
    );

    expect(JSON.parse(harness.stdout())).toMatchObject({
      approved_by: "release-bot"
    });
  });

  test("reports a job's state without touching it", async () => {
    const { configPath, jobId } = queueConfig();
    const harness = cli();

    expect(
      await runCli(
        ["status", jobId, "--config", configPath],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    expect(JSON.parse(harness.stdout())).toMatchObject({
      id: jobId,
      status: "waiting_approval",
      approved_by: null
    });
  });

  test("refuses approve and status without a job id", async () => {
    const { configPath } = queueConfig();
    const harness = cli();

    await expect(
      runCli(["approve", "--config", configPath], harness.io, harness.runtime)
    ).rejects.toThrow("Usage: supadrum approve <job-id>");
    await expect(
      runCli(["status", "--config", configPath], harness.io, harness.runtime)
    ).rejects.toThrow("Usage: supadrum status <job-id>");
  });
});

describe("operator CLI: read-only commands", () => {
  function twoProjects() {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-read-"));
    const configPath = join(root, "config.yml");
    for (const alias of ["zulu-app", "alpha-app"]) {
      const repository = join(root, alias);
      execFileSync("git", ["init", "--quiet", repository]);
      addProject({
        alias,
        repository,
        project_ref: "abcdefghijklmnopqrst",
        profile: "development",
        config_path: configPath
      });
    }
    return { root, configPath };
  }

  test("inspects a project without printing credential references", async () => {
    const { configPath } = twoProjects();
    const harness = cli();

    expect(
      await runCli(
        ["project", "inspect", "alpha-app", "--config", configPath],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    expect(harness.stdout()).toContain("Project: alpha-app");
    expect(harness.stdout()).toContain("Supabase ref: abcdefghijklmnopqrst");
    expect(harness.stdout()).not.toContain("vault://");
  });

  test("keeps credential references out of inspect --json too", async () => {
    const { configPath } = twoProjects();
    const harness = cli();

    await runCli(
      ["project", "inspect", "alpha-app", "--config", configPath, "--json"],
      harness.io,
      harness.runtime
    );

    const report = JSON.parse(harness.stdout());
    expect(report).toMatchObject({
      name: "alpha-app",
      credentials: ["database_access", "management_token", "secret_key"]
    });
    expect(harness.stdout()).not.toContain("vault://");
  });

  test("lists every project sorted, under both spellings", async () => {
    const { configPath } = twoProjects();
    const viaProjects = cli();
    const viaProjectList = cli();

    await runCli(
      ["projects", "--config", configPath],
      viaProjects.io,
      viaProjects.runtime
    );
    await runCli(
      ["project", "list", "--config", configPath],
      viaProjectList.io,
      viaProjectList.runtime
    );

    expect(JSON.parse(viaProjects.stdout())).toEqual([
      { name: "alpha-app", project_ref: "abcdefghijklmnopqrst" },
      { name: "zulu-app", project_ref: "abcdefghijklmnopqrst" }
    ]);
    expect(viaProjectList.stdout()).toBe(viaProjects.stdout());
  });

  test("reports unresolvable credentials as not ready", async () => {
    const { configPath } = twoProjects();
    const harness = cli();

    expect(
      await runCli(
        ["project", "doctor", "alpha-app", "--config", configPath, "--json"],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    expect(JSON.parse(harness.stdout())).toMatchObject({
      project: "alpha-app",
      ready: false,
      missing_credentials: [
        "secret_key",
        "management_token",
        "database_access"
      ]
    });
  });

  test("doctors every configured project in sorted order", async () => {
    const { configPath } = twoProjects();
    const harness = cli();

    await runCli(
      ["project", "doctor", "--all", "--config", configPath, "--json"],
      harness.io,
      harness.runtime
    );

    expect(
      JSON.parse(harness.stdout()).map(
        (report: { project: string }) => report.project
      )
    ).toEqual(["alpha-app", "zulu-app"]);
  });

  test("renders a doctor report as text when not asked for JSON", async () => {
    const { configPath } = twoProjects();
    const harness = cli();

    await runCli(
      ["project", "doctor", "alpha-app", "--config", configPath],
      harness.io,
      harness.runtime
    );

    expect(harness.stdout()).toContain("alpha-app");
    expect(harness.stdout()).not.toContain("vault://");
    expect(() => JSON.parse(harness.stdout())).toThrow();
  });
});

describe("operator CLI: bootstrap commands", () => {
  test("writes a starter config only the operator can read", async () => {
    const harness = cli();
    const configPath = join(harness.root, "nested", "supadrum.yml");

    expect(
      await runCli(["init", configPath], harness.io, harness.runtime)
    ).toBe(0);

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(loadConfig(configPath).projects).toBeDefined();
  });

  test("refuses to overwrite a config that already exists", async () => {
    const harness = cli();
    const configPath = join(harness.root, "supadrum.yml");
    writeFileSync(configPath, "version: 1\nprojects: {}\n");

    await expect(
      runCli(["init", configPath], harness.io, harness.runtime)
    ).rejects.toThrow();

    expect(readFileSync(configPath, "utf8")).toBe("version: 1\nprojects: {}\n");
  });

  test("demo completes a job without persisting any credential", async () => {
    const harness = cli();

    expect(await runCli(["demo"], harness.io, harness.runtime)).toBe(0);

    expect(JSON.parse(harness.stdout())).toMatchObject({
      status: "completed",
      operation: "migration.plan",
      credentials_persisted: false
    });
  });

  test("prints usage without spawning a process", async () => {
    const harness = cli();

    expect(await runCli(["--help"], harness.io, harness.runtime)).toBe(0);

    expect(harness.stdout()).toContain("supadrum project add");
    expect(harness.stdout()).toContain("supadrum approve <job-id>");
    expect(harness.stderr()).toBe("");
  });

  test("answers an unknown command on stderr with a failing code", async () => {
    const harness = cli();

    expect(
      await runCli(["teleport"], harness.io, harness.runtime)
    ).toBe(1);

    expect(harness.stderr()).toContain("Usage: supadrum");
    expect(harness.stdout()).toBe("");
  });
});

describe("operator CLI: input validation and prompting", () => {
  function bareProject() {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-validate-"));
    // Discovery walks up from cwd and home, so an unrelated directory is the
    // only way to reach the prompt: a sibling of the repo would be found.
    const away = mkdtempSync(join(tmpdir(), "supadrum-cli-away-"));
    const repository = join(root, "example-ios");
    const configPath = join(root, "config.yml");
    execFileSync("git", ["init", "--quiet", repository]);
    return { root, away, repository, configPath };
  }

  test("rejects a mistyped profile instead of falling back to a default", async () => {
    const { root, repository, configPath } = bareProject();
    const harness = cli({ cwd: root });

    await expect(
      runCli(
        [
          "project", "add", "example-ios",
          "--repo", repository,
          "--project-ref", "abcdefghijklmnopqrst",
          "--profile", "developement",
          "--config", configPath,
          "--no-agent-setup", "--yes"
        ],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("Unknown profile: developement");
    expect(existsSync(configPath)).toBe(false);
  });

  test("rejects an unknown credential name for --replace", async () => {
    const { configPath } = credentialConfig([
      process.execPath,
      join(repositoryRoot, "dist", "vault-cli.js"),
      "keychain",
      "resolve"
    ]);
    const harness = cli();

    await expect(
      runCli(
        [
          "project", "credentials", "set", "example-ios",
          "--replace", "secret-key",
          "--config", configPath
        ],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow(
      "Credential must be secret_key, management_token, or database_access"
    );
  });

  test("fails loudly under --yes rather than waiting for an answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-noninteractive-"));
    const harness = cli({
      cwd: root,
      question: async () => {
        throw new Error("--yes must never prompt");
      }
    });

    await expect(
      runCli(
        [
          "project", "add", "nowhere-app",
          "--project-ref", "abcdefghijklmnopqrst",
          "--config", join(root, "config.yml"),
          "--no-agent-setup", "--yes"
        ],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("Could not discover repo; pass --repo");
  });

  test("asks for an undiscoverable repository when allowed to prompt", async () => {
    const { away, repository, configPath } = bareProject();
    const asked: string[] = [];
    const harness = cli({
      cwd: away,
      question: async (prompt: string) => {
        asked.push(prompt);
        return `  ${repository}  `;
      }
    });

    expect(
      await runCli(
        [
          "project", "add", "example-ios",
          "--project-ref", "abcdefghijklmnopqrst",
          "--config", configPath,
          "--no-agent-setup", "--json"
        ],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    expect(asked).toEqual(["Repository path: "]);
    expect(loadConfig(configPath).projects["example-ios"]?.repo).toBe(
      realpathSync(repository)
    );
  });

  test("refuses an empty answer instead of storing it", async () => {
    const { away, configPath } = bareProject();
    const harness = cli({
      cwd: away,
      question: async () => "   "
    });

    await expect(
      runCli(
        [
          "project", "add", "example-ios",
          "--project-ref", "abcdefghijklmnopqrst",
          "--config", configPath,
          "--no-agent-setup"
        ],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("repo is required");
    expect(existsSync(configPath)).toBe(false);
  });

  test("refuses doctor without an alias", async () => {
    const { configPath } = credentialConfig([process.execPath, "-e", "0"]);
    const harness = cli();

    await expect(
      runCli(
        ["project", "doctor", "--config", configPath],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("Usage: supadrum project doctor <alias>");
  });
});

describe("operator CLI: chamber adoption during setup", () => {
  const SHARED_REF = "abcdefghijklmnopqrst";

  /** A vault that answers for the named chambers only, so a peer can be
   *  complete while the project under setup is not. */
  function resolver(root: string, completeChambers: readonly string[]) {
    const path = join(root, "resolver.mjs");
    writeFileSync(
      path,
      `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const complete = ${JSON.stringify(completeChambers)};
  const known = complete.some(name => input.includes("/" + name + "/"));
  if (!known) { process.exitCode = 1; process.stdout.write(""); return; }
  process.stdout.write(
    input.includes("/postgres")
      ? "postgresql://postgres:configured@db.example.test/postgres"
      : "configured"
  );
});`
    );
    return [process.execPath, path];
  }

  function withPeers(completeChambers: readonly string[]) {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-adopt-"));
    const configPath = join(root, "config.yml");
    const vaultCommand = resolver(root, completeChambers);
    for (const alias of ["target-app", "peer-one", "peer-two"]) {
      const repository = join(root, alias);
      execFileSync("git", ["init", "--quiet", repository]);
      addProject({
        alias,
        repository,
        project_ref: SHARED_REF,
        profile: "development",
        config_path: configPath,
        vault_command: vaultCommand
      });
    }
    return { root, configPath };
  }

  test("adopts the chamber of the one peer whose credentials resolve", async () => {
    const { root, configPath } = withPeers(["peer-one"]);
    const harness = cli({ cwd: root });

    expect(
      await runCli(
        ["project", "setup", "target-app", "--config", configPath,
         "--no-agent-setup"],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    expect(loadConfig(configPath).projects["target-app"]?.chamber).toBe(
      "peer-one"
    );
  });

  test("leaves the chamber alone when two peers could both be adopted", async () => {
    const { root, configPath } = withPeers(["peer-one", "peer-two"]);
    const harness = cli({ cwd: root });

    await runCli(
      ["project", "setup", "target-app", "--config", configPath,
       "--no-agent-setup"],
      harness.io,
      harness.runtime
    );

    // Adopting either one would silently bind the project to credentials the
    // operator never chose.
    expect(loadConfig(configPath).projects["target-app"]?.chamber).toBe(
      "target-app"
    );
  });

  test("refuses setup for a project the config does not define", async () => {
    const { root, configPath } = withPeers([]);
    const harness = cli({ cwd: root });

    await expect(
      runCli(
        ["project", "setup", "ghost-app", "--config", configPath],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("Unknown project: ghost-app");
  });

  test("refuses credentials set for a project the config does not define", async () => {
    const { root, configPath } = withPeers([]);
    const harness = cli({ cwd: root });

    await expect(
      runCli(
        ["project", "credentials", "set", "ghost-app", "--config", configPath],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("Unknown project: ghost-app");
  });
});

describe("operator CLI: failure paths that guide the operator", () => {
  const keychainVaultCommand = [
    process.execPath,
    join(repositoryRoot, "dist", "vault-cli.js"),
    "keychain",
    "resolve"
  ];

  test("points at setup when the alias is already configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-dup-"));
    const repository = join(root, "example-ios");
    const configPath = join(root, "config.yml");
    execFileSync("git", ["init", "--quiet", repository]);
    addProject({
      alias: "example-ios",
      repository,
      project_ref: "abcdefghijklmnopqrst",
      profile: "development",
      config_path: configPath
    });
    const harness = cli({ cwd: root });

    await expect(
      runCli(
        [
          "project", "add", "example-ios",
          "--repo", repository,
          "--project-ref", "abcdefghijklmnopqrst",
          "--config", configPath,
          "--no-agent-setup", "--yes"
        ],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("Next: supadrum project setup example-ios");
  });

  test("rejects a migration driver that is neither supabase nor prisma", async () => {
    const { configPath } = credentialConfig(keychainVaultCommand);
    const harness = cli();

    await expect(
      runCli(
        [
          "project", "migrations", "driver", "example-ios", "sqlite",
          "--config", configPath
        ],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("Migration driver must be supabase or prisma, got sqlite");
  });

  test("says where to pass a repository it cannot discover", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-norepo-"));
    const away = mkdtempSync(join(tmpdir(), "supadrum-cli-norepo-away-"));
    const configPath = join(root, "config.yml");
    writeFileSync(
      configPath,
      `version: 1
database: queue.sqlite
projects:
  orphan-app:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/orphan-app/secret
      management_token: vault://supabase/orphan-app/management
      database_access: vault://supabase/orphan-app/postgres
    capabilities: [migrations]
`
    );
    const harness = cli({ cwd: away });

    await expect(
      runCli(
        ["project", "setup", "orphan-app", "--config", configPath],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow(
      "Repository not found for orphan-app; pass it with project add --repo"
    );
  });

  test("surfaces a keychain failure while collecting credentials", async () => {
    const { configPath } = credentialConfig(keychainVaultCommand);
    class LockedKeychain extends MemoryVault {
      override async get(): Promise<string> {
        throw new Error("The user name or passphrase you entered is not correct");
      }
    }
    const harness = cli({
      keychain: () => new LockedKeychain(),
      promptSecret: { read: async () => "typed-secret" }
    });

    await expect(
      runCli(
        ["project", "credentials", "set", "example-ios", "--config", configPath],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow("passphrase you entered is not correct");
  });

  test("renders every project's doctor report as text", async () => {
    const { configPath } = credentialConfig(keychainVaultCommand);
    const harness = cli();

    await runCli(
      ["project", "doctor", "--all", "--config", configPath],
      harness.io,
      harness.runtime
    );

    expect(harness.stdout()).toContain("example-ios");
    expect(() => JSON.parse(harness.stdout())).toThrow();
  });
});


describe("operator CLI: human-readable output and agent wiring", () => {
  function bare(prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const repository = join(root, "example-ios");
    execFileSync("git", ["init", "--quiet", repository]);
    return { root, repository, configPath: join(root, "config.yml") };
  }

  test("summarises a remote project in prose when not asked for JSON", async () => {
    const { root, repository, configPath } = bare("supadrum-cli-prose-");
    const harness = cli({ cwd: root });

    expect(
      await runCli(
        [
          "project", "add", "example-ios",
          "--repo", repository,
          "--project-ref", "abcdefghijklmnopqrst",
          "--config", configPath,
          "--no-agent-setup", "--yes"
        ],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    expect(harness.stdout()).toContain("example-ios");
    expect(harness.stdout()).not.toContain("vault://");
    expect(() => JSON.parse(harness.stdout())).toThrow();
  });

  test("summarises a local project in prose", async () => {
    const { root, repository, configPath } = bare("supadrum-cli-prose-local-");
    const harness = cli({ cwd: root });

    await runCli(
      [
        "project", "add", "example-ios", "--local",
        "--repo", repository,
        "--config", configPath,
        "--no-agent-setup"
      ],
      harness.io,
      harness.runtime
    );

    expect(harness.stdout()).toContain("Target       local");
    expect(harness.stdout()).toContain("Mode         live");
  });

  test("installs the Codex agent files when a setup is configured", async () => {
    const { root, repository, configPath } = bare("supadrum-cli-codex-");
    const harness = cli({
      cwd: root,
      codexAgentSetup: {
        skillSource: join(
          repositoryRoot, "plugins", "supadrum", "skills", "supadrum"
        ),
        mcpCommand: process.execPath,
        mcpArgs: [join(repositoryRoot, "dist", "mcp.js")],
        mcpCwd: repositoryRoot
      }
    });

    expect(
      await runCli(
        [
          "project", "add", "example-ios",
          "--repo", repository,
          "--project-ref", "abcdefghijklmnopqrst",
          "--config", configPath,
          "--yes", "--json"
        ],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    const report = JSON.parse(harness.stdout());
    expect(report.agent_setup).toMatchObject({ ready: true });
    expect(existsSync(report.agent_setup.skill_path)).toBe(true);
    expect(existsSync(report.agent_setup.codex_config_path)).toBe(true);
  });

  test("reports a project whose vault command fails as not ready", async () => {
    const harness = cli();
    const { configPath } = credentialConfig([
      process.execPath,
      "-e",
      "process.exit(3)"
    ]);

    await runCli(
      ["project", "doctor", "example-ios", "--config", configPath, "--json"],
      harness.io,
      harness.runtime
    );

    expect(JSON.parse(harness.stdout())).toMatchObject({
      project: "example-ios",
      ready: false
    });
  });
});

describe("operator CLI: misconfiguration is reported, not crashed on", () => {
  test("survives a vault command that cannot be executed at all", async () => {
    const { configPath } = credentialConfig([
      join(tmpdir(), "supadrum-no-such-binary")
    ]);
    const harness = cli();

    expect(
      await runCli(
        ["project", "doctor", "example-ios", "--config", configPath, "--json"],
        harness.io,
        harness.runtime
      )
    ).toBe(0);

    expect(JSON.parse(harness.stdout())).toMatchObject({
      project: "example-ios",
      ready: false
    });
  });

  test("does not attach the setup hint to an unrelated failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-cli-notgit-"));
    const repository = join(root, "plain-directory");
    mkdirSync(repository);
    const harness = cli({ cwd: root });

    await expect(
      runCli(
        [
          "project", "add", "example-ios",
          "--repo", repository,
          "--project-ref", "abcdefghijklmnopqrst",
          "--config", join(root, "config.yml"),
          "--no-agent-setup", "--yes"
        ],
        harness.io,
        harness.runtime
      )
    ).rejects.toThrow(`Not a Git repository: ${repository}`);
    expect(harness.stdout()).not.toContain("Next: supadrum project setup");
  });
});

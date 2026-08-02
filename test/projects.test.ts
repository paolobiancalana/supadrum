import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  addLocalProject,
  addProject,
  discoverProject,
  doctorProject,
  resolveOperatorConfigPath,
  setMigrationOwner,
  setProjectMode
} from "../src/projects.js";

function createGitRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
}

describe("project discovery", () => {
  test("finds a sibling repository and its linked Supabase project ref", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-discovery-"));
    const cwd = join(root, "supadrum");
    const repository = join(root, "example-ios");
    mkdirSync(cwd);
    createGitRepository(repository);
    mkdirSync(join(repository, "supabase", ".temp"), { recursive: true });
    writeFileSync(
      join(repository, "supabase", ".temp", "project-ref"),
      "abcdefghijklmnopqrst\n"
    );

    expect(
      discoverProject({
        alias: "example-ios",
        cwd,
        homeDirectory: join(root, "home")
      })
    ).toEqual({
      alias: "example-ios",
      repository: realpathSync(repository),
      project_ref: "abcdefghijklmnopqrst",
      repository_source: "sibling",
      project_ref_source: "supabase/.temp/project-ref"
    });
  });

  test("finds the current repository when launched from a nested directory", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-nested-repo-"));
    const repository = join(root, "example-ios");
    const cwd = join(repository, "frontend", "src");
    createGitRepository(repository);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(repository, "supabase", ".temp"), { recursive: true });
    writeFileSync(
      join(repository, "supabase", ".temp", "project-ref"),
      "abcdefghijklmnopqrst\n"
    );

    expect(
      discoverProject({
        alias: "example-ios",
        cwd,
        homeDirectory: join(root, "home")
      })
    ).toMatchObject({
      repository: realpathSync(repository),
      project_ref: "abcdefghijklmnopqrst",
      repository_source: "cwd"
    });
  });

  test("infers the ref only from allow-listed public Supabase URL variables", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-public-url-"));
    const repository = join(root, "example-ios");
    createGitRepository(repository);
    mkdirSync(join(repository, "frontend"), { recursive: true });
    writeFileSync(
      join(repository, "frontend", ".env.local"),
      [
        "SUPABASE_SERVICE_ROLE_KEY=must-not-be-returned",
        "VITE_SUPABASE_URL=https://zyxwvutsrqponmlkjihg.supabase.co",
        ""
      ].join("\n")
    );

    const discovered = discoverProject({
      alias: "example-ios",
      cwd: repository,
      homeDirectory: join(root, "home")
    });

    expect(discovered.project_ref).toBe("zyxwvutsrqponmlkjihg");
    expect(discovered.project_ref_source).toBe(
      "frontend/.env.local:VITE_SUPABASE_URL"
    );
    expect(JSON.stringify(discovered)).not.toContain(
      "must-not-be-returned"
    );
  });

  test("rejects an explicit ref that contradicts linked repository metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-ref-mismatch-"));
    const repository = join(root, "example-ios");
    createGitRepository(repository);
    mkdirSync(join(repository, "supabase", ".temp"), { recursive: true });
    writeFileSync(
      join(repository, "supabase", ".temp", "project-ref"),
      "abcdefghijklmnopqrst\n"
    );

    expect(() =>
      discoverProject({
        alias: "example-ios",
        cwd: repository,
        homeDirectory: join(root, "home"),
        project_ref: "zyxwvutsrqponmlkjihg"
      })
    ).toThrow("does not match repository metadata");
  });

  test("rejects conflicting public Supabase URLs in one repository", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-ref-conflict-"));
    const repository = join(root, "example-ios");
    createGitRepository(repository);
    mkdirSync(join(repository, "frontend"), { recursive: true });
    writeFileSync(
      join(repository, ".env.local"),
      "SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\n"
    );
    writeFileSync(
      join(repository, "frontend", ".env.local"),
      "VITE_SUPABASE_URL=https://zyxwvutsrqponmlkjihg.supabase.co\n"
    );

    expect(() =>
      discoverProject({
        alias: "example-ios",
        cwd: repository,
        homeDirectory: join(root, "home")
      })
    ).toThrow("Conflicting Supabase project refs");
  });
});

describe("operator config discovery", () => {
  test("uses an existing local config before the global default", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-config-path-"));
    const local = join(root, "supadrum.yml");
    writeFileSync(local, "version: 1\n");

    expect(
      resolveOperatorConfigPath({
        args: [],
        environment: {},
        cwd: root,
        homeDirectory: join(root, "home")
      })
    ).toBe(local);
  });

  test("reuses an existing dot-supadrum operator config", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-config-path-"));
    const local = join(root, ".supadrum", "config.yml");
    mkdirSync(join(root, ".supadrum"));
    writeFileSync(local, "version: 1\n");

    expect(
      resolveOperatorConfigPath({
        args: [],
        environment: {},
        cwd: root,
        homeDirectory: join(root, "home")
      })
    ).toBe(local);
  });

  test("uses the XDG config path when no override or local config exists", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-config-path-"));

    expect(
      resolveOperatorConfigPath({
        args: [],
        environment: { XDG_CONFIG_HOME: join(root, "xdg") },
        cwd: root,
        homeDirectory: join(root, "home")
      })
    ).toBe(join(root, "xdg", "supadrum", "config.yml"));
  });
});

describe("project registration", () => {
  test("sets one migration owner and demotes chamber siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-owner-"));
    const configPath = join(root, "config.yml");
    writeFileSync(
      configPath,
      `
version: 1
database: queue.sqlite
chambers:
  example-platform:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/example-platform/secret
      management_token: vault://supabase/example-platform/management
      database_access: vault://supabase/example-platform/postgres
projects:
  example-web:
    chamber: example-platform
    migrations: consumer
    capabilities: [migrations]
  example-ios:
    chamber: example-platform
    migrations: owner
    capabilities: [migrations]
`
    );

    setMigrationOwner(configPath, "example-web");

    const config = loadConfig(configPath);
    expect(config.projects["example-web"]?.migrations).toBe("owner");
    expect(config.projects["example-ios"]?.migrations).toBe("consumer");
  });

  test("preserves the migration driver when rewriting project config", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-driver-"));
    const configPath = join(root, "config.yml");
    writeFileSync(
      configPath,
      `
version: 1
projects:
  example-service:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/example-service/secret
      management_token: vault://supabase/example-service/management
      database_access: vault://supabase/example-service/postgres
    capabilities: [migrations]
    migration_driver: prisma
`
    );

    setProjectMode(configPath, "example-service", "live");

    expect(
      loadConfig(configPath).projects["example-service"]?.migration_driver
    ).toBe("prisma");
  });

  test("preserves an explicit manual approval policy when rewriting config", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-approval-"));
    const configPath = join(root, "config.yml");
    writeFileSync(
      configPath,
      `
version: 1
approval_mode: manual
projects:
  example-service:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/example-service/secret
      management_token: vault://supabase/example-service/management
      database_access: vault://supabase/example-service/postgres
    capabilities: [migrations]
`
    );

    setProjectMode(configPath, "example-service", "live");

    expect(loadConfig(configPath).approval_mode).toBe("manual");
  });

  test("creates a secure dry-run config with repository SSOT and development capabilities", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-add-"));
    const repository = join(root, "example-ios");
    const configPath = join(root, "config", "config.yml");
    createGitRepository(repository);

    const report = addProject({
      alias: "example-ios",
      repository: realpathSync(repository),
      project_ref: "abcdefghijklmnopqrst",
      profile: "development",
      config_path: configPath,
      vault_command: [
        "/usr/bin/node",
        "/opt/supadrum/vault-cli.js",
        "keychain",
        "resolve"
      ]
    });

    const config = loadConfig(configPath);
    expect(report).toEqual({
      added: true,
      alias: "example-ios",
      config_path: configPath,
      repository: realpathSync(repository),
      project_ref: "abcdefghijklmnopqrst",
      profile: "development"
    });
    expect(config.executor).toBe("dry-run");
    expect(config.projects["example-ios"]).toMatchObject({
      repo: realpathSync(repository),
      project_ref: "abcdefghijklmnopqrst",
      credentials: {
        secret_key: "vault://supabase/example-ios/secret",
        management_token: "vault://supabase/example-ios/management",
        database_access: "vault://supabase/example-ios/postgres"
      },
      capabilities: [
        "data-api",
        "storage",
        "edge-functions",
        "migrations",
        "schema-inspection",
        "project-management"
      ]
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf8")).not.toContain(
      "must-not-be-returned"
    );
  });

  test("creates a credential-free live chamber for a local Supabase stack", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-local-add-"));
    const repository = join(root, "materic-ai");
    const configPath = join(root, "config", "config.yml");
    createGitRepository(repository);

    const report = addLocalProject({
      alias: "materic-ai-local",
      repository,
      config_path: configPath
    });

    expect(report).toEqual({
      added: true,
      alias: "materic-ai-local",
      config_path: configPath,
      repository: realpathSync(repository),
      target: "local"
    });
    expect(loadConfig(configPath).projects["materic-ai-local"]).toMatchObject({
      target: "local",
      chamber: "materic-ai-local",
      mode: "live",
      migrations: "owner",
      migration_driver: "supabase",
      capabilities: ["migrations"]
    });
    const source = readFileSync(configPath, "utf8");
    expect(source).toContain("target: local");
    expect(source).not.toMatch(/project_ref|credentials|vault:\/\//);
  });

  test("does not broaden existing explicit capability lists", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-explicit-caps-"));
    const configPath = join(root, "config.yml");
    writeFileSync(
      configPath,
      `
version: 1
projects:
  alpha:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/alpha/secret
      management_token: vault://supabase/alpha/management
      database_access: vault://supabase/alpha/postgres
    capabilities: [data-api]
`
    );

    expect(loadConfig(configPath).projects.alpha?.capabilities).toEqual([
      "data-api"
    ]);
  });

  test("leaves an existing config unchanged when the alias already exists", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-duplicate-"));
    const repository = join(root, "example-ios");
    const configPath = join(root, "config.yml");
    createGitRepository(repository);
    addProject({
      alias: "example-ios",
      repository,
      project_ref: "abcdefghijklmnopqrst",
      profile: "inspect",
      config_path: configPath
    });
    const before = readFileSync(configPath);

    expect(() =>
      addProject({
        alias: "example-ios",
        repository,
        project_ref: "zyxwvutsrqponmlkjihg",
        profile: "admin",
        config_path: configPath
      })
    ).toThrow("Project already exists: example-ios");
    expect(readFileSync(configPath)).toEqual(before);
  });
});

describe("project doctor", () => {
  test("reports credential readiness without exposing resolved values", async () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-doctor-"));
    const repository = join(root, "example-ios");
    const configPath = join(root, "config.yml");
    createGitRepository(repository);
    addProject({
      alias: "example-ios",
      repository,
      project_ref: "abcdefghijklmnopqrst",
      profile: "development",
      config_path: configPath
    });

    const report = await doctorProject(
      "example-ios",
      loadConfig(configPath),
      async (name) => name !== "database_access"
    );

    expect(report).toEqual({
      project: "example-ios",
      chamber: "example-ios",
      mode: "dry-run",
      migrations: "owner",
      migration_driver: "supabase",
      ready: false,
      repository: true,
      project_ref: true,
      credentials: {
        secret_key: true,
        management_token: true,
        database_access: false
      },
      missing_credentials: ["database_access"],
      invalid_credentials: [],
      executor: "dry-run"
    });
    expect(JSON.stringify(report)).not.toContain("vault://");
  });
});

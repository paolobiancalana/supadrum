import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
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
  mkdirSync(join(path, "supabase"), { recursive: true });
  writeFileSync(join(path, "supabase", "config.toml"), 'project_id = "fixture"\n');
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

  test("una riscrittura non perde nessun campo opzionale del progetto", () => {
    // Tutti i call site che riscrivono la config passano dallo stesso
    // serializzatore, quindi provarlo su uno basta. Il confronto e'
    // sull'oggetto intero e non campo per campo: un campo aggiunto domani e
    // dimenticato nel serializzatore fa cadere questo test da solo, senza che
    // nessuno debba ricordarsi di estenderlo. `supabase_dir` era sparito
    // proprio cosi', e con lui l'isolamento fra stack locali.
    const root = mkdtempSync(join(tmpdir(), "supadrum-roundtrip-"));
    const repository = join(root, "example-web");
    createGitRepository(repository);
    mkdirSync(join(repository, "database"), { recursive: true });
    const configPath = join(root, "config.yml");
    writeFileSync(
      configPath,
      `
version: 1
database: queue.sqlite
vault_command: [pass, show]
chambers:
  example-platform:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/example-platform/secret
      management_token: vault://supabase/example-platform/management
      database_access: vault://supabase/example-platform/postgres
    managed_secrets:
      STRIPE_KEY: vault://supabase/example-platform/functions/STRIPE_KEY
projects:
  example-web:
    repo: ${repository}
    supabase_dir: database
    chamber: example-platform
    mode: live
    migrations: consumer
    migration_driver: prisma
    capabilities: [migrations, sql]
    commands:
      sql.execute:
        argv: [psql, -f, "{{path}}"]
        cwd: database
        env:
          SUPABASE_DB_URL: database_access
        verify_repo_sha: false
`
    );

    const before = loadConfig(configPath);
    setMigrationOwner(configPath, "example-web");
    const after = loadConfig(configPath);

    expect(after.projects["example-web"]).toEqual({
      ...before.projects["example-web"]!,
      migrations: "owner"
    });
    expect(after.vault_command).toEqual(before.vault_command);
    expect(after.chambers).toEqual(before.chambers);
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

  test("registra la directory Supabase annidata invece di lasciarla scoprire al primo job", () => {
    // Senza questo, registrare una repo il cui config.toml sta in una
    // sottocartella scriveva una riga che sembra pronta e che al primo job
    // parla con lo stack locale di un altro progetto.
    const root = mkdtempSync(join(tmpdir(), "supadrum-nested-add-"));
    const repository = join(root, "project-atlas");
    mkdirSync(repository, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository]);
    mkdirSync(join(repository, "database", "supabase"), { recursive: true });
    writeFileSync(
      join(repository, "database", "supabase", "config.toml"),
      'project_id = "atlas"\n'
    );
    const configPath = join(root, "config", "config.yml");

    const report = addLocalProject({
      alias: "atlas-local",
      repository,
      config_path: configPath
    });

    expect(report.supabase_dir).toBe("database");
    expect(
      loadConfig(configPath).projects["atlas-local"]?.supabase_dir
    ).toBe(join(realpathSync(repository), "database"));
  });

  test("si ferma invece di registrare una repo senza progetto Supabase", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-noproject-add-"));
    const repository = join(root, "senza-supabase");
    mkdirSync(repository, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository]);

    expect(() =>
      addLocalProject({
        alias: "senza-supabase",
        repository,
        config_path: join(root, "config", "config.yml")
      })
    ).toThrow(/No supabase\/config\.toml/);
  });

  test("si ferma invece di indovinare fra due progetti Supabase", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-ambiguous-add-"));
    const repository = join(root, "monorepo");
    mkdirSync(repository, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository]);
    for (const name of ["api", "web"]) {
      mkdirSync(join(repository, name, "supabase"), { recursive: true });
      writeFileSync(
        join(repository, name, "supabase", "config.toml"),
        'project_id = "x"\n'
      );
    }

    expect(() =>
      addLocalProject({
        alias: "monorepo",
        repository,
        config_path: join(root, "config", "config.yml")
      })
    ).toThrow(/Several Supabase projects/);
  });

  test("si ferma anche quando uno dei due progetti sta alla radice", () => {
    // La radice non vince per posizione: se ce ne sono due, quale sia quello
    // giusto e' una domanda. Sceglierne uno in silenzio e' come si finisce a
    // parlare con lo stack sbagliato, che e' il bug da cui nasce supabase_dir.
    const root = mkdtempSync(join(tmpdir(), "supadrum-ambiguous-root-"));
    const repository = join(root, "monorepo");
    createGitRepository(repository);
    mkdirSync(join(repository, "database", "supabase"), { recursive: true });
    writeFileSync(
      join(repository, "database", "supabase", "config.toml"),
      'project_id = "nested"\n'
    );

    expect(() =>
      addLocalProject({
        alias: "monorepo",
        repository,
        config_path: join(root, "config", "config.yml")
      })
    ).toThrow(/Several Supabase projects/);
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

describe("supabase_dir", () => {
  test("resolves relative to the repository, not the operator config", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-supabase-dir-"));
    const repository = join(root, "project-atlas");
    createGitRepository(repository);
    const configPath = join(root, "config", "config.yml");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      configPath,
      `
version: 1
chambers:
  project-atlas:
    target: local
projects:
  project-atlas:
    repo: ${repository}
    supabase_dir: database
    chamber: project-atlas
    capabilities: [migrations, sql]
`
    );

    const project = loadConfig(configPath).projects["project-atlas"];

    expect(project?.supabase_dir).toBe(join(repository, "database"));
  });

  test("without supabase_dir, projects behave exactly as before", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-supabase-dir-default-"));
    const repository = join(root, "presnap");
    createGitRepository(repository);
    const configPath = join(root, "config", "config.yml");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      configPath,
      `
version: 1
chambers:
  presnap-local:
    target: local
projects:
  presnap-local:
    repo: ${repository}
    chamber: presnap-local
    capabilities: [migrations, sql]
`
    );

    const project = loadConfig(configPath).projects["presnap-local"];

    expect(project?.supabase_dir).toBeUndefined();
  });

  test("refuses a supabase_dir that reaches another project through a symlink", () => {
    // Il controllo lessicale legge `repo/database` come interno: e' il percorso
    // scritto nella config. Ma se e' un symlink, lo stack che il broker
    // interroga sta in un'altra repository, che e' esattamente il bug per cui
    // questo campo esiste.
    const root = mkdtempSync(join(tmpdir(), "supadrum-symlink-"));
    const repository = join(root, "example-web");
    const sibling = join(root, "altro-progetto", "database");
    createGitRepository(repository);
    mkdirSync(join(sibling, "supabase"), { recursive: true });
    writeFileSync(
      join(sibling, "supabase", "config.toml"),
      'project_id = "altro"\n'
    );
    symlinkSync(sibling, join(repository, "database"));
    const configPath = join(root, "config.yml");
    writeFileSync(
      configPath,
      `
version: 1
database: queue.sqlite
chambers:
  local:
    target: local
projects:
  example-web:
    repo: ${repository}
    supabase_dir: database
    chamber: local
    capabilities: [migrations]
`
    );

    expect(() => loadConfig(configPath)).toThrow(
      /supabase_dir outside its repository/
    );
  });

  test("refuses a supabase_dir that points outside the repository", () => {
    // `resolve` con un path assoluto ignora la base, quindi senza controllo il
    // campo nato per impedire che il broker parli con lo stack sbagliato era il
    // modo piu' diretto per farglielo fare.
    const root = mkdtempSync(join(tmpdir(), "supadrum-escape-"));
    const repository = join(root, "example-web");
    const altro = join(root, "altro-progetto");
    createGitRepository(repository);
    mkdirSync(altro, { recursive: true });
    const configPath = join(root, "config.yml");

    for (const escape of [altro, "../altro-progetto", "database/../.."]) {
      writeFileSync(
        configPath,
        `
version: 1
database: queue.sqlite
chambers:
  local:
    target: local
projects:
  example-web:
    repo: ${repository}
    supabase_dir: ${escape}
    chamber: local
    capabilities: [migrations]
`
      );

      expect(() => loadConfig(configPath)).toThrow(
        /supabase_dir outside its repository/
      );
    }
  });

  test("refuses supabase_dir without a repo to resolve it against", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum-supabase-dir-orphan-"));
    const configPath = join(root, "config", "config.yml");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      configPath,
      `
version: 1
chambers:
  example-service:
    target: local
projects:
  example-service:
    supabase_dir: database
    chamber: example-service
    capabilities: [migrations, sql]
`
    );

    expect(() => loadConfig(configPath)).toThrow(
      "Project example-service sets supabase_dir without repo"
    );
  });
});

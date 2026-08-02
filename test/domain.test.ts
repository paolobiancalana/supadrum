import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { operationCatalog } from "../src/catalog.js";
import { inspectProject, loadConfig } from "../src/config.js";
import { JobSubmissionSchema } from "../src/domain.js";

const validConfig = `
version: 1
database: .supadrum/queue.sqlite
executor: dry-run
projects:
  example-web:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/example-web/secret
      management_token: vault://supabase/example-web/management
      database_access: vault://supabase/example-web/postgres
    capabilities:
      - data-api
      - auth-admin
      - storage
      - realtime
      - edge-functions
      - secrets
      - migrations
      - sql
      - project-management
`;

function writeConfig(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "supadrum-domain-"));
  const path = join(directory, "supadrum.yml");
  writeFileSync(path, contents);
  return path;
}

describe("operation catalog", () => {
  test("maps read and mutation operations to the intended capability and approval gate", () => {
    expect(operationCatalog["schema.inspect"]).toEqual({
      capability: "schema-inspection",
      approval: false
    });
    expect(operationCatalog["migration.plan"]).toEqual({
      capability: "migrations",
      approval: false
    });
    expect(operationCatalog["migration.apply"]).toEqual({
      capability: "migrations",
      approval: true
    });
    expect(operationCatalog["migration.baseline"]).toEqual({
      capability: "migrations",
      approval: true
    });
    expect(operationCatalog["secrets.set"]).toEqual({
      capability: "secrets",
      approval: true
    });
  });
});

describe("project chambers", () => {
  test("normalizes the bundled Node vault launcher for service environments", () => {
    const config = loadConfig(
      writeConfig(`
version: 1
vault_command:
  - node
  - /opt/supadrum/dist/vault-cli.js
  - keychain
  - resolve
projects:
  example-web:
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/example-web/secret
      management_token: vault://supabase/example-web/management
      database_access: vault://supabase/example-web/postgres
    capabilities: [migrations]
`)
    );

    expect(config.vault_command).toEqual([
      process.execPath,
      "/opt/supadrum/dist/vault-cli.js",
      "keychain",
      "resolve"
    ]);
  });

  test("normalizes two logical projects onto one explicit chamber", () => {
    const config = loadConfig(
      writeConfig(`
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
    migrations: owner
    capabilities: [migrations]
  example-ios:
    chamber: example-platform
    migrations: consumer
    capabilities: [data-api]
`)
    );

    expect(config.projects["example-web"]).toMatchObject({
      chamber: "example-platform",
      project_ref: "abcdefghijklmnopqrst",
      migrations: "owner",
      migration_driver: "supabase",
      mode: "dry-run"
    });
    expect(config.projects["example-ios"]).toMatchObject({
      chamber: "example-platform",
      project_ref: "abcdefghijklmnopqrst",
      migrations: "consumer",
      migration_driver: "supabase",
      mode: "dry-run"
    });
    expect(config.chambers["example-platform"]?.credentials.secret_key).toBe(
      "vault://supabase/example-platform/secret"
    );
  });

  test("loads a credential-free local chamber and exposes its target", () => {
    const config = loadConfig(
      writeConfig(`
version: 1
chambers:
  materic-local:
    target: local
projects:
  materic-ai-local:
    repo: /tmp/materic.ai
    chamber: materic-local
    mode: live
    migrations: owner
    capabilities: [migrations]
`)
    );

    expect(config.projects["materic-ai-local"]).toMatchObject({
      target: "local",
      chamber: "materic-local",
      mode: "live",
      migrations: "owner"
    });
    expect(inspectProject("materic-ai-local", config)).toEqual({
      name: "materic-ai-local",
      repo: "/tmp/materic.ai",
      target: "local",
      chamber: "materic-local",
      mode: "live",
      migrations: "owner",
      migration_driver: "supabase",
      capabilities: ["migrations"],
      credentials: [],
      executor: "command"
    });
  });

  test("allows credential-free auth administration on a local chamber", () => {
    const config = loadConfig(
      writeConfig(`
version: 1
chambers:
  materic-local:
    target: local
projects:
  materic-ai-local:
    repo: /tmp/materic.ai
    chamber: materic-local
    mode: live
    migrations: owner
    capabilities: [migrations, auth-admin]
`)
    );

    expect(inspectProject("materic-ai-local", config)).toMatchObject({
      target: "local",
      capabilities: ["migrations", "auth-admin"],
      credentials: []
    });
  });

  test("rejects remote identifiers and credentials on a local chamber", () => {
    expect(() =>
      loadConfig(
        writeConfig(`
version: 1
chambers:
  unsafe-local:
    target: local
    project_ref: abcdefghijklmnopqrst
    credentials:
      secret_key: vault://supabase/unsafe/secret
      management_token: vault://supabase/unsafe/management
      database_access: vault://supabase/unsafe/postgres
projects:
  unsafe:
    chamber: unsafe-local
    capabilities: [migrations]
`)
      )
    ).toThrow();
  });

  test("rejects remote-only capabilities on a local chamber", () => {
    expect(() =>
      loadConfig(
        writeConfig(`
version: 1
chambers:
  unsafe-local:
    target: local
projects:
  unsafe:
    chamber: unsafe-local
    capabilities: [data-api, migrations]
`)
      )
    ).toThrow(/local.*capabilit/i);
  });

  test("rejects multiple migration owners in one chamber", () => {
    expect(() =>
      loadConfig(
        writeConfig(`
version: 1
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
    migrations: owner
    capabilities: [migrations]
  example-ios:
    chamber: example-platform
    migrations: owner
    capabilities: [migrations]
`)
      )
    ).toThrow("Chamber example-platform has multiple migration owners");
  });

  test("loads an explicit Prisma migration driver", () => {
    const config = loadConfig(
      writeConfig(`
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
`)
    );

    expect(config.projects["example-service"]?.migration_driver).toBe("prisma");
  });

  test("requires the complete credential bundle", () => {
    const incomplete = validConfig.replace(
      "      database_access: vault://supabase/example-web/postgres\n",
      ""
    );

    expect(() => loadConfig(writeConfig(incomplete))).toThrow(
      /database_access/
    );
  });

  test("inspection reports configured credential names without revealing references", () => {
    const config = loadConfig(writeConfig(validConfig));

    const inspected = inspectProject("example-web", config);
    const serialized = JSON.stringify(inspected);

    expect(inspected).toEqual({
      name: "example-web",
      project_ref: "abcdefghijklmnopqrst",
      chamber: "example-web",
      mode: "dry-run",
      migrations: "owner",
      migration_driver: "supabase",
      capabilities: [
        "data-api",
        "auth-admin",
        "storage",
        "realtime",
        "edge-functions",
        "secrets",
        "migrations",
        "sql",
        "project-management"
      ],
      credentials: ["database_access", "management_token", "secret_key"],
      executor: "dry-run"
    });
    expect(serialized).not.toContain("vault://");
  });
});

describe("job boundary", () => {
  const schemaSubmission = (payload: Record<string, unknown>) => ({
    project: "example-web",
    operation: "schema.inspect",
    payload,
    repo_sha: "abc123",
    idempotency_key: "example-web:abc123:schema"
  });

  function routineChecksAtUtf8Size(target: number) {
    const lengths = Array(4 * 64).fill(1) as number[];
    const checks = () =>
      Array.from({ length: 4 }, (_, checkIndex) => ({
        kind: "routine" as const,
        schema: "public",
        name: "f",
        argument_types: lengths
          .slice(checkIndex * 64, (checkIndex + 1) * 64)
          .map((length) => "x".repeat(length))
      }));
    let remaining =
      target - Buffer.byteLength(JSON.stringify(checks()), "utf8");
    for (let index = 0; index < lengths.length && remaining > 0; index += 1) {
      const added = Math.min(254, remaining);
      lengths[index] = 1 + added;
      remaining -= added;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(checks()), "utf8")).toBe(target);
    return checks();
  }

  test("accepts all ten typed schema inspection checks", () => {
    const submission = schemaSubmission({
      checks: [
        { kind: "migration", version: "20260729164000" },
        { kind: "relation", schema: "public", name: "templates" },
        {
          kind: "column",
          schema: "public",
          relation: "games",
          name: "played_at"
        },
        {
          kind: "trigger",
          schema: "public",
          relation: "events",
          name: "events_lock_rule_set_after_first_game"
        },
        {
          kind: "routine",
          schema: "public",
          name: "create_game_for_user",
          argument_types: ["uuid", "integer"]
        },
        {
          kind: "row-security",
          schema: "public",
          relation: "templates",
          enabled: true,
          force: false,
          roles_without_bypass: ["anon", "authenticated"]
        },
        {
          kind: "policy",
          schema: "public",
          relation: "templates",
          name: "templates_update",
          command: "UPDATE",
          roles: ["authenticated"],
          permissive: true
        },
        {
          kind: "schema-privilege",
          schema: "private",
          role: "authenticated",
          privilege: "USAGE",
          granted: true
        },
        {
          kind: "relation-privilege",
          schema: "public",
          relation: "templates",
          role: "anon",
          privilege: "MAINTAIN",
          granted: false
        },
        {
          kind: "routine-privilege",
          schema: "private",
          name: "is_organization_member",
          argument_types: ["text"],
          role: "authenticated",
          privilege: "EXECUTE",
          granted: true
        }
      ]
    });

    expect(JobSubmissionSchema.parse(submission)).toMatchObject(submission);
  });

  test.each([
    ["empty checks", { checks: [] }],
    [
      "more than 100 checks",
      {
        checks: Array.from({ length: 101 }, () => ({
          kind: "relation",
          schema: "public",
          name: "x"
        }))
      }
    ],
    [
      "non-numeric migration",
      { checks: [{ kind: "migration", version: "not-numeric" }] }
    ],
    [
      "more than 64 arguments",
      {
        checks: [{
          kind: "routine",
          schema: "public",
          name: "f",
          argument_types: Array(65).fill("uuid")
        }]
      }
    ],
    [
      "argument type over 255 bytes",
      {
        checks: [{
          kind: "routine",
          schema: "public",
          name: "f",
          argument_types: ["x".repeat(256)]
        }]
      }
    ],
    [
      "unknown SQL field",
      {
        checks: [{
          kind: "relation",
          schema: "public",
          name: "x",
          sql: "select 1"
        }]
      }
    ],
    [
      "duplicate policy roles",
      {
        checks: [{
          kind: "policy",
          schema: "public",
          relation: "templates",
          name: "templates_select",
          command: "SELECT",
          roles: ["authenticated", "authenticated"],
          permissive: true
        }]
      }
    ],
    [
      "empty bypass role list",
      {
        checks: [{
          kind: "row-security",
          schema: "public",
          relation: "templates",
          enabled: true,
          force: false,
          roles_without_bypass: []
        }]
      }
    ],
    [
      "unknown policy command",
      {
        checks: [{
          kind: "policy",
          schema: "public",
          relation: "templates",
          name: "templates_select",
          command: "MERGE",
          roles: ["authenticated"],
          permissive: true
        }]
      }
    ],
    [
      "wrong relation privilege",
      {
        checks: [{
          kind: "relation-privilege",
          schema: "public",
          relation: "templates",
          role: "authenticated",
          privilege: "EXECUTE",
          granted: true
        }]
      }
    ],
    [
      "unknown security check field",
      {
        checks: [{
          kind: "schema-privilege",
          schema: "private",
          role: "authenticated",
          privilege: "USAGE",
          granted: true,
          sql: "select 1"
        }]
      }
    ]
  ])("rejects malformed schema inspection payload: %s", (_label, payload) => {
    expect(() =>
      JobSubmissionSchema.parse(schemaSubmission(payload as Record<string, unknown>))
    ).toThrow();
  });

  test("measures PostgreSQL identifier limits in UTF-8 bytes", () => {
    const identifier63Bytes = `${"é".repeat(31)}a`;
    const identifier64Bytes = "é".repeat(32);
    expect(Buffer.byteLength(identifier63Bytes, "utf8")).toBe(63);
    expect(Buffer.byteLength(identifier64Bytes, "utf8")).toBe(64);

    expect(() =>
      JobSubmissionSchema.parse(schemaSubmission({
        checks: [{
          kind: "relation",
          schema: "public",
          name: identifier63Bytes
        }]
      }))
    ).not.toThrow();
    expect(() =>
      JobSubmissionSchema.parse(schemaSubmission({
        checks: [{
          kind: "relation",
          schema: "public",
          name: identifier64Bytes
        }]
      }))
    ).toThrow(/63 UTF-8 bytes/);

    expect(() =>
      JobSubmissionSchema.parse(schemaSubmission({
        checks: [{
          kind: "schema-privilege",
          schema: "private",
          role: identifier63Bytes,
          privilege: "USAGE",
          granted: true
        }]
      }))
    ).not.toThrow();
    expect(() =>
      JobSubmissionSchema.parse(schemaSubmission({
        checks: [{
          kind: "schema-privilege",
          schema: "private",
          role: identifier64Bytes,
          privilege: "USAGE",
          granted: true
        }]
      }))
    ).toThrow(/63 UTF-8 bytes/);
  });

  test("accepts 65536 serialized check bytes and rejects 65537", () => {
    expect(() =>
      JobSubmissionSchema.parse(schemaSubmission({
        checks: routineChecksAtUtf8Size(65_536)
      }))
    ).not.toThrow();
    expect(() =>
      JobSubmissionSchema.parse(schemaSubmission({
        checks: routineChecksAtUtf8Size(65_537)
      }))
    ).toThrow(/65536 UTF-8 bytes/);
  });

  test.each([
    { secret: "value" },
    { nested: { managementToken: "value" } },
    { password: "value" },
    { database_url: "postgres://example" },
    { credential: "value" }
  ])("rejects sensitive payload keys: %j", (payload) => {
    expect(() =>
      JobSubmissionSchema.parse({
        project: "example-web",
        operation: "migration.plan",
        payload,
        repo_sha: "abc123",
        idempotency_key: "example-web:abc123:plan"
      })
    ).toThrow(/credential material/i);
  });

  test("accepts a structured credential-free payload", () => {
    expect(
      JobSubmissionSchema.parse({
        project: "example-web",
        operation: "migration.apply",
        payload: {
          migration: "20260729164000_create_example_table.sql"
        },
        repo_sha: "abc123",
        idempotency_key: "example-web:abc123:20260729164000"
      })
    ).toMatchObject({
      project: "example-web",
      operation: "migration.apply"
    });
  });

  test("rejects vault references even under an innocuous payload key", () => {
    expect(() =>
      JobSubmissionSchema.parse({
        project: "example-web",
        operation: "migration.plan",
        payload: { source: "vault://supabase/example-web/postgres" },
        repo_sha: "abc123",
        idempotency_key: "example-web:abc123:vault-ref"
      })
    ).toThrow(/credential material/i);
  });
});

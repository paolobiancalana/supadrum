import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHandlers, createMcpServer } from "../src/mcp.js";
import { SqliteStore } from "../src/store.js";

const stores: SqliteStore[] = [];
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function setup(approvalMode?: "automatic" | "manual") {
  const directory = mkdtempSync(join(tmpdir(), "supadrum-mcp-"));
  const configPath = join(directory, "supadrum.yml");
  writeFileSync(
    configPath,
    `version: 1
database: queue.sqlite
executor: dry-run
${approvalMode ? `approval_mode: ${approvalMode}\n` : ""}projects:
  alpha:
    project_ref: alpha-ref
    credentials:
      secret_key: vault://supabase/alpha/secret
      management_token: vault://supabase/alpha/management
      database_access: vault://supabase/alpha/postgres
    capabilities:
      - data-api
      - migrations
      - schema-inspection
      - project-management
`
  );
  const config = loadConfig(configPath);
  const store = new SqliteStore(
    config.database_path,
    undefined,
    config.approval_mode
  );
  stores.push(store);
  return { config, store };
}

function createStdioConfig(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const configPath = join(directory, "supadrum.yml");
  writeFileSync(
    configPath,
    `version: 1
database: queue.sqlite
executor: dry-run
projects:
  alpha:
    project_ref: alpha-ref
    credentials:
      secret_key: vault://supabase/alpha/secret
      management_token: vault://supabase/alpha/management
      database_access: vault://supabase/alpha/postgres
    capabilities:
      - project-management
`
  );
  return configPath;
}

function createStdioClient(name: string, configPath: string) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
      join(repositoryRoot, "src/mcp.ts")
    ],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SUPADRUM_CONFIG: configPath
    },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return { client, transport, stderr: () => stderr };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("MCP protocol surface", () => {
  test("queues typed schema inspection without approval or SQL payloads", () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);
    const submitted = handlers.jobsSubmit({
      project: "alpha",
      operation: "schema.inspect",
      payload: {
        checks: [{
          kind: "relation",
          schema: "pg_catalog",
          name: "pg_class"
        }]
      },
      repo_sha: "abc123",
      idempotency_key: "alpha:abc123:schema"
    });

    expect(submitted).toMatchObject({
      status: "queued",
      requires_approval: false
    });
    expect(store.listJobs()).toHaveLength(1);
    expect(() =>
      handlers.jobsSubmit({
        project: "alpha",
        operation: "schema.inspect",
        payload: {
          checks: [{
            kind: "relation",
            schema: "pg_catalog",
            name: "pg_class",
            sql: "select 1"
          }]
        },
        repo_sha: "abc123",
        idempotency_key: "alpha:abc123:schema-sql"
      })
    ).toThrow();
    expect(store.listJobs()).toHaveLength(1);
  });

  test("lists the nine typed broker tools and calls project inspection", async () => {
    const { config, store } = setup();
    const server = createMcpServer(config, store);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport)
    ]);

    const listed = await client.listTools();
    const result = await client.callTool({
      name: "projects.inspect",
      arguments: { project: "alpha" }
    });

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "jobs.cancel",
      "jobs.status",
      "jobs.submit",
      "jobs.wait",
      "projects.inspect",
      "projects.list",
      "sessions.close",
      "sessions.exec",
      "sessions.open"
    ]);
    expect(result.structuredContent).toMatchObject({
      name: "alpha",
      project_ref: "alpha-ref",
      credentials: [
        "database_access",
        "management_token",
        "secret_key"
      ]
    });
    expect(JSON.stringify(result)).not.toContain("vault://");

    await client.close();
    await server.close();
  });

  test("queues a mutation automatically without accepting credentials", async () => {
    const { config, store } = setup();
    const server = createMcpServer(config, store);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport)
    ]);

    const result = await client.callTool({
      name: "jobs.submit",
      arguments: {
        project: "alpha",
        operation: "migration.apply",
        payload: { migration: "rules.sql" },
        repo_sha: "abc123",
        idempotency_key: "alpha:abc123:apply"
      }
    });

    expect(result.structuredContent).toMatchObject({
      status: "queued",
      requires_approval: false,
      position: 1
    });

    await client.close();
    await server.close();
  });

  test("supports an explicit manual approval policy", async () => {
    const { config, store } = setup("manual");
    const handlers = createHandlers(config, store);

    const result = handlers.jobsSubmit({
      project: "alpha",
      operation: "migration.apply",
      payload: { migration: "rules.sql" },
      repo_sha: "abc123",
      idempotency_key: "alpha:abc123:manual-apply"
    });

    expect(result).toMatchObject({
      status: "waiting_approval",
      requires_approval: true
    });
  });

  test("keeps SQLite open for the lifetime of a stdio client", async () => {
    const configPath = createStdioConfig("supadrum-stdio-");
    const { client, transport } = createStdioClient(
      "stdio-test-client",
      configPath
    );
    await client.connect(transport);

    try {
      await client.callTool({ name: "projects.list", arguments: {} });
      const submitted = await client.callTool({
        name: "jobs.submit",
        arguments: {
          project: "alpha",
          operation: "project.inspect",
          payload: {},
          repo_sha: "abc123",
          idempotency_key: "alpha:stdio:lifetime"
        }
      });

      expect(submitted.isError).not.toBe(true);
      expect(submitted.structuredContent).toMatchObject({
        project: "alpha",
        status: "queued"
      });
    } finally {
      await client.close();
    }
  });

  test("accepts simultaneous submissions from two stdio clients", async () => {
    const configPath = createStdioConfig("supadrum-concurrent-");
    const clients = ["left", "right"].map((name) =>
      createStdioClient(name, configPath)
    );
    try {
      await Promise.all(
        clients.map(({ client, transport }) => client.connect(transport))
      );
      await Promise.all(
        clients.map(({ client }) =>
          client.callTool({ name: "projects.list", arguments: {} })
        )
      );
      const submitted = await Promise.all(
        clients.map(({ client }, index) =>
          client.callTool({
            name: "jobs.submit",
            arguments: {
              project: "alpha",
              operation: "project.inspect",
              payload: {},
              repo_sha: "abc123",
              idempotency_key: `alpha:concurrent:${index}`
            }
          })
        )
      );

      expect(submitted.map((result) => result.isError)).toEqual([
        undefined,
        undefined
      ]);
      expect(
        submitted.map(
          (result) =>
            (
              result.structuredContent as
                | { status?: unknown }
                | undefined
            )?.status
        )
      ).toEqual(["queued", "queued"]);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${clients
          .map(({ stderr }) => stderr())
          .join("\n")}`
      );
    } finally {
      await Promise.all(clients.map(({ client }) => client.close()));
    }
  });

  test("reloads configuration for a running MCP server when the file changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supadrum-mcp-reload-"));
    const configPath = join(directory, "supadrum.yml");
    const yaml = (capabilities: string) => `version: 1
database: queue.sqlite
executor: dry-run
projects:
  alpha:
    project_ref: alpha-ref
    credentials:
      secret_key: vault://supabase/alpha/secret
      management_token: vault://supabase/alpha/management
      database_access: vault://supabase/alpha/postgres
    capabilities:
${capabilities}
`;
    writeFileSync(configPath, yaml("      - project-management"));
    const { client, transport, stderr } = createStdioClient(
      "stdio-reload-client",
      configPath
    );
    await client.connect(transport);
    try {
      const denied = await client.callTool({
        name: "jobs.submit",
        arguments: {
          project: "alpha",
          operation: "sql.execute",
          payload: { path: "x.sql", digest: "0".repeat(64) },
          repo_sha: "abc123",
          idempotency_key: "alpha:abc123:sql-denied"
        }
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain("lacks sql");

      writeFileSync(
        configPath,
        yaml("      - project-management\n      - sql")
      );

      const accepted = await client.callTool({
        name: "jobs.submit",
        arguments: {
          project: "alpha",
          operation: "sql.execute",
          payload: { path: "x.sql", digest: "0".repeat(64) },
          repo_sha: "abc123",
          idempotency_key: "alpha:abc123:sql-accepted"
        }
      });
      expect(accepted.isError).not.toBe(true);
      expect(accepted.structuredContent).toMatchObject({
        status: "queued"
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${stderr()}`
      );
    } finally {
      await client.close();
    }
  });
});

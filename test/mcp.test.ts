import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { loadConfig } from "../src/config.js";
import {
  createConfigReloader,
  createHandlers,
  createMcpServer
} from "../src/mcp.js";
import { brokerErrorCodes } from "../src/errors.js";
import { SqliteStore } from "../src/store.js";

const stores: SqliteStore[] = [];
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function project(name: string, capabilities: readonly string[]): string {
  return `  ${name}:
    project_ref: ${name}-ref
    credentials:
      secret_key: vault://supabase/${name}/secret
      management_token: vault://supabase/${name}/management
      database_access: vault://supabase/${name}/postgres
    capabilities:
${capabilities.map((capability) => `      - ${capability}`).join("\n")}
`;
}

function configYaml(
  projects: string,
  approvalMode?: "automatic" | "manual"
): string {
  return `version: 1
database: queue.sqlite
executor: dry-run
${approvalMode ? `approval_mode: ${approvalMode}\n` : ""}projects:
${projects}`;
}

function writeConfig(prefix: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const configPath = join(directory, "supadrum.yml");
  writeFileSync(configPath, contents);
  return configPath;
}

function openStore(configPath: string) {
  const config = loadConfig(configPath);
  const store = new SqliteStore(
    config.database_path,
    undefined,
    config.approval_mode
  );
  stores.push(store);
  return { config, configPath, store };
}

const ALPHA_CAPABILITIES = [
  "data-api",
  "migrations",
  "schema-inspection",
  "project-management"
] as const;

function setup(approvalMode?: "automatic" | "manual") {
  return openStore(
    writeConfig(
      "supadrum-mcp-",
      configYaml(project("alpha", ALPHA_CAPABILITIES), approvalMode)
    )
  );
}

// Reading a field off a tool result needs a shape the SDK types as unknown.
// Parsing rather than casting keeps a drifted response a test failure here,
// instead of an undefined that surfaces somewhere less obvious.
function structured<Schema extends z.ZodType>(
  result: unknown,
  schema: Schema
): z.output<Schema> {
  const { structuredContent } = z
    .object({ structuredContent: z.unknown() })
    .parse(result);
  return schema.parse(structuredContent);
}

// Mirrors the runner's session.open path (src/runner.ts:154-186): grant the
// open job, run it, activate the lease, then verify and complete. Driving the
// store by hand instead left the open job parked in `granted` while its
// session was active — a pairing the running system never holds.
function activateLease(
  store: SqliteStore,
  opened: { session: { id: string }; open_job: { id: string } }
) {
  const granted = store.grantIfSchedulable(
    opened.open_job.id,
    new Date(Date.now() + 60_000).toISOString()
  );
  if (!granted) {
    throw new Error(`Open job was not schedulable: ${opened.open_job.id}`);
  }
  store.transition(granted.id, "running");
  const session = store.activateSession(opened.session.id);
  store.transition(granted.id, "verifying");
  store.transition(granted.id, "completed", null, {
    lease_expires_at: null
  });
  return session;
}

function setupProjects(projects: string) {
  return openStore(
    writeConfig("supadrum-mcp-projects-", configYaml(projects))
  );
}

function createStdioConfig(prefix: string): string {
  return writeConfig(
    prefix,
    configYaml(project("alpha", ["project-management"]))
  );
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

  test("routes each job tool to its matching handler", async () => {
    const { config, store } = setup();
    const server = createMcpServer(config, store);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport)
    ]);

    try {
      const listed = await client.callTool({
        name: "projects.list",
        arguments: {}
      });
      expect(listed.structuredContent).toMatchObject({
        projects: [{ name: "alpha", project_ref: "alpha-ref" }]
      });

      const submitted = await client.callTool({
        name: "jobs.submit",
        arguments: {
          project: "alpha",
          operation: "project.inspect",
          payload: {},
          repo_sha: "abc123",
          idempotency_key: "alpha:tools:submit"
        }
      });
      const { id: jobId } = structured(
        submitted,
        z.object({ id: z.string().uuid() })
      );

      const waited = await client.callTool({
        name: "jobs.wait",
        arguments: { job_id: jobId, cursor: 0, timeout_ms: 0 }
      });
      expect(waited.structuredContent).toMatchObject({
        job: { id: jobId, status: "queued" }
      });

      const status = await client.callTool({
        name: "jobs.status",
        arguments: { job_id: jobId }
      });
      expect(status.structuredContent).toMatchObject({
        id: jobId,
        status: "queued",
        position: 1
      });

      const cancelled = await client.callTool({
        name: "jobs.cancel",
        arguments: { job_id: jobId }
      });
      expect(cancelled.structuredContent).toMatchObject({
        id: jobId,
        status: "cancelled",
        position: null
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("routes each session tool to its matching handler", async () => {
    const { config, store } = setup();
    const server = createMcpServer(config, store);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport)
    ]);

    try {
      const opened = await client.callTool({
        name: "sessions.open",
        arguments: {
          project: "alpha",
          capability: "migrations",
          repo_sha: "abc123",
          idempotency_key: "alpha:tools:lease",
          ttl_ms: 60_000
        }
      });
      const { session, open_job: openJob } = structured(
        opened,
        z.object({
          session: z.object({ id: z.string().uuid() }),
          open_job: z.object({ id: z.string().uuid() })
        })
      );
      expect(opened.structuredContent).toMatchObject({
        session: { project: "alpha", capability: "migrations" },
        open_job: { operation: "session.open", status: "queued" }
      });

      activateLease(store, { session, open_job: openJob });

      const executed = await client.callTool({
        name: "sessions.exec",
        arguments: {
          session_id: session.id,
          operation: "migration.apply",
          payload: { migration: "rules.sql" },
          idempotency_key: "alpha:tools:exec"
        }
      });
      expect(executed.structuredContent).toMatchObject({
        operation: "migration.apply",
        status: "queued",
        session_id: session.id
      });

      const closed = await client.callTool({
        name: "sessions.close",
        arguments: { session_id: session.id }
      });
      expect(closed.structuredContent).toMatchObject({
        id: session.id,
        status: "closing"
      });
    } finally {
      await client.close();
      await server.close();
    }
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
            structured(result, z.object({ status: z.string() })).status
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

  test("refuses work for a project the configuration does not define", () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);

    expect(() =>
      handlers.jobsSubmit({
        project: "ghost",
        operation: "project.inspect",
        payload: {},
        repo_sha: "abc123",
        idempotency_key: "ghost:abc123:inspect"
      })
    ).toThrow("Unknown project: ghost");
    expect(store.listJobs()).toHaveLength(0);
  });

  test("refuses an operation the project holds no capability for", () => {
    const { config, store } = setupProjects(project("narrow", ["project-management"]));
    const handlers = createHandlers(config, store);

    expect(() =>
      handlers.jobsSubmit({
        project: "narrow",
        operation: "sql.execute",
        payload: { path: "x.sql", digest: "0".repeat(64) },
        repo_sha: "abc123",
        idempotency_key: "narrow:abc123:sql"
      })
    ).toThrow("Project narrow lacks sql");
    expect(store.listJobs()).toHaveLength(0);
  });

  test("lists every project sorted and free of credential references", () => {
    const { config, store } = setupProjects(
      project("zulu", ["data-api"]) + project("alpha", ["data-api"])
    );
    const listed = createHandlers(config, store).projectsList();

    expect(listed.projects.map((project) => project.name)).toEqual([
      "alpha",
      "zulu"
    ]);
    expect(listed.projects[0]).toMatchObject({
      credentials: ["database_access", "management_token", "secret_key"]
    });
    expect(JSON.stringify(listed)).not.toContain("vault://");
  });

  test("reads a fresh configuration per call when given a config function", () => {
    const { configPath, store } = setupProjects(
      project("alpha", ["project-management"])
    );
    const handlers = createHandlers(() => loadConfig(configPath), store);
    const submission = {
      project: "alpha",
      operation: "data.query" as const,
      payload: { table: "widgets" },
      repo_sha: "abc123",
      idempotency_key: "alpha:abc123:query"
    };

    expect(() => handlers.jobsSubmit(submission)).toThrow(
      "Project alpha lacks data-api"
    );

    writeFileSync(
      configPath,
      configYaml(project("alpha", ["project-management", "data-api"]))
    );

    expect(handlers.jobsSubmit(submission)).toMatchObject({
      status: "queued"
    });
  });
});

describe("job polling and cancellation", () => {
  function submitInspect(
    handlers: ReturnType<typeof createHandlers>,
    key: string
  ) {
    return handlers.jobsSubmit({
      project: "alpha",
      operation: "project.inspect",
      payload: {},
      repo_sha: "abc123",
      idempotency_key: key
    });
  }

  test("returns buffered events and advances the cursor past them", async () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);
    const job = submitInspect(handlers, "alpha:abc123:buffered");

    const first = await handlers.jobsWait({
      job_id: job.id,
      cursor: 0,
      timeout_ms: 0
    });

    expect(first.events.length).toBeGreaterThan(0);
    expect(first.cursor).toBe(first.events.at(-1)?.cursor);
    expect(first.job).toMatchObject({ id: job.id, status: "queued" });

    const second = await handlers.jobsWait({
      job_id: job.id,
      cursor: first.cursor,
      timeout_ms: 0
    });

    expect(second.events).toEqual([]);
    expect(second.cursor).toBe(first.cursor);
  });

  test("blocks until a new event arrives, then reports only that event", async () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);
    const job = submitInspect(handlers, "alpha:abc123:blocking");
    const caughtUp = await handlers.jobsWait({
      job_id: job.id,
      cursor: 0,
      timeout_ms: 0
    });

    const pending = handlers.jobsWait({
      job_id: job.id,
      cursor: caughtUp.cursor,
      timeout_ms: 2_000
    });
    const timer = setTimeout(() => store.transition(job.id, "granted"), 25);
    const observed = await pending;
    clearTimeout(timer);

    expect(observed.events.map((event) => event.status)).toEqual(["granted"]);
    expect(observed.cursor).toBeGreaterThan(caughtUp.cursor);
    expect(observed.job).toMatchObject({ status: "granted" });
  });

  test("gives up at the deadline instead of waiting forever", async () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);
    const job = submitInspect(handlers, "alpha:abc123:deadline");
    const caughtUp = await handlers.jobsWait({
      job_id: job.id,
      cursor: 0,
      timeout_ms: 0
    });

    const startedAt = Date.now();
    const timedOut = await handlers.jobsWait({
      job_id: job.id,
      cursor: caughtUp.cursor,
      timeout_ms: 120
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(timedOut.events).toEqual([]);
    expect(timedOut.cursor).toBe(caughtUp.cursor);
  });

  test("reports queue position while queued and drops it once cancelled", () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);
    const first = submitInspect(handlers, "alpha:abc123:first");
    const second = submitInspect(handlers, "alpha:abc123:second");

    expect(handlers.jobsStatus({ job_id: first.id })).toMatchObject({
      status: "queued",
      position: 1
    });
    expect(handlers.jobsStatus({ job_id: second.id })).toMatchObject({
      position: 2
    });

    expect(handlers.jobsCancel({ job_id: first.id })).toMatchObject({
      status: "cancelled",
      position: null
    });
    expect(handlers.jobsStatus({ job_id: second.id })).toMatchObject({
      position: 1
    });
  });
});

describe("session leases", () => {
  const openInput = {
    project: "alpha",
    capability: "migrations" as const,
    repo_sha: "abc123",
    idempotency_key: "alpha:abc123:lease",
    ttl_ms: 60_000
  };

  test("queues an open job for the lease without granting it yet", () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);

    const opened = handlers.sessionsOpen(openInput);

    expect(opened.session).toMatchObject({
      project: "alpha",
      capability: "migrations",
      status: "queued"
    });
    expect(opened.open_job).toMatchObject({
      operation: "session.open",
      status: "queued",
      requires_approval: false
    });
  });

  test("refuses a lease over a capability the project lacks", () => {
    const { config, store } = setupProjects(project("narrow", ["project-management"]));
    const handlers = createHandlers(config, store);

    expect(() =>
      handlers.sessionsOpen({ ...openInput, project: "narrow" })
    ).toThrow("Project narrow lacks migrations");
  });

  test("parks the open job for approval under a manual policy", () => {
    const { config, store } = setup("manual");
    const handlers = createHandlers(config, store);

    const opened = handlers.sessionsOpen(openInput);

    expect(opened.open_job).toMatchObject({
      status: "waiting_approval",
      requires_approval: true
    });
    expect(opened.session.status).toBe("queued");
  });

  test("refuses execution until the lease is actually active", () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);
    const opened = handlers.sessionsOpen(openInput);

    expect(() =>
      handlers.sessionsExec({
        session_id: opened.session.id,
        operation: "migration.apply",
        payload: { migration: "rules.sql" },
        idempotency_key: "alpha:abc123:exec"
      })
    ).toThrow(`Session is not active: ${opened.session.id}`);
  });

  test("queues work inside an active lease without a fresh approval", () => {
    const { config, store } = setup("manual");
    const handlers = createHandlers(config, store);
    const opened = handlers.sessionsOpen(openInput);
    store.approve(opened.open_job.id, "operator");
    activateLease(store, opened);

    const queued = handlers.sessionsExec({
      session_id: opened.session.id,
      operation: "migration.apply",
      payload: { migration: "rules.sql" },
      idempotency_key: "alpha:abc123:exec"
    });

    expect(queued).toMatchObject({
      operation: "migration.apply",
      status: "queued",
      requires_approval: false,
      session_id: opened.session.id
    });
  });

  test("closes a still-queued lease outright and cancels its open job", () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);
    const opened = handlers.sessionsOpen(openInput);

    const closed = handlers.sessionsClose({
      session_id: opened.session.id
    });

    expect(closed).toMatchObject({ id: opened.session.id, status: "closed" });
    expect(store.getJob(opened.open_job.id).status).toBe("cancelled");
  });

  test("marks an active lease closing so its runner can drain", () => {
    const { config, store } = setup();
    const handlers = createHandlers(config, store);
    const opened = handlers.sessionsOpen(openInput);
    activateLease(store, opened);

    expect(
      handlers.sessionsClose({ session_id: opened.session.id })
    ).toMatchObject({ status: "closing" });
  });
});

describe("error taxonomy on the tool surface", () => {
  const ERROR_RESULT = z.object({
    error: z.object({
      code: z.enum(brokerErrorCodes),
      message: z.string().min(1),
      retryable: z.boolean()
    })
  });

  async function connect(configSource: Parameters<typeof createMcpServer>[0]) {
    const { store } = setup();
    const server = createMcpServer(configSource, store);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport)
    ]);
    return {
      client,
      store,
      [Symbol.asyncDispose]: async () => {
        await client.close();
        await server.close();
      }
    };
  }

  test("codes a capability denial as the caller's to fix", async () => {
    await using connected = await connect(setup().config);

    const denied = await connected.client.callTool({
      name: "jobs.submit",
      arguments: {
        project: "alpha",
        operation: "sql.execute",
        payload: { path: "x.sql", digest: "0".repeat(64) },
        repo_sha: "abc123",
        idempotency_key: "alpha:errors:denied"
      }
    });

    expect(denied.isError).toBe(true);
    expect(structured(denied, ERROR_RESULT).error).toMatchObject({
      code: "capability_denied",
      retryable: false
    });
  });

  test("codes an unopened lease as worth retrying", async () => {
    await using connected = await connect(setup().config);
    const opened = await connected.client.callTool({
      name: "sessions.open",
      arguments: {
        project: "alpha",
        capability: "migrations",
        repo_sha: "abc123",
        idempotency_key: "alpha:errors:lease",
        ttl_ms: 60_000
      }
    });
    const { session } = structured(
      opened,
      z.object({ session: z.object({ id: z.string().uuid() }) })
    );

    const early = await connected.client.callTool({
      name: "sessions.exec",
      arguments: {
        session_id: session.id,
        operation: "migration.apply",
        payload: { migration: "rules.sql" },
        idempotency_key: "alpha:errors:early"
      }
    });

    expect(structured(early, ERROR_RESULT).error).toMatchObject({
      code: "session_not_active",
      retryable: true
    });
  });

  test("codes a rejected payload as invalid input, readably", async () => {
    await using connected = await connect(setup().config);

    const rejected = await connected.client.callTool({
      name: "jobs.submit",
      arguments: {
        project: "alpha",
        operation: "schema.inspect",
        payload: {
          checks: [
            {
              kind: "relation",
              schema: "pg_catalog",
              name: "pg_class",
              sql: "select 1"
            }
          ]
        },
        repo_sha: "abc123",
        idempotency_key: "alpha:errors:payload"
      }
    });

    const { error } = structured(rejected, ERROR_RESULT);
    expect(error.code).toBe("invalid_input");
    expect(error.message).not.toContain('"_zod"');
  });

  test("leaves a genuine fault a fault instead of dressing it as protocol", async () => {
    await using connected = await connect(() => {
      throw new TypeError("config source exploded");
    });

    const faulted = await connected.client.callTool({
      name: "projects.list",
      arguments: {}
    });

    // The SDK still reports a failure, but without a taxonomy code: an
    // agent must not read a broker crash as "you asked for the wrong thing".
    expect(faulted.isError).toBe(true);
    expect(() => structured(faulted, ERROR_RESULT)).toThrow();
  });
});

describe("configuration reloading", () => {
  function reloaderFor(projects: string) {
    const configPath = writeConfig(
      "supadrum-mcp-reload-",
      configYaml(projects)
    );
    let tick = 0;
    // mtime is stamped explicitly: some filesystems only resolve to a
    // second, so two quick writes can share a timestamp. Passing the same
    // `at` for two writes reproduces that on any filesystem.
    const rewrite = (contents: string, at = ++tick) => {
      writeFileSync(configPath, contents);
      const stamp = new Date(Date.UTC(2026, 0, 1) + at * 10_000);
      utimesSync(configPath, stamp, stamp);
    };
    return {
      getConfig: createConfigReloader(configPath),
      rewrite,
      configPath
    };
  }

  test("serves the capabilities from the file as it changes", () => {
    const { getConfig, rewrite } = reloaderFor(
      project("alpha", ["project-management"])
    );

    expect(getConfig().projects.alpha?.capabilities).toEqual([
      "project-management"
    ]);

    rewrite(configYaml(project("alpha", ["project-management", "sql"])));

    expect(getConfig().projects.alpha?.capabilities).toEqual([
      "project-management",
      "sql"
    ]);
  });

  test("keeps serving the last valid config when an edit breaks the file", () => {
    const { getConfig, rewrite } = reloaderFor(
      project("alpha", ["project-management"])
    );
    const before = getConfig();

    rewrite("version: 1\nprojects: [this is not a project map\n");

    expect(getConfig()).toEqual(before);
  });

  test("recovers from a repair stamped in the same filesystem tick", () => {
    const { getConfig, rewrite } = reloaderFor(
      project("alpha", ["project-management"])
    );
    getConfig();

    rewrite("]]not yaml at all[[", 1);
    expect(getConfig().projects.alpha?.capabilities).toEqual([
      "project-management"
    ]);

    rewrite(configYaml(project("alpha", ["project-management", "sql"])), 1);

    expect(getConfig().projects.alpha?.capabilities).toEqual([
      "project-management",
      "sql"
    ]);
  });

  test("keeps serving the last config when the file disappears", () => {
    const { getConfig, configPath } = reloaderFor(
      project("alpha", ["project-management"])
    );
    const before = getConfig();

    rmSync(configPath);

    expect(getConfig()).toEqual(before);
  });

  test("does not re-read the file while its mtime is unchanged", () => {
    const { getConfig, rewrite } = reloaderFor(
      project("alpha", ["project-management"])
    );
    rewrite(configYaml(project("alpha", ["project-management"])), 1);
    expect(getConfig().projects.alpha?.capabilities).toEqual([
      "project-management"
    ]);

    // Same mtime, different bytes: only a reloader that re-reads on every
    // call would serve `sql` here.
    rewrite(configYaml(project("alpha", ["project-management", "sql"])), 1);

    expect(getConfig().projects.alpha?.capabilities).toEqual([
      "project-management"
    ]);
  });
});

describe("MCP protocol surface (stdio)", () => {
  test("reloads configuration for a running MCP server when the file changes", async () => {
    const configPath = writeConfig(
      "supadrum-mcp-reload-",
      configYaml(project("alpha", ["project-management"]))
    );
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
        configYaml(project("alpha", ["project-management", "sql"]))
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

#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import {
  capabilityNames,
  operationCatalog,
  operationNames
} from "./catalog.js";
import {
  configMtime,
  inspectProject,
  loadConfig,
  type SupadrumConfig
} from "./config.js";
import {
  CredentialFreePayloadSchema,
  JobSubmissionSchema
} from "./domain.js";
import { isEntrypoint } from "./entrypoint.js";
import { BrokerError } from "./errors.js";
import { resolveOperatorConfigPath } from "./projects.js";
import { SqliteStore } from "./store.js";

function publicJob(store: SqliteStore, id: string) {
  const job = store.getJob(id);
  return {
    ...job,
    position: store.position(id)
  };
}

function assertProjectCapability(
  config: SupadrumConfig,
  projectName: string,
  capability: (typeof capabilityNames)[number]
) {
  const project = config.projects[projectName];
  if (!project) {
    throw new BrokerError(
      "unknown_project",
      `Unknown project: ${projectName}`
    );
  }
  if (!project.capabilities.includes(capability)) {
    throw new BrokerError(
      "capability_denied",
      `Project ${projectName} lacks ${capability}`
    );
  }
  return project;
}

export type ConfigSource = SupadrumConfig | (() => SupadrumConfig);

export function createHandlers(
  configSource: ConfigSource,
  store: SqliteStore
) {
  const getConfig: () => SupadrumConfig =
    typeof configSource === "function"
      ? configSource
      : () => configSource;
  return {
    projectsList() {
      const config = getConfig();
      return {
        projects: Object.keys(config.projects)
          .sort()
          .map((name) => inspectProject(name, config))
      };
    },

    projectsInspect(input: { project: string }) {
      return inspectProject(input.project, getConfig());
    },

    jobsSubmit(input: z.input<typeof JobSubmissionSchema>) {
      const parsed = JobSubmissionSchema.parse(input);
      const definition = (
        operationCatalog as Record<
          typeof parsed.operation,
          {
            capability: (typeof capabilityNames)[number];
            approval: boolean;
          }
        >
      )[parsed.operation];
      assertProjectCapability(getConfig(), parsed.project, definition.capability);
      let job = store.submit(parsed);
      if (job.requires_approval && job.approved_at === null) {
        job = store.transition(job.id, "waiting_approval");
      }
      return publicJob(store, job.id);
    },

    async jobsWait(input: {
      job_id: string;
      cursor: number;
      timeout_ms: number;
    }) {
      const deadline = Date.now() + input.timeout_ms;
      do {
        const events = store.events(input.job_id, input.cursor);
        const last = events.at(-1);
        if (last) {
          return {
            job: publicJob(store, input.job_id),
            events,
            cursor: last.cursor
          };
        }
        if (input.timeout_ms === 0) break;
        await delay(Math.min(50, Math.max(0, deadline - Date.now())));
      } while (Date.now() < deadline);

      return {
        job: publicJob(store, input.job_id),
        events: [],
        cursor: input.cursor
      };
    },

    jobsStatus(input: { job_id: string }) {
      return publicJob(store, input.job_id);
    },

    jobsCancel(input: { job_id: string }) {
      return {
        ...store.cancel(input.job_id),
        position: null
      };
    },

    sessionsOpen(input: {
      project: string;
      capability: (typeof capabilityNames)[number];
      repo_sha: string;
      idempotency_key: string;
      ttl_ms: number;
    }) {
      assertProjectCapability(getConfig(), input.project, input.capability);
      const session = store.openSession(input);
      let openJob = store.getJob(session.open_job_id);
      if (openJob.requires_approval && openJob.approved_at === null) {
        openJob = store.transition(openJob.id, "waiting_approval");
      }
      return {
        session,
        open_job: publicJob(store, openJob.id)
      };
    },

    sessionsExec(input: {
      session_id: string;
      operation: (typeof operationNames)[number];
      payload: Record<string, unknown>;
      idempotency_key: string;
    }) {
      const job = store.submitSessionJob(input.session_id, input);
      return publicJob(store, job.id);
    },

    sessionsClose(input: { session_id: string }) {
      return store.requestSessionClose(input.session_id);
    }
  };
}

function toolResult(value: unknown) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value)
      }
    ],
    structuredContent
  };
}

function toolError(error: BrokerError) {
  const payload = {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    }
  };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload)
      }
    ],
    structuredContent: payload,
    isError: true
  };
}

/**
 * Turns the failures a caller can provoke into a coded result, and lets
 * everything else through as a fault. An agent needs to tell "you may not do
 * that" from "not ready yet, ask again" from "the broker is broken", and a
 * bare thrown message tells it none of the three.
 */
async function callTool(run: () => unknown | Promise<unknown>) {
  try {
    return toolResult(await run());
  } catch (error) {
    if (error instanceof BrokerError) return toolError(error);
    if (error instanceof z.ZodError) {
      return toolError(
        new BrokerError("invalid_input", z.prettifyError(error))
      );
    }
    throw error;
  }
}

export function createMcpServer(
  configSource: ConfigSource,
  store: SqliteStore
): McpServer {
  const handlers = createHandlers(configSource, store);
  const server = new McpServer({
    name: "supadrum",
    version: "0.1.0"
  });

  server.registerTool(
    "projects.list",
    {
      description: "List configured projects without credential references",
      inputSchema: {}
    },
    async () => callTool(() => handlers.projectsList())
  );
  server.registerTool(
    "projects.inspect",
    {
      description: "Inspect one redacted project chamber",
      inputSchema: { project: z.string().min(1) }
    },
    async (input) => callTool(() => handlers.projectsInspect(input))
  );
  server.registerTool(
    "jobs.submit",
    {
      description: "Submit one atomic Supabase operation",
      inputSchema: JobSubmissionSchema.shape
    },
    async (input) => callTool(() => handlers.jobsSubmit(input))
  );
  server.registerTool(
    "jobs.wait",
    {
      description: "Long-poll job events after a cursor",
      inputSchema: {
        job_id: z.string().uuid(),
        cursor: z.number().int().min(0).default(0),
        timeout_ms: z.number().int().min(0).max(30_000).default(30_000)
      }
    },
    async (input) => callTool(() => handlers.jobsWait(input))
  );
  server.registerTool(
    "jobs.status",
    {
      description: "Read current job status",
      inputSchema: { job_id: z.string().uuid() }
    },
    async (input) => callTool(() => handlers.jobsStatus(input))
  );
  server.registerTool(
    "jobs.cancel",
    {
      description: "Cancel a job that has not started running",
      inputSchema: { job_id: z.string().uuid() }
    },
    async (input) => callTool(() => handlers.jobsCancel(input))
  );
  server.registerTool(
    "sessions.open",
    {
      description: "Request a capability-scoped interactive lease",
      inputSchema: {
        project: z.string().min(1),
        capability: z.enum(capabilityNames),
        repo_sha: z.string().min(6).max(64),
        idempotency_key: z.string().min(1).max(255),
        ttl_ms: z.number().int().min(1_000).max(900_000).default(60_000)
      }
    },
    async (input) => callTool(() => handlers.sessionsOpen(input))
  );
  server.registerTool(
    "sessions.exec",
    {
      description: "Submit a structured operation inside an active lease",
      inputSchema: {
        session_id: z.string().uuid(),
        operation: z.enum(operationNames),
        payload: CredentialFreePayloadSchema.default({}),
        idempotency_key: z.string().min(1).max(255)
      }
    },
    async (input) => callTool(() => handlers.sessionsExec(input))
  );
  server.registerTool(
    "sessions.close",
    {
      description: "Close a session and release its chamber",
      inputSchema: { session_id: z.string().uuid() }
    },
    async (input) => callTool(() => handlers.sessionsClose(input))
  );

  return server;
}

// ponytail: database_path and approval_mode stay fixed for the process
// lifetime; capability and project changes hot-reload per request.
export function createConfigReloader(
  configPath: string
): () => SupadrumConfig {
  let config = loadConfig(configPath);
  let mtime = configMtime(configPath);
  return () => {
    const current = configMtime(configPath);
    if (current !== null && current !== mtime) {
      try {
        config = loadConfig(configPath);
        mtime = current;
      } catch {
        // Keep serving the last valid config; a broken edit must not kill
        // live agent sessions. mtime deliberately stays at the last good
        // read so the next call retries: filesystems with coarse mtime
        // resolution can stamp a broken write and its repair with the same
        // timestamp, and consuming it here would strand the process on a
        // stale config until some later write happened to differ.
      }
    }
    return config;
  };
}

/*
 * Process bootstrap: everything below binds this module to the real process —
 * its stdio, its argv, its exit code — so calling it in-process would hijack
 * the test runner's own streams, and the entrypoint guard is false by design
 * whenever the module is imported rather than executed. The spawned-server
 * tests in test/mcp.test.ts do exercise it end-to-end; a coverage instrument
 * scoped to the test process simply cannot observe a child process. Excluded
 * from the measurement so the reported number means "code the instrument can
 * see", rather than carrying a permanent red block everyone learns to ignore.
 */
/* v8 ignore start */
export async function runMcp(
  configPath = resolveOperatorConfigPath({
    args: [],
    environment: process.env,
    cwd: process.cwd(),
    homeDirectory: homedir()
  })
): Promise<void> {
  const getConfig = createConfigReloader(configPath);
  const config = getConfig();
  const store = new SqliteStore(
    config.database_path,
    undefined,
    config.approval_mode
  );
  const server = createMcpServer(getConfig, store);
  const transport = new StdioServerTransport();
  let storeClosed = false;
  const closeStore = () => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  };
  server.server.onclose = closeStore;

  try {
    await server.connect(transport);
  } catch (error) {
    closeStore();
    throw error;
  }
}

const entrypoint = process.argv[1];
if (isEntrypoint(import.meta.url, entrypoint)) {
  runMcp().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
/* v8 ignore stop */

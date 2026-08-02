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
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  if (!project.capabilities.includes(capability)) {
    throw new Error(`Project ${projectName} lacks ${capability}`);
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
        if (events.length > 0) {
          return {
            job: publicJob(store, input.job_id),
            events,
            cursor: events.at(-1)?.cursor ?? input.cursor
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
    async () => toolResult(handlers.projectsList())
  );
  server.registerTool(
    "projects.inspect",
    {
      description: "Inspect one redacted project chamber",
      inputSchema: { project: z.string().min(1) }
    },
    async (input) => toolResult(handlers.projectsInspect(input))
  );
  server.registerTool(
    "jobs.submit",
    {
      description: "Submit one atomic Supabase operation",
      inputSchema: JobSubmissionSchema.shape
    },
    async (input) => toolResult(handlers.jobsSubmit(input))
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
    async (input) => toolResult(await handlers.jobsWait(input))
  );
  server.registerTool(
    "jobs.status",
    {
      description: "Read current job status",
      inputSchema: { job_id: z.string().uuid() }
    },
    async (input) => toolResult(handlers.jobsStatus(input))
  );
  server.registerTool(
    "jobs.cancel",
    {
      description: "Cancel a job that has not started running",
      inputSchema: { job_id: z.string().uuid() }
    },
    async (input) => toolResult(handlers.jobsCancel(input))
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
    async (input) => toolResult(handlers.sessionsOpen(input))
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
    async (input) => toolResult(handlers.sessionsExec(input))
  );
  server.registerTool(
    "sessions.close",
    {
      description: "Close a session and release its chamber",
      inputSchema: { session_id: z.string().uuid() }
    },
    async (input) => toolResult(handlers.sessionsClose(input))
  );

  return server;
}

export async function runMcp(
  configPath = resolveOperatorConfigPath({
    args: [],
    environment: process.env,
    cwd: process.cwd(),
    homeDirectory: homedir()
  })
): Promise<void> {
  let config = loadConfig(configPath);
  let mtime = configMtime(configPath);
  // ponytail: database_path and approval_mode stay fixed for the process
  // lifetime; capability and project changes hot-reload per request.
  const getConfig = () => {
    const current = configMtime(configPath);
    if (current !== null && current !== mtime) {
      mtime = current;
      try {
        config = loadConfig(configPath);
      } catch {
        // Keep serving the last valid config; a broken edit must not
        // kill live agent sessions.
      }
    }
    return config;
  };
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

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { CapabilitySchema, OperationSchema } from "./domain.js";
import { BrokerError } from "./errors.js";

const VaultReferenceSchema = z
  .string()
  .regex(/^vault:\/\/[^\s]+$/, "Expected a vault:// reference");

const CredentialBundleSchema = z.object({
  secret_key: VaultReferenceSchema,
  management_token: VaultReferenceSchema,
  database_access: VaultReferenceSchema
});

const CredentialNameSchema = z.enum([
  "secret_key",
  "management_token",
  "database_access"
]);

const CommandTemplateSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string().min(1), CredentialNameSchema).default({}),
  verify_repo_sha: z.boolean().default(true)
});

const ProjectFields = {
  repo: z.string().min(1).optional(),
  capabilities: z
    .array(CapabilitySchema)
    .min(1)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "Capabilities must be unique"
        });
      }
    }),
  commands: z.partialRecord(OperationSchema, CommandTemplateSchema).optional(),
  mode: z.enum(["dry-run", "live"]).optional(),
  migrations: z.enum(["owner", "consumer"]).optional(),
  migration_driver: z.enum(["supabase", "prisma"]).default("supabase")
} as const;

const LegacyProjectSchema = z.object({
  ...ProjectFields,
  project_ref: z.string().min(1),
  credentials: CredentialBundleSchema,
  chamber: z.never().optional()
});

const SharedProjectSchema = z.object({
  ...ProjectFields,
  chamber: z.string().min(1),
  project_ref: z.never().optional(),
  credentials: z.never().optional()
});

const InputProjectSchema = z.union([
  LegacyProjectSchema,
  SharedProjectSchema
]);

const RemoteChamberSchema = z.object({
  target: z.literal("remote").default("remote"),
  project_ref: z.string().min(1),
  credentials: CredentialBundleSchema,
  managed_secrets: z
    .record(
      z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      VaultReferenceSchema
    )
    .default({})
});

const LocalChamberSchema = z
  .object({
    target: z.literal("local")
  })
  .strict();

const ChamberSchema = z.union([
  LocalChamberSchema,
  RemoteChamberSchema
]);

const ConfigSchema = z.object({
  version: z.literal(1),
  database: z.string().min(1).default(".supadrum/queue.sqlite"),
  executor: z.enum(["dry-run", "command"]).default("dry-run"),
  approval_mode: z.enum(["automatic", "manual"]).default("automatic"),
  vault_command: z.array(z.string().min(1)).min(1).optional(),
  chambers: z.record(z.string().min(1), ChamberSchema).default({}),
  projects: z.record(z.string().min(1), InputProjectSchema)
});

export type CredentialBundle = z.infer<typeof CredentialBundleSchema>;
export type CommandTemplate = z.infer<typeof CommandTemplateSchema>;
export interface ChamberConfig {
  readonly target?: "remote" | "local";
  readonly project_ref: string;
  readonly credentials: CredentialBundle;
  readonly managed_secrets?: Record<string, string>;
}
export interface ProjectConfig extends ChamberConfig {
  readonly repo?: string;
  readonly chamber: string;
  readonly capabilities: z.infer<typeof CapabilitySchema>[];
  readonly commands?: Partial<
    Record<z.infer<typeof OperationSchema>, CommandTemplate>
  >;
  readonly mode: "dry-run" | "live";
  readonly migrations: "owner" | "consumer";
  readonly migration_driver: "supabase" | "prisma";
}
export interface SupadrumConfig {
  readonly version: 1;
  readonly database: string;
  readonly executor: "dry-run" | "command";
  readonly approval_mode: "automatic" | "manual";
  readonly vault_command?: string[];
  readonly chambers: Record<string, ChamberConfig>;
  readonly projects: Record<string, ProjectConfig>;
  readonly config_path: string;
  readonly database_path: string;
}

function normalizedVaultCommand(
  command: readonly string[] | undefined
): string[] | undefined {
  if (!command) return undefined;
  if (
    basename(command[0] ?? "") === "node" &&
    basename(command[1] ?? "") === "vault-cli.js" &&
    command.slice(-2).join(" ") === "keychain resolve"
  ) {
    return [process.execPath, ...command.slice(1)];
  }
  return [...command];
}

export function configMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function loadConfig(path: string): SupadrumConfig {
  const absolutePath = resolve(path);
  const parsed = ConfigSchema.parse(parse(readFileSync(absolutePath, "utf8")));
  const baseDirectory = dirname(absolutePath);
  const chambers: Record<string, ChamberConfig> = Object.fromEntries(
    Object.entries(parsed.chambers).map(([name, chamber]) => [
      name,
      chamber.target === "local"
        ? {
            target: "local",
            project_ref: "",
            credentials: {
              secret_key: "",
              management_token: "",
              database_access: ""
            }
          }
        : chamber
    ])
  );
  const projects: Record<string, ProjectConfig> = {};

  for (const [name, input] of Object.entries(parsed.projects)) {
    const shared = typeof input.chamber === "string";
    const chamberName = input.chamber ?? name;
    const chamber = shared
      ? chambers[chamberName]
      : input.project_ref && input.credentials
        ? {
            target: "remote" as const,
            project_ref: input.project_ref,
            credentials: input.credentials
          }
        : undefined;
    if (!chamber) {
      throw new Error(
        `Project ${name} references unknown chamber ${chamberName}`
      );
    }
    if (!shared) {
      const existing = chambers[chamberName];
      if (
        existing &&
        (existing.project_ref !== chamber.project_ref ||
          JSON.stringify(existing.credentials) !==
            JSON.stringify(chamber.credentials))
      ) {
        throw new Error(
          `Legacy project ${name} conflicts with chamber ${chamberName}`
        );
      }
      chambers[chamberName] = chamber;
    }
    projects[name] = {
      ...(input.repo
        ? { repo: resolve(baseDirectory, input.repo) }
        : {}),
      chamber: chamberName,
      ...(chamber.target ? { target: chamber.target } : {}),
      project_ref: chamber.project_ref,
      credentials: chamber.credentials,
      managed_secrets: chamber.managed_secrets ?? {},
      capabilities: input.capabilities,
      ...(input.commands ? { commands: input.commands } : {}),
      mode:
        input.mode ??
        (parsed.executor === "command" ? "live" : "dry-run"),
      migrations:
        input.migrations ??
        (!shared && input.capabilities.includes("migrations")
          ? "owner"
          : "consumer"),
      migration_driver: input.migration_driver
    };
    if (
      chamber.target === "local" &&
      (input.capabilities.some(
        (capability) =>
          capability !== "migrations" && capability !== "auth-admin"
      ) ||
        input.migration_driver !== "supabase")
    ) {
      throw new Error(
        `Local chamber ${chamberName} supports only the migrations and auth-admin capabilities with the supabase driver`
      );
    }
  }

  for (const chamberName of Object.keys(chambers)) {
    const owners = Object.entries(projects)
      .filter(
        ([, project]) =>
          project.chamber === chamberName &&
          project.migrations === "owner"
      )
      .map(([name]) => name);
    if (owners.length > 1) {
      throw new Error(
        `Chamber ${chamberName} has multiple migration owners: ${owners.join(", ")}`
      );
    }
  }
  const vaultCommand = normalizedVaultCommand(parsed.vault_command);

  return {
    version: parsed.version,
    database: parsed.database,
    executor: parsed.executor,
    approval_mode: parsed.approval_mode,
    ...(vaultCommand
      ? { vault_command: vaultCommand }
      : {}),
    projects,
    chambers,
    config_path: absolutePath,
    database_path: resolve(baseDirectory, parsed.database)
  };
}

export function inspectProject(name: string, config: SupadrumConfig) {
  const project = config.projects[name];
  if (!project) {
    throw new BrokerError("unknown_project", `Unknown project: ${name}`);
  }

  return {
    name,
    ...(project.repo ? { repo: project.repo } : {}),
    ...(project.target === "local"
      ? { target: "local" }
      : { project_ref: project.project_ref }),
    chamber: project.chamber,
    mode: project.mode,
    migrations: project.migrations,
    migration_driver: project.migration_driver,
    capabilities: project.capabilities,
    credentials:
      project.target === "local"
        ? []
        : Object.keys(project.credentials).sort(),
    executor: project.mode === "live" ? "command" : "dry-run"
  };
}

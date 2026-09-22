import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { CapabilitySchema, OperationSchema } from "./domain.js";
import { BrokerError } from "./errors.js";

/**
 * Capabilities a local chamber may declare. `sql` is here because a local
 * Supabase stack is the one place a developer legitimately reads and writes
 * freely; without it every local inspection has to go around the broker, which
 * is worse than allowing it through the broker's own audited path.
 * Deliberately excluded: anything that needs a stored credential (data-api,
 * storage, edge-functions, secrets, project-management) — a local stack has
 * none to resolve.
 */
const LOCAL_CAPABILITIES: ReadonlySet<string> = new Set([
  "migrations",
  "auth-admin",
  "sql",
  "adapter-tests",
  "schema-inspection"
]);

const VaultReferenceSchema = z
  .string()
  .regex(/^vault:\/\/[^\s]+$/, "Expected a vault:// reference");

/**
 * The three Supabase credentials are required because every chamber was built
 * around them. `deploy_token` is optional: a chamber that never ships anything
 * has no reason to hold one, and a job that asks for a credential the chamber
 * does not carry stops at `waiting_credentials` naming it, rather than running
 * with the variable unset and failing somewhere less legible.
 */
const CredentialBundleSchema = z.object({
  secret_key: VaultReferenceSchema,
  management_token: VaultReferenceSchema,
  database_access: VaultReferenceSchema,
  deploy_token: VaultReferenceSchema.optional()
});

const CredentialNameSchema = z.enum([
  "secret_key",
  "management_token",
  "database_access",
  "deploy_token"
]);

/**
 * One command, or a sequence of them.
 *
 * A sequence exists because some real operations are irreducibly multi-step:
 * a Vercel production deploy is `pull`, then `build`, then `deploy --prebuilt`,
 * and collapsing them into a repository script would move the steps out of the
 * operator-owned config and into something the repository can rewrite.
 *
 * Steps share the template's cwd, credentials and repo verification, and stop
 * at the first non-zero exit.
 */
const CommandStepSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional()
});

const CommandTemplateSchema = z
  .object({
    argv: z.array(z.string().min(1)).min(1).optional(),
    steps: z.array(CommandStepSchema).min(1).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string().min(1), CredentialNameSchema).default({}),
    verify_repo_sha: z.boolean().default(true)
  })
  .superRefine((value, context) => {
    if (Boolean(value.argv) === Boolean(value.steps)) {
      context.addIssue({
        code: "custom",
        message: "A command needs exactly one of argv or steps"
      });
    }
  });

/**
 * Where a project ships to. Discovered from the repository the same way the
 * Supabase project ref is, so an operator never types an id: the ids are not
 * secret, only the token that acts on them is, and that one lives in the vault
 * like every other credential.
 */
const DeployTargetSchema = z.object({
  provider: z.literal("vercel").default("vercel"),
  project_id: z.string().min(1),
  org_id: z.string().min(1)
});

const ProjectFields = {
  repo: z.string().min(1).optional(),
  supabase_dir: z.string().min(1).optional(),
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
  deploy_target: DeployTargetSchema.optional(),
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
  deploy_target: DeployTargetSchema.optional(),
  credentials: CredentialBundleSchema,
  managed_secrets: z
    .record(
      z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      VaultReferenceSchema
    )
    .default({}),
  adapter_tests: z.never().optional()
});

const LocalChamberSchema = z
  .object({
    target: z.literal("local"),
    auth_password_accounts: z.record(
      z.string().regex(/^[a-z][a-z0-9_]*$/),
      z.object({
        user_id: z.uuid(),
        email: z.email().max(320),
        password_ref: VaultReferenceSchema
      }).strict()
    ).optional(),
    adapter_tests: z.record(
      z.string().regex(/^[a-z][a-z0-9._-]*$/),
      z.object({
        npm_script: z.string().regex(/^[a-zA-Z][a-zA-Z0-9:._-]*$/),
        writer_password_ref: VaultReferenceSchema,
        password_accounts: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).optional(),
        setup_sql_path: z.string()
          .regex(/^[a-zA-Z0-9_./-]+$/)
          .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."))
          .optional(),
        personas: z.record(
          z.string().regex(/^[a-z][a-z0-9_]*$/),
          z.uuid()
        ).refine((personas) =>
          ["student", "staff", "outsider"].every((name) => Object.hasOwn(personas, name)) &&
          new Set(Object.values(personas)).size === Object.keys(personas).length
        )
      }).strict()
    ).optional()
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
export type DeployTarget = z.infer<typeof DeployTargetSchema>;
export type AdapterTestConfig = NonNullable<z.infer<typeof LocalChamberSchema>["adapter_tests"]>[string];
export type LocalPasswordAccount = NonNullable<z.infer<typeof LocalChamberSchema>["auth_password_accounts"]>[string];

export interface ChamberConfig {
  readonly target?: "remote" | "local";
  readonly project_ref: string;
  readonly deploy_target?: DeployTarget | undefined;
  readonly credentials: CredentialBundle;
  readonly managed_secrets?: Record<string, string>;
  readonly adapter_tests?: Record<string, AdapterTestConfig>;
  readonly auth_password_accounts?: Record<string, LocalPasswordAccount>;
}
export interface ProjectConfig extends ChamberConfig {
  readonly repo?: string;
  /**
   * Where `supabase/config.toml` actually lives, when it is not at the
   * repository root. Every local-chamber operation shells out to the
   * `supabase` CLI, which resolves "the current project" from its working
   * directory alone — given the repository root instead, it does not error,
   * it silently picks up whatever OTHER local Supabase stack happens to be
   * running on the machine. Resolved against `repo`; setting it without
   * `repo` is a config error.
   */
  readonly supabase_dir?: string;
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
  const credentialRefs = new Set<string>();
  for (const chamber of Object.values(parsed.chambers)) {
    if (chamber.target !== "remote") continue;
    Object.values(chamber.credentials).forEach((ref) => { if (ref) credentialRefs.add(ref); });
    Object.values(chamber.managed_secrets).forEach((ref) => credentialRefs.add(ref));
  }
  for (const project of Object.values(parsed.projects)) {
    if (!project.credentials) continue;
    Object.values(project.credentials).forEach((ref) => { if (ref) credentialRefs.add(ref); });
  }
  const writerRefs = new Set<string>();
  const authRefs = new Set<string>();
  for (const chamber of Object.values(parsed.chambers)) {
    if (chamber.target !== "local") continue;
    const accounts = Object.values(chamber.auth_password_accounts ?? {});
    for (const key of ["user_id", "email", "password_ref"] as const) {
      const values = accounts.map((account) => key === "email" ? account.email.toLowerCase() : account[key]);
      if (new Set(values).size !== values.length) throw new Error(`Duplicate local auth account ${key}`);
    }
    for (const account of accounts) {
      if (credentialRefs.has(account.password_ref)) throw new Error("Local auth password reference collides with a credential reference");
      if (authRefs.has(account.password_ref) || writerRefs.has(account.password_ref)) {
        throw new Error("Local auth password reference is shared");
      }
      authRefs.add(account.password_ref);
    }
    for (const registration of Object.values(chamber.adapter_tests ?? {})) {
      const ref = registration.writer_password_ref;
      if (credentialRefs.has(ref)) throw new Error("Adapter writer password collides with a credential reference");
      if (writerRefs.has(ref)) throw new Error("Adapter writer password reference is shared by scripts");
      if (authRefs.has(ref)) throw new Error("Adapter writer password reference is shared with a local auth account");
      writerRefs.add(ref);
      for (const name of registration.password_accounts ?? []) {
        if (!Object.hasOwn(chamber.auth_password_accounts ?? {}, name)) {
          throw new Error(`Adapter test password account is not registered: ${name}`);
        }
      }
      if (new Set(registration.password_accounts ?? []).size !== (registration.password_accounts ?? []).length) {
        throw new Error("Duplicate adapter test password account");
      }
    }
  }
  const baseDirectory = dirname(absolutePath);
  const chambers: Record<string, ChamberConfig> = Object.fromEntries(
    Object.entries(parsed.chambers).map(([name, chamber]) => [
      name,
      chamber.target === "local"
        ? {
            target: "local",
            ...(chamber.adapter_tests ? { adapter_tests: chamber.adapter_tests } : {}),
            ...(chamber.auth_password_accounts ? { auth_password_accounts: chamber.auth_password_accounts } : {}),
            project_ref: "",
            credentials: {
              secret_key: "",
              management_token: "",
              database_access: ""
            }
          }
        : {
            target: "remote",
            project_ref: chamber.project_ref,
            credentials: chamber.credentials,
            ...(chamber.deploy_target ? { deploy_target: chamber.deploy_target } : {}),
            managed_secrets: chamber.managed_secrets
          }
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
            ...(input.deploy_target
              ? { deploy_target: input.deploy_target }
              : {}),
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
    const resolvedRepo = input.repo
      ? resolve(baseDirectory, input.repo)
      : undefined;
    if (input.supabase_dir && !resolvedRepo) {
      throw new Error(`Project ${name} sets supabase_dir without repo`);
    }
    projects[name] = {
      ...(resolvedRepo ? { repo: resolvedRepo } : {}),
      ...(resolvedRepo && input.supabase_dir
        ? { supabase_dir: resolve(resolvedRepo, input.supabase_dir) }
        : {}),
      chamber: chamberName,
      ...(chamber.target ? { target: chamber.target } : {}),
      project_ref: chamber.project_ref,
      ...(chamber.deploy_target
        ? { deploy_target: chamber.deploy_target }
        : {}),
      credentials: chamber.credentials,
      managed_secrets: chamber.managed_secrets ?? {},
      ...(chamber.adapter_tests ? { adapter_tests: chamber.adapter_tests } : {}),
      ...(chamber.auth_password_accounts ? { auth_password_accounts: chamber.auth_password_accounts } : {}),
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
        (capability) => !LOCAL_CAPABILITIES.has(capability)
      ) ||
        input.migration_driver !== "supabase")
    ) {
      throw new Error(
        `Local chamber ${chamberName} supports only the ${[...LOCAL_CAPABILITIES].join(", ")} capabilities with the supabase driver`
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
    ...(project.supabase_dir ? { supabase_dir: project.supabase_dir } : {}),
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

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Document, parseDocument } from "yaml";

import {
  loadConfig,
  type SupadrumConfig
} from "./config.js";
import {
  capabilityNames,
  type Capability
} from "./catalog.js";

const aliasPattern = /^[a-z0-9][a-z0-9._-]*$/;
const projectRefPattern = /^[a-z0-9]{20}$/;
const publicUrlNames = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL"
] as const;

export const projectProfiles = {
  inspect: [
    "data-api",
    "schema-inspection",
    "project-management"
  ],
  development: [
    "data-api",
    "storage",
    "edge-functions",
    "migrations",
    "schema-inspection",
    "project-management"
  ],
  admin: [...capabilityNames]
} as const satisfies Record<string, readonly Capability[]>;

export type ProjectProfile = keyof typeof projectProfiles;

export interface ProjectDiscovery {
  readonly alias: string;
  readonly repository: string | null;
  readonly project_ref: string | null;
  readonly repository_source: string | null;
  readonly project_ref_source: string | null;
}

function validAlias(alias: string): string {
  if (!aliasPattern.test(alias)) {
    throw new Error(
      "Project alias must use lowercase letters, numbers, dots, underscores, or dashes"
    );
  }
  return alias;
}

function validProjectRef(projectRef: string): string {
  if (!projectRefPattern.test(projectRef)) {
    throw new Error("Supabase project ref must be 20 lowercase characters");
  }
  return projectRef;
}

function gitRoot(path: string): string | null {
  try {
    const root = execFileSync(
      "git",
      ["-C", path, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return root ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

function findRepository(
  alias: string,
  cwd: string,
  homeDirectory: string
): {
  readonly path: string | null;
  readonly source: string | null;
} {
  const candidates: ReadonlyArray<readonly [string, string]> = [
    [cwd, "cwd"],
    [join(dirname(cwd), alias), "sibling"],
    [join(homeDirectory, "Documents", alias), "~/Documents"],
    [join(homeDirectory, "Developer", alias), "~/Developer"],
    [join(homeDirectory, "Projects", alias), "~/Projects"]
  ];
  const seen = new Set<string>();
  for (const [candidate, source] of candidates) {
    const absolute = resolve(candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const root = gitRoot(absolute);
    if (!root) continue;
    if (source === "cwd" && basename(root) !== alias) continue;
    return { path: root, source };
  }
  return { path: null, source: null };
}

export function discoverProjectRepository(input: {
  readonly alias: string;
  readonly cwd: string;
  readonly homeDirectory: string;
}): {
  readonly path: string | null;
  readonly source: string | null;
} {
  return findRepository(
    validAlias(input.alias),
    input.cwd,
    input.homeDirectory
  );
}

function readProjectRefFile(
  repository: string,
  relativePath: string
): string | null {
  const path = join(repository, relativePath);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return projectRefPattern.test(value) ? value : null;
}

function publicUrlProjectRef(
  repository: string
): {
  readonly ref: string;
  readonly source: string;
} | null {
  const paths = [
    ".env",
    ".env.local",
    "frontend/.env",
    "frontend/.env.local"
  ];
  const matches: Array<{ ref: string; source: string }> = [];
  for (const relativePath of paths) {
    const path = join(repository, relativePath);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    for (const name of publicUrlNames) {
      const match = source.match(
        new RegExp(
          `^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?https://([a-z0-9]{20})\\.supabase\\.co/?["']?\\s*$`,
          "m"
        )
      );
      if (match?.[1]) {
        matches.push({
          ref: match[1],
          source: `${relativePath}:${name}`
        });
      }
    }
  }
  const refs = new Set(matches.map(({ ref }) => ref));
  if (refs.size > 1) {
    throw new Error("Conflicting Supabase project refs in public URLs");
  }
  return matches[0] ?? null;
}

function discoverProjectRef(
  repository: string
): {
  readonly ref: string | null;
  readonly source: string | null;
} {
  const linked = readProjectRefFile(
    repository,
    "supabase/.temp/project-ref"
  );
  if (linked) {
    return {
      ref: linked,
      source: "supabase/.temp/project-ref"
    };
  }

  const configPath = join(repository, "supabase", "config.toml");
  if (existsSync(configPath)) {
    const match = readFileSync(configPath, "utf8").match(
      /^\s*project_id\s*=\s*["']([a-z0-9]{20})["']\s*$/m
    );
    if (match?.[1]) {
      return {
        ref: match[1],
        source: "supabase/config.toml:project_id"
      };
    }
  }

  const publicUrl = publicUrlProjectRef(repository);
  return publicUrl
    ? { ref: publicUrl.ref, source: publicUrl.source }
    : { ref: null, source: null };
}

export function discoverProject(input: {
  readonly alias: string;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly repository?: string;
  readonly project_ref?: string;
}): ProjectDiscovery {
  const alias = validAlias(input.alias);
  const explicitRepository = input.repository
    ? gitRoot(resolve(input.cwd, input.repository))
    : null;
  if (input.repository && !explicitRepository) {
    throw new Error(`Not a Git repository: ${input.repository}`);
  }
  const repository = explicitRepository
    ? { path: explicitRepository, source: "explicit" }
    : findRepository(alias, input.cwd, input.homeDirectory);
  const discoveredRef = repository.path
    ? discoverProjectRef(repository.path)
    : { ref: null, source: null };
  const explicitRef = input.project_ref
    ? validProjectRef(input.project_ref)
    : null;
  if (
    explicitRef &&
    discoveredRef.ref &&
    explicitRef !== discoveredRef.ref
  ) {
    throw new Error(
      "Explicit Supabase project ref does not match repository metadata"
    );
  }

  return {
    alias,
    repository: repository.path,
    project_ref: explicitRef ?? discoveredRef.ref,
    repository_source: repository.source,
    project_ref_source: explicitRef ? "explicit" : discoveredRef.source
  };
}

function argumentOption(
  args: readonly string[],
  name: string
): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function resolveOperatorConfigPath(input: {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homeDirectory: string;
}): string {
  const explicit = argumentOption(input.args, "--config");
  if (explicit) return resolve(input.cwd, explicit);
  if (input.environment.SUPADRUM_CONFIG) {
    return resolve(input.cwd, input.environment.SUPADRUM_CONFIG);
  }
  const local = join(input.cwd, "supadrum.yml");
  if (existsSync(local)) return local;
  const dotSupadrum = join(
    input.cwd,
    ".supadrum",
    "config.yml"
  );
  if (existsSync(dotSupadrum)) return dotSupadrum;
  const configHome =
    input.environment.XDG_CONFIG_HOME ??
    join(input.homeDirectory, ".config");
  return join(configHome, "supadrum", "config.yml");
}

function loadOrCreateDocument(path: string): Document {
  if (!existsSync(path)) {
    return new Document({
      version: 1,
      database: "queue.sqlite",
      executor: "dry-run",
      approval_mode: "automatic",
      projects: {}
    });
  }
  const document = parseDocument(readFileSync(path, "utf8"), {
    uniqueKeys: true
  });
  if (document.errors.length > 0) {
    throw new Error(`Invalid Supadrum config: ${document.errors[0]?.message}`);
  }
  return document;
}

function atomicWriteConfig(path: string, document: Document): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${path.split("/").at(-1)}.supadrum-${randomUUID()}`
  );
  let created = false;
  try {
    writeFileSync(temporaryPath, document.toString(), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    created = true;
    chmodSync(temporaryPath, 0o600);
    loadConfig(temporaryPath);
    renameSync(temporaryPath, path);
    created = false;
  } finally {
    if (created) {
      try {
        unlinkSync(temporaryPath);
      } catch {}
    }
  }
}

function normalizedConfigDocument(config: SupadrumConfig): Document {
  return new Document({
    version: 1,
    database: config.database,
    executor: "dry-run",
    approval_mode: config.approval_mode,
    ...(config.vault_command
      ? { vault_command: [...config.vault_command] }
      : {}),
    chambers: Object.fromEntries(
      Object.entries(config.chambers).map(([name, chamber]) => [
        name,
        chamber.target === "local"
          ? { target: "local" }
          : {
              project_ref: chamber.project_ref,
              credentials: chamber.credentials,
              ...(chamber.managed_secrets &&
              Object.keys(chamber.managed_secrets).length > 0
                ? { managed_secrets: chamber.managed_secrets }
                : {})
            }
      ])
    ),
    projects: Object.fromEntries(
      Object.entries(config.projects).map(([name, project]) => [
        name,
        {
          ...(project.repo ? { repo: project.repo } : {}),
          chamber: project.chamber,
          mode: project.mode,
          migrations: project.migrations,
          migration_driver: project.migration_driver,
          capabilities: project.capabilities,
          ...(project.commands ? { commands: project.commands } : {})
        }
      ])
    )
  });
}

function writeNormalizedConfig(
  configPath: string,
  config: SupadrumConfig
): void {
  atomicWriteConfig(configPath, normalizedConfigDocument(config));
}

export function setMigrationOwner(
  configPath: string,
  alias: string
): void {
  const config = loadConfig(configPath);
  const target = config.projects[alias];
  if (!target) throw new Error(`Unknown project: ${alias}`);
  if (!target.capabilities.includes("migrations")) {
    throw new Error(`Project ${alias} lacks migrations capability`);
  }
  const projects: SupadrumConfig["projects"] = Object.fromEntries(
    Object.entries(config.projects).map(([name, project]) => [
      name,
      project.chamber === target.chamber
        ? {
            ...project,
            migrations: name === alias ? ("owner" as const) : ("consumer" as const)
          }
        : project
    ])
  );
  writeNormalizedConfig(configPath, { ...config, projects });
}

export function setMigrationDriver(
  configPath: string,
  alias: string,
  driver: "supabase" | "prisma"
): void {
  const config = loadConfig(configPath);
  const project = config.projects[alias];
  if (!project) throw new Error(`Unknown project: ${alias}`);
  if (!project.capabilities.includes("migrations")) {
    throw new Error(`Project ${alias} lacks migrations capability`);
  }
  writeNormalizedConfig(configPath, {
    ...config,
    projects: {
      ...config.projects,
      [alias]: { ...project, migration_driver: driver }
    }
  });
}

export function shareProjectChamber(
  configPath: string,
  alias: string,
  sourceAlias: string
): void {
  const config = loadConfig(configPath);
  const target = config.projects[alias];
  const source = config.projects[sourceAlias];
  if (!target) throw new Error(`Unknown project: ${alias}`);
  if (!source) throw new Error(`Unknown project: ${sourceAlias}`);
  if (target.project_ref !== source.project_ref) {
    throw new Error(
      `Cannot share chamber: ${alias} and ${sourceAlias} use different Supabase refs`
    );
  }
  const projects = {
    ...config.projects,
    [alias]: {
      ...target,
      chamber: source.chamber,
      project_ref: source.project_ref,
      credentials: source.credentials,
      migrations: "consumer" as const
    }
  };
  const usedChambers = new Set(
    Object.values(projects).map((project) => project.chamber)
  );
  const chambers = Object.fromEntries(
    Object.entries(config.chambers).filter(([name]) =>
      usedChambers.has(name)
    )
  );
  writeNormalizedConfig(configPath, {
    ...config,
    projects,
    chambers
  });
}

export function setProjectMode(
  configPath: string,
  alias: string,
  mode: "dry-run" | "live"
): void {
  const config = loadConfig(configPath);
  const project = config.projects[alias];
  if (!project) throw new Error(`Unknown project: ${alias}`);
  writeNormalizedConfig(configPath, {
    ...config,
    projects: {
      ...config.projects,
      [alias]: { ...project, mode }
    }
  });
}

export function setProjectRepository(
  configPath: string,
  alias: string,
  repository: string
): void {
  const config = loadConfig(configPath);
  const project = config.projects[alias];
  if (!project) throw new Error(`Unknown project: ${alias}`);
  const root = gitRoot(repository);
  if (!root) throw new Error(`Not a Git repository: ${repository}`);
  writeNormalizedConfig(configPath, {
    ...config,
    projects: {
      ...config.projects,
      [alias]: { ...project, repo: root }
    }
  });
}

export function addProject(input: {
  readonly alias: string;
  readonly repository: string;
  readonly project_ref: string;
  readonly profile: ProjectProfile;
  readonly config_path: string;
  readonly vault_command?: readonly string[];
}): {
  readonly added: true;
  readonly alias: string;
  readonly config_path: string;
  readonly repository: string;
  readonly project_ref: string;
  readonly profile: ProjectProfile;
} {
  const alias = validAlias(input.alias);
  const repository = gitRoot(input.repository);
  if (!repository) {
    throw new Error(`Not a Git repository: ${input.repository}`);
  }
  const projectRef = validProjectRef(input.project_ref);
  const profile = input.profile;
  if (!(profile in projectProfiles)) {
    throw new Error(`Unknown project profile: ${String(profile)}`);
  }
  const configPath = isAbsolute(input.config_path)
    ? input.config_path
    : resolve(input.config_path);
  const document = loadOrCreateDocument(configPath);
  if (document.getIn(["projects", alias]) !== undefined) {
    throw new Error(`Project already exists: ${alias}`);
  }
  if (
    input.vault_command &&
    document.get("vault_command") === undefined
  ) {
    document.set("vault_command", [...input.vault_command]);
  }
  document.setIn(["projects", alias], {
    repo: repository,
    project_ref: projectRef,
    credentials: {
      secret_key: `vault://supabase/${alias}/secret`,
      management_token: `vault://supabase/${alias}/management`,
      database_access: `vault://supabase/${alias}/postgres`
    },
    capabilities: [...projectProfiles[profile]]
  });
  atomicWriteConfig(configPath, document);

  return {
    added: true,
    alias,
    config_path: configPath,
    repository,
    project_ref: projectRef,
    profile
  };
}

export function addLocalProject(input: {
  readonly alias: string;
  readonly repository: string;
  readonly config_path: string;
}): {
  readonly added: true;
  readonly alias: string;
  readonly config_path: string;
  readonly repository: string;
  readonly target: "local";
} {
  const alias = validAlias(input.alias);
  const repository = gitRoot(input.repository);
  if (!repository) {
    throw new Error(`Not a Git repository: ${input.repository}`);
  }
  const configPath = isAbsolute(input.config_path)
    ? input.config_path
    : resolve(input.config_path);
  const document = loadOrCreateDocument(configPath);
  if (document.getIn(["projects", alias]) !== undefined) {
    throw new Error(`Project already exists: ${alias}`);
  }
  if (document.getIn(["chambers", alias]) !== undefined) {
    throw new Error(`Chamber already exists: ${alias}`);
  }
  document.setIn(["chambers", alias], { target: "local" });
  document.setIn(["projects", alias], {
    repo: repository,
    chamber: alias,
    mode: "live",
    migrations: "owner",
    migration_driver: "supabase",
    capabilities: ["migrations"]
  });
  atomicWriteConfig(configPath, document);

  return {
    added: true,
    alias,
    config_path: configPath,
    repository,
    target: "local"
  };
}

export interface ProjectDoctorReport {
  readonly project: string;
  readonly chamber: string;
  readonly mode: "dry-run" | "live";
  readonly migrations: "owner" | "consumer";
  readonly migration_driver: "supabase" | "prisma";
  readonly ready: boolean;
  readonly repository: boolean;
  readonly project_ref: boolean;
  readonly credentials: {
    readonly secret_key: boolean;
    readonly management_token: boolean;
    readonly database_access: boolean;
  };
  readonly missing_credentials: readonly string[];
  readonly invalid_credentials: readonly string[];
  readonly executor: "dry-run" | "command";
}

export async function doctorProject(
  name: string,
  config: SupadrumConfig,
  probe: (
    name: "secret_key" | "management_token" | "database_access",
    reference: string
  ) => Promise<boolean | "invalid"> = async () => false
): Promise<ProjectDoctorReport> {
  const project = config.projects[name];
  if (!project) throw new Error(`Unknown project: ${name}`);
  const repository = project.repo ? gitRoot(project.repo) !== null : false;
  const projectRef = projectRefPattern.test(project.project_ref);
  const states = {
    secret_key: await probe("secret_key", project.credentials.secret_key),
    management_token: await probe(
      "management_token",
      project.credentials.management_token
    ),
    database_access: await probe(
      "database_access",
      project.credentials.database_access
    )
  };
  const credentials = {
    secret_key: states.secret_key === true,
    management_token: states.management_token === true,
    database_access: states.database_access === true
  };
  const missingCredentials = Object.entries(states)
    .filter(([, state]) => state === false)
    .map(([credential]) => credential);
  const invalidCredentials = Object.entries(states)
    .filter(([, state]) => state === "invalid")
    .map(([credential]) => credential);

  return {
    project: name,
    chamber: project.chamber,
    mode: project.mode,
    migrations: project.migrations,
    migration_driver: project.migration_driver,
    ready:
      repository &&
      projectRef &&
      missingCredentials.length === 0 &&
      invalidCredentials.length === 0,
    repository,
    project_ref: projectRef,
    credentials,
    missing_credentials: missingCredentials,
    invalid_credentials: invalidCredentials,
    executor: project.mode === "live" ? "command" : "dry-run"
  };
}

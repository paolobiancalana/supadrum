import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  readFileSync
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import type { ProjectConfig } from "./config.js";
import type { ExecutionResult, Job } from "./domain.js";
import type {
  Executor,
  ResolvedCredentials
} from "./runner.js";
import {
  assembleSchemaInspection,
  parseCatalogInspection,
  parseMigrationInspection,
  parseSchemaInspectionPayload,
  schemaInspectionPsqlInput
} from "./schema-inspection.js";
import {
  analyzeMigrationHistory,
  parseMigrationBaselinePayload,
  parsePrismaHistoryAvailability,
  parsePrismaHistoryRows,
  validateMigrationPrefix,
  type LocalPrismaMigration,
  type PrismaMigrationHistoryRow
} from "./prisma-baseline.js";
import {
  PRISMA_BASELINE_HISTORY_SQL,
  PRISMA_HISTORY_AVAILABILITY_SQL
} from "./prisma-baseline-sql.js";
import {
  CATALOG_INSPECTION_SQL,
  MIGRATION_INSPECTION_SQL,
  PRISMA_CATALOG_INSPECTION_SQL,
  PRISMA_MIGRATION_INSPECTION_SQL,
  SCHEMA_INSPECTION_PSQL_ARGS
} from "./schema-inspection-sql.js";

export interface LiveProcessInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string;
}

export interface LiveProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LiveProcess {
  run(input: LiveProcessInput): Promise<LiveProcessResult>;
}

const LOCAL_DEVELOPMENT_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$tqde4sbR271Kk9B2RP61QQ$5AgdWw1faQ6mBGWOmd1j3uqhpud/mCMJhj1X1FFte/E";

interface LocalSnapOrganizationInspection {
  readonly action: "inspect-organizations";
  readonly adapter: "snap-auth";
}

interface LocalSnapPasswordAdmin {
  readonly action: "reset-password" | "recreate-test-user";
  readonly adapter: "snap-password";
  readonly email: string;
  readonly organizationSelector?: "snap-dev-ready";
  readonly passwordProfile: "local-development";
}

type LocalSnapAuthAdmin =
  | LocalSnapOrganizationInspection
  | LocalSnapPasswordAdmin;

function localSnapAuthAdmin(
  payload: Record<string, unknown>
): LocalSnapAuthAdmin {
  if (
    payload.action === "inspect-organizations" &&
    payload.adapter === "snap-auth"
  ) {
    return {
      action: "inspect-organizations",
      adapter: "snap-auth"
    };
  }
  if (payload.adapter !== "snap-password") {
    throw new Error("Unsupported local auth admin action or adapter");
  }
  const action = payload.action;
  if (action !== "reset-password" && action !== "recreate-test-user") {
    throw new Error("Unsupported local auth admin action or adapter");
  }
  if (payload.profile !== "local-development") {
    throw new Error("Unsupported local password profile");
  }
  const email = payload.email;
  if (
    typeof email !== "string" ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+$/.test(email)
  ) {
    throw new Error("Local password reset requires a valid email");
  }
  if (
    action === "recreate-test-user" &&
    payload.organization !== "snap-dev-ready"
  ) {
    throw new Error("Unsupported local organization selector");
  }
  return {
    action,
    adapter: "snap-password",
    email,
    ...(action === "recreate-test-user"
      ? { organizationSelector: "snap-dev-ready" as const }
      : {}),
    passwordProfile: "local-development"
  };
}

function localSnapOrganizationInspectionSql(): string {
  return `begin transaction read only;
select json_build_object(
  'id', organization.id,
  'name', organization.name,
  'slug', organization.slug,
  'onboarding_completed', organization.onboarding_completed,
  'products', (
    select count(*) from public.products as product
    where product.organization_id = organization.id
  ),
  'document_ingests', (
    select count(*) from public.document_ingests as ingest
    where ingest.organization_id = organization.id
  )
)::text
from public.organizations as organization
where organization.deleted_at is null
order by organization.name;
commit;
`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function localSnapPasswordResetSql(email: string): string {
  const emailLiteral = sqlLiteral(email);
  const hashLiteral = sqlLiteral(LOCAL_DEVELOPMENT_PASSWORD_HASH);
  return `begin;
do $supadrum$
declare
  updated_credentials integer;
begin
  update public.credentials as credential
  set secret_hash = ${hashLiteral}
  from public.users as app_user
  where credential.user_id = app_user.id
    and credential.type = 'password'
    and app_user.deleted_at is null
    and lower(app_user.email) = lower(${emailLiteral});

  GET DIAGNOSTICS updated_credentials = ROW_COUNT;
  if updated_credentials <> 1 then
    raise exception 'Expected exactly one active password credential, updated %',
      updated_credentials;
  end if;

  update public.users
  set failed_login_attempts = 0,
      locked_until = null
  where deleted_at is null
    and lower(email) = lower(${emailLiteral});
end
$supadrum$;
commit;
`;
}

function localSnapTestUserRecreationSql(email: string): string {
  const emailLiteral = sqlLiteral(email);
  const hashLiteral = sqlLiteral(LOCAL_DEVELOPMENT_PASSWORD_HASH);
  return `begin;
do $supadrum$
declare
  target_organization_id uuid;
  target_user_id uuid;
begin
  select organization.id
  into target_organization_id
  from public.organizations as organization
  where organization.deleted_at is null
    and organization.id = 'a1b2c3d4-0002-4000-8000-000000000001'::uuid;

  if target_organization_id is null then
    raise exception 'Expected the SNAP Dev organization';
  end if;

  update public.organizations
  set onboarding_completed = true,
      updated_at = now()
  where id = target_organization_id;

  select id
  into target_user_id
  from public.users
  where lower(email) = lower(${emailLiteral});

  if target_user_id is null then
    insert into public.users (
      email, full_name, first_name, last_name, language,
      organization_id, organization_ids, email_verified,
      failed_login_attempts, locked_until
    ) values (
      ${emailLiteral}, 'Test Materic', 'Test', 'Materic', 'it',
      target_organization_id, array[target_organization_id]::uuid[], true,
      0, null
    ) returning id into target_user_id;
  else
    update public.users
    set full_name = 'Test Materic',
        first_name = 'Test',
        last_name = 'Materic',
        organization_id = target_organization_id,
        organization_ids = array[target_organization_id]::uuid[],
        email_verified = true,
        failed_login_attempts = 0,
        locked_until = null,
        deleted_at = null,
        anonymized_at = null,
        updated_at = now()
    where id = target_user_id;
  end if;

  update public.organization_members
  set deleted_at = now(),
      updated_at = now()
  where user_id = target_user_id
    and organization_id <> target_organization_id
    and deleted_at is null;

  insert into public.organization_members (
    organization_id, user_id, role, joined_at
  ) values (
    target_organization_id, target_user_id, 'owner', now()
  )
  on conflict (organization_id, user_id) do update
  set role = 'owner',
      deleted_at = null,
      updated_at = now();

  insert into public.credentials (user_id, type, secret_hash, metadata)
  values (target_user_id, 'password', ${hashLiteral}, '{}'::jsonb)
  on conflict (user_id) where type = 'password' do update
  set secret_hash = excluded.secret_hash,
      consumed = false,
      updated_at = now();

  update public.auth_sessions
  set status = 'revoked'
  where user_id = target_user_id
    and status = 'active';
end
$supadrum$;
commit;
`;
}

class NodeLiveProcess implements LiveProcess {
  run(input: LiveProcessInput): Promise<LiveProcessResult> {
    const [program, ...args] = input.argv;
    if (!program) throw new Error("Command argv cannot be empty");
    return new Promise((resolveProcess, reject) => {
      const child = spawn(program, args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        resolveProcess({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      });
      child.stdin.end(input.stdin);
    });
  }
}

interface LiveExecutorOptions {
  readonly process?: LiveProcess;
  readonly fetch?: typeof fetch;
  readonly resolveReference?: (reference: string) => Promise<string>;
  readonly executables?: Partial<LiveExecutables>;
}

interface LiveExecutables {
  readonly git: string;
  readonly supabase: string;
  readonly psql: string;
  readonly prisma: string;
}

export function resolveExecutable(
  name: "git" | "supabase" | "psql" | "prisma",
  environment: NodeJS.ProcessEnv = process.env
): string {
  const override =
    environment[`SUPADRUM_${name.toUpperCase()}_BIN`];
  const candidates = [
    ...(override ? [override] : []),
    ...(environment.PATH?.split(delimiter).map((directory) =>
      join(directory, name)
    ) ?? []),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`
  ];
  for (const candidate of new Set(candidates)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(
    `Executable ${name} not found; set SUPADRUM_${name.toUpperCase()}_BIN`
  );
}

function redact(text: string, values: readonly string[]): string {
  return [...new Set(values)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (output, value) => output.split(value).join("[REDACTED]"),
      text
    );
}

function requiredString(
  payload: Record<string, unknown>,
  name: string
): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Payload ${name} must be a non-empty string`);
  }
  return value;
}

export function databasePassword(databaseAccess: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseAccess);
  } catch {
    throw new Error("database_access must be a PostgreSQL URI");
  }
  if (
    parsed.protocol !== "postgres:" &&
    parsed.protocol !== "postgresql:"
  ) {
    throw new Error("database_access must be a PostgreSQL URI");
  }
  if (!parsed.password) {
    throw new Error("database_access has no password");
  }
  return decodeURIComponent(parsed.password);
}

function databaseParts(databaseAccess: string): {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
} {
  const parsed = new URL(databaseAccess);
  const password = databasePassword(databaseAccess);
  if (!parsed.hostname || !parsed.username) {
    throw new Error("database_access must include host and user");
  }
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    user: decodeURIComponent(parsed.username),
    password
  };
}

export class LiveSupabaseExecutor implements Executor {
  readonly #process: LiveProcess;
  readonly #fetch: typeof fetch;
  readonly #resolveReference:
    | ((reference: string) => Promise<string>)
    | undefined;
  readonly #executables: LiveExecutables;

  constructor(options: LiveExecutorOptions = {}) {
    this.#process = options.process ?? new NodeLiveProcess();
    this.#fetch = options.fetch ?? fetch;
    this.#resolveReference = options.resolveReference;
    this.#executables = {
      git: options.executables?.git ?? "git",
      supabase: options.executables?.supabase ?? "supabase",
      psql: options.executables?.psql ?? "psql",
      prisma: options.executables?.prisma ?? "prisma"
    };
  }

  async mount(): Promise<void> {}

  async drain(): Promise<void> {}

  async unmount(): Promise<void> {}

  async execute(
    job: Job,
    project: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    const repository = project.repo;
    if (!repository) {
      throw new Error(`Project ${job.project} has no repository`);
    }
    const repositoryOid = await this.#verifyRepository(repository, job);

    if (project.target === "local") {
      if (job.operation === "auth.admin") {
        return this.#executeLocalAuthAdmin(
          job,
          repository,
          repositoryOid
        );
      }
      return this.#executeLocalMigration(
        job,
        project,
        repository,
        repositoryOid
      );
    }

    switch (job.operation) {
      case "project.inspect":
        return this.#managementRequest(
          "GET",
          `/v1/projects/${project.project_ref}`,
          undefined,
          credentials
        );
      case "migration.plan":
        return project.migration_driver === "prisma"
          ? this.#runPrisma("plan", repository, credentials)
          : this.#runSupabase(
              ["db", "push", "--dry-run", "--linked"],
              repository,
              credentials
            );
      case "migration.baseline":
        return this.#baselinePrisma(
          job,
          project,
          credentials,
          repositoryOid
        );
      case "migration.apply":
        return project.migration_driver === "prisma"
          ? this.#runPrisma("apply", repository, credentials)
          : this.#runSupabase(
              ["db", "push", "--linked", "--yes"],
              repository,
              credentials
            );
      case "functions.deploy": {
        const name = requiredString(job.payload, "name");
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          throw new Error("Function name contains unsupported characters");
        }
        return this.#runSupabase(
          [
            "functions",
            "deploy",
            name,
            "--project-ref",
            project.project_ref,
            "--use-api"
          ],
          repository,
          credentials
        );
      }
      case "secrets.set":
        return this.#setSecrets(job, project, credentials);
      case "schema.inspect":
        return this.#inspectSchema(
          job,
          project,
          credentials
        );
      case "sql.execute":
        return this.#executeSql(job, project, credentials);
      case "session.open":
        throw new Error("Session opening is handled by the runner");
      default:
        throw new Error(`No live adapter for ${job.operation}`);
    }
  }

  async #verifyRepository(
    repository: string,
    job: Job
  ): Promise<string> {
    if (!/^[0-9a-f]{6,64}$/i.test(job.repo_sha)) {
      throw new Error(
        `Repository SHA for ${job.project} must be a hexadecimal commit OID`
      );
    }
    const result = await this.#process.run({
      argv: [
        this.#executables.git,
        "-C",
        repository,
        "rev-parse",
        `${job.repo_sha}^{commit}`,
        "HEAD"
      ],
      cwd: repository,
      env: { ...process.env }
    });
    const [requestedOid, headOid, ...extra] = result.stdout
      .trim()
      .split(/\r?\n/);
    if (
      result.exitCode !== 0 ||
      !requestedOid ||
      !headOid ||
      extra.length > 0 ||
      requestedOid !== headOid
    ) {
      throw new Error(
        `Repository SHA mismatch for ${job.project}: expected ${requestedOid || job.repo_sha}, got ${headOid || "unavailable"}`
      );
    }
    return requestedOid;
  }

  async #runSupabase(
    args: readonly string[],
    repository: string,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    const password = databasePassword(credentials.database_access);
    return this.#runCommand(
      [this.#executables.supabase, ...args],
      repository,
      {
        ...process.env,
        NO_COLOR: "1",
        SUPABASE_ACCESS_TOKEN: credentials.management_token,
        SUPABASE_DB_PASSWORD: password
      },
      [...Object.values(credentials), password]
    );
  }

  async #executeLocalMigration(
    job: Job,
    project: ProjectConfig,
    repository: string,
    repositoryOid: string
  ): Promise<ExecutionResult> {
    if (project.migration_driver !== "supabase") {
      throw new Error("Local chambers require migration_driver: supabase");
    }
    if (
      job.operation !== "migration.plan" &&
      job.operation !== "migration.apply"
    ) {
      throw new Error(
        `Operation ${job.operation} is not supported for a local chamber`
      );
    }

    const snapRunner = this.#localSnapRunner(job, repository);
    const database = await this.#assertLocalStack(repository);
    const args =
      job.operation === "migration.plan"
        ? ["db", "push", "--dry-run", "--local"]
        : ["db", "reset", "--local", "--no-seed"];
    if (args.includes("--linked") || args.includes("--db-url")) {
      throw new Error("Local chamber command contains a remote target flag");
    }
    let result =
      job.operation === "migration.plan" && snapRunner
        ? await this.#runCommand(
            [snapRunner.executable, "migrate", "--dry-run"],
            snapRunner.workingDirectory,
            this.#localEnvironment({
              NO_COLOR: "1",
              DATABASE_URL: database.url
            }),
            [database.url, database.password]
          )
        : await this.#runCommand(
            [this.#executables.supabase, ...args],
            repository,
            this.#localEnvironment({ NO_COLOR: "1" }),
            []
          );
    if (job.operation === "migration.apply") {
      if (snapRunner) {
        result = await this.#runCommand(
          [snapRunner.executable, "migrate"],
          snapRunner.workingDirectory,
          this.#localEnvironment({
            NO_COLOR: "1",
            DATABASE_URL: database.url
          }),
          [database.url, database.password]
        );
      }
      await this.#assertLocalStack(repository);
    }
    return {
      output: result.output,
      verification: {
        repo_sha_verified: true,
        repository_oid: repositoryOid,
        target: "local",
        local_preflight: true,
        ...(snapRunner ? { migration_runner: "snap" } : {}),
        ...(job.operation === "migration.apply"
          ? { local_postflight: true }
          : {})
      }
    };
  }

  async #executeLocalAuthAdmin(
    job: Job,
    repository: string,
    repositoryOid: string
  ): Promise<ExecutionResult> {
    const request = localSnapAuthAdmin(job.payload);
    const database = await this.#assertLocalStack(repository);
    const result = await this.#process.run({
      argv: [
        this.#executables.psql,
        ...SCHEMA_INSPECTION_PSQL_ARGS
      ],
      cwd: repository,
      env: this.#localEnvironment({
        PGHOST: database.host,
        PGPORT: database.port,
        PGDATABASE: database.database,
        PGUSER: database.user,
        PGPASSWORD: database.password,
        PGSSLMODE: "disable",
        PGOPTIONS:
          "-c statement_timeout=5000 -c lock_timeout=1000"
      }),
      stdin:
        request.action === "inspect-organizations"
          ? localSnapOrganizationInspectionSql()
          : request.action === "reset-password"
            ? localSnapPasswordResetSql(request.email)
            : localSnapTestUserRecreationSql(request.email)
    });
    const stdout = redact(result.stdout, [database.url, database.password]);
    const stderr = redact(result.stderr, [database.url, database.password]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${stderr.trim()}`
      );
    }
    return {
      output: {
        exit_code: result.exitCode,
        stdout,
        stderr
      },
      verification: {
        repo_sha_verified: true,
        repository_oid: repositoryOid,
        target: "local",
        local_preflight: true,
        auth_action: request.action,
        auth_adapter: request.adapter,
        ...("organizationSelector" in request && request.organizationSelector
          ? { organization_selector: request.organizationSelector }
          : {}),
        ...("passwordProfile" in request
          ? { password_profile: request.passwordProfile }
          : {})
      }
    };
  }

  #localSnapRunner(
    job: Job,
    repository: string
  ): {
    readonly executable: string;
    readonly workingDirectory: string;
  } | null {
    const runner = job.payload.migration_runner;
    if (runner === undefined) return null;
    if (runner !== "snap") {
      throw new Error("Local migration_runner must be snap");
    }
    const requested = job.payload.working_directory;
    if (
      typeof requested !== "string" ||
      requested.length === 0 ||
      isAbsolute(requested)
    ) {
      throw new Error(
        "SNAP working_directory must be a relative path inside the repository"
      );
    }
    const workingDirectory = resolve(repository, requested);
    const repositoryRelative = relative(repository, workingDirectory);
    if (
      repositoryRelative === ".." ||
      repositoryRelative.startsWith(`..${sep}`)
    ) {
      throw new Error(
        "SNAP working_directory must be inside the repository"
      );
    }
    const executable = join(
      workingDirectory,
      "node_modules",
      ".bin",
      "snap"
    );
    try {
      accessSync(executable, constants.X_OK);
    } catch {
      throw new Error(
        `SNAP migration runner is not executable: ${executable}`
      );
    }
    return {
      executable,
      workingDirectory
    };
  }

  #localEnvironment(
    additions: NodeJS.ProcessEnv = {}
  ): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ...process.env
    };
    delete environment.SUPABASE_ACCESS_TOKEN;
    delete environment.SUPABASE_DB_PASSWORD;
    delete environment.DATABASE_URL;
    delete environment.DIRECT_DATABASE_URL;
    environment.PATH = [
      dirname(process.execPath),
      environment.PATH
    ].filter(Boolean).join(delimiter);
    return { ...environment, ...additions };
  }

  async #assertLocalStack(
    repository: string
  ): Promise<ReturnType<typeof databaseParts> & { readonly url: string }> {
    const status = await this.#process.run({
      argv: [
        this.#executables.supabase,
        "status",
        "--output",
        "json"
      ],
      cwd: repository,
      env: this.#localEnvironment({ NO_COLOR: "1" })
    });
    if (status.exitCode !== 0) {
      throw new Error(
        `Local Supabase stack is unavailable: ${status.stderr.trim()}`
      );
    }

    let values: string[];
    try {
      const parsed: unknown = JSON.parse(status.stdout);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("status is not an object");
      }
      values = Object.values(parsed)
        .filter((value): value is string => typeof value === "string");
    } catch {
      throw new Error("Local Supabase status returned invalid JSON");
    }
    const databaseUrl = values.find((value) =>
      /^postgres(?:ql)?:\/\//.test(value)
    );
    if (!databaseUrl) {
      throw new Error("Local Supabase status has no database URL");
    }
    const database = databaseParts(databaseUrl);
    const hostname = database.host;
    if (
      hostname !== "localhost" &&
      hostname !== "::1" &&
      !hostname.startsWith("127.")
    ) {
      throw new Error(
        `Local Supabase database must use a loopback host, got ${hostname}`
      );
    }
    return { ...database, url: databaseUrl };
  }

  async #runPrisma(
    operation: "plan" | "apply",
    repository: string,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    const password = databasePassword(credentials.database_access);
    const executable = this.#prismaExecutable(repository);
    const argv = [
      executable,
      "migrate",
      operation === "plan" ? "status" : "deploy"
    ];
    const env = this.#prismaEnvironment(credentials);
    const secrets = [...Object.values(credentials), password];
    if (operation === "apply") {
      return this.#runCommand(argv, repository, env, secrets);
    }
    const result = await this.#process.run({
      argv,
      cwd: repository,
      env
    });
    const stdout = redact(result.stdout, secrets);
    const stderr = redact(result.stderr, secrets);
    const pendingMigrations =
      result.exitCode === 1 &&
      stderr.trim() === "" &&
      /not yet been applied/i.test(stdout);
    if (result.exitCode !== 0 && !pendingMigrations) {
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${stderr.trim()}`
      );
    }
    return {
      output: {
        exit_code: result.exitCode,
        stdout,
        stderr
      },
      verification: {
        exit_code: result.exitCode,
        repo_sha_verified: true,
        pending_migrations: pendingMigrations
      }
    };
  }

  #prismaExecutable(repository: string): string {
    const localExecutable = join(
      repository,
      "node_modules",
      ".bin",
      "prisma"
    );
    try {
      accessSync(localExecutable, constants.X_OK);
      return localExecutable;
    } catch {
      return this.#executables.prisma;
    }
  }

  #prismaEnvironment(
    credentials: ResolvedCredentials
  ): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NO_COLOR: "1",
      PATH: [
        dirname(process.execPath),
        process.env.PATH
      ].filter(Boolean).join(delimiter),
      DATABASE_URL: credentials.database_access,
      DIRECT_DATABASE_URL: credentials.database_access
    };
  }

  async #loadBaselineMigrations(
    repository: string,
    repositoryOid: string,
    requested: readonly string[]
  ): Promise<LocalPrismaMigration[]> {
    const tree = await this.#process.run({
      argv: [
        this.#executables.git,
        "-C",
        repository,
        "ls-tree",
        "-r",
        "--name-only",
        repositoryOid,
        "--",
        "prisma/migrations"
      ],
      cwd: repository,
      env: { ...process.env }
    });
    if (tree.exitCode !== 0) {
      throw new Error("Could not read Prisma migrations at repository OID");
    }
    const repositoryMigrations = tree.stdout
      .split(/\r?\n/)
      .flatMap((path) => {
        const match = path.match(
          /^prisma\/migrations\/([^/]+)\/migration\.sql$/
        );
        return match?.[1] ? [match[1]] : [];
      })
      .sort();
    validateMigrationPrefix(requested, repositoryMigrations);

    const migrationDirectories = requested.map(
      (name) => `prisma/migrations/${name}`
    );
    const status = await this.#process.run({
      argv: [
        this.#executables.git,
        "-C",
        repository,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ...migrationDirectories
      ],
      cwd: repository,
      env: { ...process.env }
    });
    if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
      throw new Error(
        "Requested Prisma migrations are not clean at the repository OID"
      );
    }

    const migrations: LocalPrismaMigration[] = [];
    for (const name of requested) {
      const path = `prisma/migrations/${name}/migration.sql`;
      const blob = await this.#process.run({
        argv: [
          this.#executables.git,
          "-C",
          repository,
          "show",
          `${repositoryOid}:${path}`
        ],
        cwd: repository,
        env: { ...process.env }
      });
      if (blob.exitCode !== 0) {
        throw new Error(
          `Could not read tracked migration ${name} at repository OID`
        );
      }
      const committed = Buffer.from(blob.stdout, "utf8");
      const worktree = readFileSync(join(repository, path));
      if (!committed.equals(worktree)) {
        throw new Error(
          `Migration ${name} does not match the repository OID`
        );
      }
      migrations.push({
        name,
        checksum: createHash("sha256")
          .update(committed)
          .digest("hex")
      });
    }
    return migrations;
  }

  async #readPrismaHistory(
    repository: string,
    credentials: ResolvedCredentials
  ): Promise<PrismaMigrationHistoryRow[]> {
    const database = databaseParts(credentials.database_access);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PGHOST: database.host,
      PGPORT: database.port,
      PGDATABASE: database.database,
      PGUSER: database.user,
      PGPASSWORD: database.password,
      PGSSLMODE: "require",
      PGOPTIONS:
        "-c default_transaction_read_only=on " +
        "-c statement_timeout=5000 " +
        "-c lock_timeout=1000"
    };
    const secrets = [
      ...Object.values(credentials),
      database.password
    ];
    const run = async (sql: string): Promise<string> => {
      const result = await this.#process.run({
        argv: [
          this.#executables.psql,
          ...SCHEMA_INSPECTION_PSQL_ARGS
        ],
        cwd: repository,
        env: environment,
        stdin: sql
      });
      const stdout = redact(result.stdout, secrets);
      const stderr = redact(result.stderr, secrets);
      if (result.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${result.exitCode}: ${stderr.trim()}`
        );
      }
      return stdout;
    };
    const available = parsePrismaHistoryAvailability(
      await run(PRISMA_HISTORY_AVAILABILITY_SQL)
    );
    if (!available) return [];
    return parsePrismaHistoryRows(
      await run(PRISMA_BASELINE_HISTORY_SQL)
    );
  }

  async #baselinePrisma(
    job: Job,
    project: ProjectConfig,
    credentials: ResolvedCredentials,
    repositoryOid: string
  ): Promise<ExecutionResult> {
    if (project.migration_driver !== "prisma") {
      throw new Error(
        "migration.baseline requires migration_driver: prisma"
      );
    }
    const repository = project.repo as string;
    const payload = parseMigrationBaselinePayload(job.payload);
    const migrations = await this.#loadBaselineMigrations(
      repository,
      repositoryOid,
      payload.migrations
    );
    const initialHistory = await this.#readPrismaHistory(
      repository,
      credentials
    );
    const initialPlan = analyzeMigrationHistory(
      migrations,
      initialHistory
    );
    const resolved: string[] = [];
    const executable = this.#prismaExecutable(repository);
    const environment = this.#prismaEnvironment(credentials);
    const secrets = [
      ...Object.values(credentials),
      databasePassword(credentials.database_access)
    ];

    for (const name of initialPlan.missing) {
      const result = await this.#process.run({
        argv: [
          executable,
          "migrate",
          "resolve",
          "--applied",
          name
        ],
        cwd: repository,
        env: environment
      });
      const stderr = redact(result.stderr, secrets);
      if (result.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${result.exitCode}: ${stderr.trim()}`
        );
      }
      resolved.push(name);
      const verified = analyzeMigrationHistory(
        migrations,
        await this.#readPrismaHistory(repository, credentials)
      );
      const expectedLength =
        initialPlan.alreadyApplied.length + resolved.length;
      if (verified.alreadyApplied.length !== expectedLength) {
        throw new Error(
          `Prisma history did not verify resolved migration ${name}`
        );
      }
    }

    return {
      output: {
        requested: payload.migrations,
        already_applied: initialPlan.alreadyApplied,
        resolved,
        verified_prefix_length: migrations.length
      },
      verification: {
        repo_sha_verified: true,
        repository_oid: repositoryOid,
        migration_driver: "prisma",
        tracked_migrations: migrations.length,
        history_verified: true
      }
    };
  }

  async #executeSql(
    job: Job,
    project: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    const repository = project.repo as string;
    const requestedPath = requiredString(job.payload, "path");
    const digest = requiredString(job.payload, "digest");
    const absolutePath = resolve(repository, requestedPath);
    const relativePath = relative(resolve(repository), absolutePath);
    if (
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new Error(
        "SQL file must be inside the project repository"
      );
    }
    const source = readFileSync(absolutePath);
    const actualDigest = createHash("sha256")
      .update(source)
      .digest("hex");
    if (actualDigest !== digest) {
      throw new Error(
        `SQL file digest mismatch: expected ${digest}, got ${actualDigest}`
      );
    }
    const database = databaseParts(credentials.database_access);
    return this.#runCommand(
      [
        this.#executables.psql,
        "--set",
        "ON_ERROR_STOP=1",
        "--file",
        absolutePath
      ],
      repository,
      {
        ...process.env,
        PGHOST: database.host,
        PGPORT: database.port,
        PGDATABASE: database.database,
        PGUSER: database.user,
        PGPASSWORD: database.password,
        PGSSLMODE: "require"
      },
      [...Object.values(credentials), database.password]
    );
  }

  async #inspectSchema(
    job: Job,
    project: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    const payload = parseSchemaInspectionPayload(job.payload);
    const database = databaseParts(credentials.database_access);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PGHOST: database.host,
      PGPORT: database.port,
      PGDATABASE: database.database,
      PGUSER: database.user,
      PGPASSWORD: database.password,
      PGSSLMODE: "require",
      PGOPTIONS:
        "-c default_transaction_read_only=on " +
        "-c statement_timeout=5000 " +
        "-c lock_timeout=1000"
    };
    const secretValues = [
      ...Object.values(credentials),
      database.password
    ];
    const catalog = parseCatalogInspection(
      await this.#runSchemaQuery(
        "catalog",
        payload,
        project.repo as string,
        environment,
        secretValues,
        project.migration_driver
      )
    );
    const hasMigrationChecks = payload.checks.some(
      (check) => check.kind === "migration"
    );
    const migrations =
      hasMigrationChecks && catalog.migration_history_available
        ? parseMigrationInspection(
            await this.#runSchemaQuery(
              "migration",
              payload,
              project.repo as string,
              environment,
              secretValues,
              project.migration_driver
            )
          )
        : null;
    const result = assembleSchemaInspection(
      payload,
      catalog,
      migrations
    );
    return {
      output: result,
      verification: {
        repo_sha_verified: true,
        read_only: true,
        requested_checks: payload.checks.length
      }
    };
  }

  async #runSchemaQuery(
    phase: "catalog" | "migration",
    payload: ReturnType<typeof parseSchemaInspectionPayload>,
    repository: string,
    env: NodeJS.ProcessEnv,
    secrets: readonly string[],
    migrationDriver: ProjectConfig["migration_driver"]
  ): Promise<string> {
    const result = await this.#process.run({
      argv: [
        this.#executables.psql,
        ...SCHEMA_INSPECTION_PSQL_ARGS
      ],
      cwd: repository,
      env,
      stdin: schemaInspectionPsqlInput(
        payload,
        phase === "catalog"
          ? migrationDriver === "prisma"
            ? PRISMA_CATALOG_INSPECTION_SQL
            : CATALOG_INSPECTION_SQL
          : migrationDriver === "prisma"
            ? PRISMA_MIGRATION_INSPECTION_SQL
            : MIGRATION_INSPECTION_SQL
      )
    });
    const stdout = redact(result.stdout, secrets);
    const stderr = redact(result.stderr, secrets);
    if (result.exitCode !== 0) {
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${stderr.trim()}`
      );
    }
    return stdout;
  }

  async #setSecrets(
    job: Job,
    project: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    const names = job.payload.names;
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.some((name) => typeof name !== "string")
    ) {
      throw new Error("Payload names must be a non-empty string array");
    }
    if (!this.#resolveReference) {
      throw new Error("Live secret updates require a vault resolver");
    }
    const secrets: Array<{ name: string; value: string }> = [];
    for (const name of new Set(names as string[])) {
      const reference = project.managed_secrets?.[name];
      if (!reference) {
        throw new Error(
          `No operator-managed vault reference for secret ${name}`
        );
      }
      secrets.push({
        name,
        value: await this.#resolveReference(reference)
      });
    }
    return this.#managementRequest(
      "POST",
      `/v1/projects/${project.project_ref}/secrets`,
      secrets,
      credentials,
      secrets.map((secret) => secret.value)
    );
  }

  async #managementRequest(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    credentials: ResolvedCredentials,
    extraSecrets: readonly string[] = []
  ): Promise<ExecutionResult> {
    const response = await this.#fetch(`https://api.supabase.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.management_token}`,
        "Content-Type": "application/json"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const source = await response.text();
    const values = [...Object.values(credentials), ...extraSecrets];
    const output = redact(source, values);
    if (!response.ok) {
      throw new Error(
        `Supabase Management API failed with ${response.status}: ${output}`
      );
    }
    let parsed: unknown = output;
    try {
      parsed = JSON.parse(output);
    } catch {}
    return {
      output: parsed,
      verification: {
        status: response.status,
        ok: true
      }
    };
  }

  async #runCommand(
    argv: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    secrets: readonly string[]
  ): Promise<ExecutionResult> {
    const result = await this.#process.run({ argv, cwd, env });
    const stdout = redact(result.stdout, secrets);
    const stderr = redact(result.stderr, secrets);
    if (result.exitCode !== 0) {
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${stderr.trim()}`
      );
    }
    return {
      output: {
        exit_code: result.exitCode,
        stdout,
        stderr
      },
      verification: {
        exit_code: result.exitCode,
        repo_sha_verified: true
      }
    };
  }
}

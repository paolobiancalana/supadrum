import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync
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
import { MacOsKeychainBackend } from "./vault-cli.js";
import type { VaultBackend } from "./vault.js";
import { passwordAccountRequest, placeholderReconciliationSql, registeredPasswordAccount, upsertLocalPasswordAccount, validateLocalPasswordStatus } from "./local-password-auth.js";
import {
  AdapterTestFailure,
  ATLAS_WRITER_LOGIN,
  parseLocalAdapterStatus,
  postgresScramVerifier,
  registeredAdapterTest,
  syntheticJwt,
  writerProvisionSql
} from "./local-adapter-tests.js";
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
import { parseTypesGeneratePayload } from "./types-generate.js";
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
  readonly passwordVault?: VaultBackend;
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

/**
 * A migration name reaches the CLI as a filename, so it is validated instead of
 * trusted: anything outside this alphabet could climb out of the migrations
 * directory or be read as a flag. Same alphabet the CLI itself generates.
 */
function migrationFileName(payload: Record<string, unknown>): string {
  const name = requiredString(payload, "name");
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(
      "Migration name must use only lowercase letters, digits and underscores"
    );
  }
  return name;
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
  readonly #passwordVault: VaultBackend | undefined;

  constructor(options: LiveExecutorOptions = {}) {
    this.#process = options.process ?? new NodeLiveProcess();
    this.#fetch = options.fetch ?? fetch;
    this.#resolveReference = options.resolveReference;
    this.#passwordVault = options.passwordVault;
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
    if (job.operation === "tests.run") {
      if (project.target !== "local") {
        throw new Error("tests.run is available only on a local chamber");
      }
      const script = job.payload.script;
      if (!registeredAdapterTest(project, script)) {
        throw new Error(`Adapter test script is not registered: ${String(script)}`);
      }
      if (project.mode !== "live") {
        throw new Error("tests.run requires a live local chamber");
      }
    }
    const repository = project.repo;
    if (!repository) {
      throw new Error(`Project ${job.project} has no repository`);
    }
    const repositoryOid = await this.#verifyRepository(repository, job);

    if (project.target === "local") {
      if (job.operation === "auth.admin") {
        return this.#executeLocalAuthAdmin(
          job,
          project,
          repository,
          repositoryOid,
          project.supabase_dir
        );
      }
      if (job.operation === "sql.execute") {
        return this.#executeLocalSql(
          job,
          repository,
          repositoryOid,
          project.supabase_dir
        );
      }
      if (job.operation === "tests.run") {
        return this.#executeLocalAdapterTests(job, project, repository, repositoryOid);
      }
      if (job.operation === "types.generate") {
        return this.#generateTypes(job, project, repository, repositoryOid, null);
      }
      return this.#executeLocalMigration(
        job,
        project,
        repository,
        repositoryOid
      );
    }

    const databaseCredentials =
      job.operation === "schema.inspect" ||
      job.operation === "sql.execute" ||
      (project.migration_driver === "prisma" &&
        (job.operation === "migration.plan" ||
          job.operation === "migration.baseline" ||
          job.operation === "migration.apply"))
        ? await this.#routeDirectDatabase(project, credentials)
        : credentials;

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
          ? this.#runPrisma("plan", repository, databaseCredentials)
          : this.#pushMigrations(
              ["db", "push", "--dry-run", "--linked"],
              project,
              repository,
              credentials
            );
      // A diff reads the declarative schema through the shadow database, and the
      // migration it writes exists to be reviewed before anything reaches a
      // remote project. Diffing a linked project directly inverts that order.
      case "migration.diff":
        throw new Error(
          "migration.diff runs only on a local chamber: generate the migration there, review it, then apply it"
        );
      case "types.generate":
        return this.#generateTypes(
          job,
          project,
          repository,
          repositoryOid,
          credentials
        );
      case "migration.baseline":
        return this.#baselinePrisma(
          job,
          project,
          databaseCredentials,
          repositoryOid
        );
      case "migration.apply":
        return project.migration_driver === "prisma"
          ? this.#runPrisma("apply", repository, databaseCredentials)
          : this.#pushMigrations(
              ["db", "push", "--linked", "--yes"],
              project,
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
          databaseCredentials
        );
      case "sql.execute":
        return this.#executeSql(job, project, databaseCredentials);
      case "session.open":
        throw new Error("Session opening is handled by the runner");
      default:
        throw new Error(`No live adapter for ${job.operation}`);
    }
  }

  async #routeDirectDatabase(
    project: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ResolvedCredentials> {
    const database = new URL(credentials.database_access);
    if (
      database.hostname !==
      `db.${project.project_ref}.supabase.co`
    ) {
      return credentials;
    }
    const inspected = await this.#managementRequest(
      "GET",
      `/v1/projects/${project.project_ref}`,
      undefined,
      credentials
    );
    const output = inspected.output;
    if (
      output === null ||
      typeof output !== "object" ||
      Array.isArray(output) ||
      !("region" in output) ||
      typeof output.region !== "string" ||
      !/^[a-z0-9-]+$/.test(output.region)
    ) {
      throw new Error("Project inspection returned no valid region");
    }
    database.hostname = `aws-0-${output.region}.pooler.supabase.com`;
    database.port = "5432";
    database.username = `postgres.${project.project_ref}`;
    return {
      ...credentials,
      database_access: database.toString()
    };
  }

  /**
   * Pushes repository migrations after refreshing the CLI's own link.
   *
   * `db push --linked` does not take a connection string: it reads one from
   * the CLI's `.temp` state inside the repository, written once by whoever
   * linked last. A link made on a machine that had IPv6 pins the DIRECT host,
   * `db.<ref>.supabase.co`, which publishes an AAAA record and nothing else.
   * From a network without IPv6 every push then dies with
   * `LegacyDbConfigIpv6Error` before it opens a connection — and the same
   * repository, on the same commit, works from one network and not from
   * another. The stored state is the bug; nothing in the job says which host
   * to use.
   *
   * Relinking first is the CLI's own remedy, and its default target is the
   * session pooler, which answers on IPv4. That is the same session pooler
   * `#routeDirectDatabase` already sends schema.inspect and sql.execute to:
   * the migration driver was the one leg left on the direct host.
   *
   * `--project-ref` is a public identifier and the connection never becomes a
   * `--db-url` argument: the password stays in the environment, where `ps`
   * cannot read it off the command line.
   */
  async #pushMigrations(
    args: readonly string[],
    project: ProjectConfig,
    repository: string,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    await this.#runSupabase(
      ["link", "--project-ref", project.project_ref],
      repository,
      credentials
    );
    return this.#runSupabase(args, repository, credentials);
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

  async #verifyCleanRepository(repository: string): Promise<void> {
    const status = await this.#process.run({
      argv: [this.#executables.git, "-C", repository, "status", "--porcelain=v1", "--untracked-files=all"],
      cwd: repository,
      env: { PATH: process.env.PATH }
    });
    if (status.exitCode !== 0 || status.stdout.trim() || status.stderr.trim()) {
      throw new Error("Adapter tests require a clean checkout");
    }
  }

  async #executeLocalAdapterTests(
    job: Job,
    project: ProjectConfig,
    repository: string,
    repositoryOid: string
  ): Promise<ExecutionResult> {
    const scriptName = job.payload.script as string;
    const registration = registeredAdapterTest(project, scriptName);
    if (!registration) throw new Error("Adapter test script is not registered");
    await this.#verifyCleanRepository(repository);
    const database = await this.#assertLocalStack(repository, project.supabase_dir);
    if (registration.setup_sql_path) {
      const fixture = this.#repositoryPath(repository, registration.setup_sql_path, "Adapter fixture");
      const committed = await this.#process.run({
        argv: [this.#executables.git, "-C", repository, "show",
          `${repositoryOid}:${registration.setup_sql_path}`],
        cwd: repository,
        env: { PATH: process.env.PATH }
      });
      const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
      if (committed.exitCode !== 0 || digest(readFileSync(fixture)) !== digest(committed.stdout)) {
        throw new Error("Adapter fixture does not match the pinned commit");
      }
      const fixtureRun = await this.#process.run({
        argv: [this.#executables.psql, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1", "--file", fixture],
        cwd: repository,
        env: { PATH: process.env.PATH, PGHOST: database.host, PGPORT: database.port,
          PGDATABASE: database.database, PGUSER: database.user,
          PGPASSWORD: database.password, PGSSLMODE: "disable" }
      });
      if (fixtureRun.exitCode !== 0) {
        throw new Error(`Adapter fixture setup failed with exit code ${fixtureRun.exitCode}`);
      }
    }
    const { apiUrl, anonKey, jwtSecret } = parseLocalAdapterStatus(database.status);
    const password = randomBytes(32).toString("base64url");
    const verifier = postgresScramVerifier(password);
    const passwordVault = this.#passwordVault ?? new MacOsKeychainBackend();
    try {
      await passwordVault.put(registration.writer_password_ref, password);
      if (await passwordVault.get(registration.writer_password_ref) !== password) {
        throw new Error("round-trip mismatch");
      }
    } catch {
      throw new Error("Writer password vault is unavailable");
    }
    const setup = await this.#process.run({
      argv: [this.#executables.psql, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1"],
      cwd: repository,
      env: {
        PATH: process.env.PATH,
        PGHOST: database.host,
        PGPORT: database.port,
        PGDATABASE: database.database,
        PGUSER: database.user,
        PGPASSWORD: database.password,
        PGSSLMODE: "disable"
      },
      stdin: writerProvisionSql(verifier)
    });
    if (setup.exitCode !== 0) {
      throw new Error(`Writer login provisioning failed with exit code ${setup.exitCode}`);
    }
    await this.#verifyRepository(repository, job);
    await this.#verifyCleanRepository(repository);

    const writerUrl = new URL(database.url);
    writerUrl.search = "";
    writerUrl.hash = "";
    writerUrl.username = ATLAS_WRITER_LOGIN;
    writerUrl.password = password;
    const jwtEnvironment: NodeJS.ProcessEnv = {};
    const jwtValues: string[] = [];
    for (const [persona, sub] of Object.entries(registration.personas)) {
      const jwt = syntheticJwt(jwtSecret, sub);
      jwtEnvironment[`ATLAS_${persona.toUpperCase()}_JWT`] = jwt;
      jwtValues.push(jwt);
    }
    const authEnvironment: NodeJS.ProcessEnv = {};
    const authPasswords: string[] = [];
    for (const name of registration.password_accounts ?? []) {
      const account = registeredPasswordAccount(project, name);
      if (!account) throw new Error("Adapter test password account is not registered");
      let accountPassword: string;
      try { accountPassword = await passwordVault.get(account.password_ref); }
      catch { throw new Error("Adapter test password vault is unavailable"); }
      if (accountPassword.length < 12) throw new Error("Adapter test password vault is unavailable");
      const prefix = `SUPADRUM_AUTH_${name.toUpperCase()}`;
      authEnvironment[`${prefix}_EMAIL`] = account.email;
      authEnvironment[`${prefix}_PASSWORD`] = accountPassword;
      authPasswords.push(accountPassword);
    }
    const result = await this.#process.run({
      argv: ["npm", "run", registration.npm_script],
      cwd: repository,
      env: {
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ATLAS_WRITER_DATABASE_URL: writerUrl.toString(),
        ATLAS_DATA_API_URL: apiUrl,
        ATLAS_ANON_KEY: anonKey,
        ...jwtEnvironment,
        ...authEnvironment
      }
    });
    const secrets = [database.url, database.password, password, verifier, writerUrl.toString(),
      anonKey, jwtSecret, ...jwtValues, ...authPasswords];
    const passwordBearing = authPasswords.length > 0;
    const output = {
      exit_code: result.exitCode,
      stdout: passwordBearing ? "[SUPPRESSED: password-bearing test]" : redact(result.stdout, secrets),
      stderr: passwordBearing ? "[SUPPRESSED: password-bearing test]" : redact(result.stderr, secrets)
    };
    const execution: ExecutionResult = {
      output,
      verification: {
        repo_sha_verified: true,
        repository_oid: repositoryOid,
        clean_checkout: true,
        target: "local",
        local_preflight: true,
        script: scriptName,
        exit_code: result.exitCode
      }
    };
    if (result.exitCode !== 0) throw new AdapterTestFailure(execution);
    return execution;
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
      job.operation !== "migration.apply" &&
      job.operation !== "migration.diff"
    ) {
      throw new Error(
        `Operation ${job.operation} is not supported for a local chamber`
      );
    }

    const snapRunner = this.#localSnapRunner(job, repository);
    if (snapRunner && job.operation === "migration.diff") {
      throw new Error(
        "SNAP has no diff: migration.diff needs the supabase CLI to read the declarative schema"
      );
    }
    const database = await this.#assertLocalStack(
      repository,
      project.supabase_dir
    );
    // `db schema declarative sync` is the one command that reads the
    // declarative schema tree; `db diff` explicitly no longer does — it
    // compares the migrations baseline with the database, and the CLI warns as
    // much. `--no-apply` is not optional here: without it the command prompts,
    // which in a runner means hanging until the lease expires, and `--apply`
    // would make an operation named "diff" write to the database.
    // `--strict-coverage` because the default leaves objects pg-delta cannot
    // manage silently unmanaged, and an unmanaged object is precisely where a
    // migration drifts from the schema without anyone being told. A diff that
    // omits what it does not understand is worse than one that refuses.
    const args =
      job.operation === "migration.diff"
        ? [
            "db",
            "schema",
            "declarative",
            "sync",
            "--no-apply",
            "--strict-coverage",
            "--name",
            migrationFileName(job.payload)
          ]
        : job.operation === "migration.plan"
          ? ["db", "push", "--dry-run", "--local"]
          : ["db", "push", "--local"];
    if (args.includes("--linked") || args.includes("--db-url")) {
      throw new Error("Local chamber command contains a remote target flag");
    }
    // `migration.apply` used to fall back to `db reset --no-seed`, which drops
    // the schema instead of applying anything. On a repository whose CLI
    // migrations are disabled (the schema is applied by another runner) that
    // reset rebuilt an EMPTY database and destroyed a shared local chamber.
    // Apply advances a database; it never rebuilds one.
    if (args.includes("reset")) {
      throw new Error("Local chamber command must not reset the database");
    }
    const result = snapRunner
      ? await this.#runCommand(
          [
            snapRunner.executable,
            "migrate",
            ...(job.operation === "migration.plan" ? ["--dry-run"] : [])
          ],
          snapRunner.workingDirectory,
          this.#localEnvironment({
            NO_COLOR: "1",
            DATABASE_URL: database.url
          }),
          [database.url, database.password]
        )
      : await this.#runCommand(
          [this.#executables.supabase, ...args],
          project.supabase_dir ?? repository,
          this.#localEnvironment({ NO_COLOR: "1" }),
          []
        );
    if (job.operation === "migration.apply") {
      await this.#assertLocalStack(repository, project.supabase_dir);
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

  /**
   * Runs a repository SQL file against the local Supabase stack.
   *
   * The local stack has no stored credential — the connection comes from the
   * running containers — so there is nothing to resolve and nothing to redact
   * beyond the ephemeral local password. Same file contract as the remote
   * executor (inside the repo, digest verified): the difference is only where
   * it runs.
   */
  async #executeLocalSql(
    job: Job,
    repository: string,
    repositoryOid: string,
    supabaseDir: string | undefined
  ): Promise<ExecutionResult> {
    const absolutePath = this.#resolveSqlFile(job, repository);
    const database = await this.#assertLocalStack(repository, supabaseDir);
    const result = await this.#process.run({
      argv: [
        this.#executables.psql,
        "--set",
        "ON_ERROR_STOP=1",
        "--file",
        absolutePath
      ],
      cwd: repository,
      env: this.#localEnvironment({
        PGHOST: database.host,
        PGPORT: database.port,
        PGDATABASE: database.database,
        PGUSER: database.user,
        PGPASSWORD: database.password,
        PGSSLMODE: "disable"
      })
    });
    const stdout = redact(result.stdout, [database.url, database.password]);
    const stderr = redact(result.stderr, [database.url, database.password]);
    if (result.exitCode !== 0) {
      // BOTH streams, not whichever one spoke first. The Supabase CLI splits
      // a single failure across the two: the progress chatter goes to stderr
      // ("Connecting to remote database... Applying migration X...") and the
      // reason the thing died goes to stdout. Preferring stderr therefore
      // returns a message that reads like a success cut short, and drops the
      // only line anyone needed.
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${detail}`
      );
    }
    return {
      output: { exit_code: result.exitCode, stdout, stderr },
      verification: {
        repo_sha_verified: true,
        repository_oid: repositoryOid,
        target: "local",
        local_preflight: true
      }
    };
  }

  async #executeLocalAuthAdmin(
    job: Job,
    project: ProjectConfig,
    repository: string,
    repositoryOid: string,
    supabaseDir: string | undefined
  ): Promise<ExecutionResult> {
    if (job.payload.adapter === "supabase-password") {
      if (job.capability !== "auth-admin" || !project.capabilities.includes("auth-admin")) {
        throw new Error("Project lacks auth-admin capability");
      }
      const { name, account } = passwordAccountRequest(project, job.payload);
      const database = await this.#assertLocalStack(repository, supabaseDir);
      validateLocalPasswordStatus(database.status);
      const reconciled = await this.#process.run({
        argv: [this.#executables.psql, ...SCHEMA_INSPECTION_PSQL_ARGS],
        cwd: repository,
        env: {
          PATH: process.env.PATH,
          PGHOST: database.host, PGPORT: database.port,
          PGDATABASE: database.database, PGUSER: database.user,
          PGPASSWORD: database.password, PGSSLMODE: "disable",
          PGOPTIONS: "-c statement_timeout=5000 -c lock_timeout=1000"
        },
        stdin: placeholderReconciliationSql(account)
      });
      if (reconciled.exitCode !== 0) {
        throw new Error(`Local Auth placeholder reconciliation failed with exit code ${reconciled.exitCode}`);
      }
      const passwordVault = this.#passwordVault ?? new MacOsKeychainBackend();
      let password: string;
      try { password = await passwordVault.get(account.password_ref); }
      catch { throw new Error("Local Auth password vault is unavailable"); }
      await upsertLocalPasswordAccount(account, password, database.status, this.#fetch);
      return {
        output: { account: name, user_id: account.user_id },
        verification: {
          repo_sha_verified: true, repository_oid: repositoryOid, target: "local",
          local_preflight: true, auth_adapter: "supabase-password",
          auth_action: "upsert", email_identity_verified: true,
          login_verified: true, user_id: account.user_id
        }
      };
    }
    const request = localSnapAuthAdmin(job.payload);
    const database = await this.#assertLocalStack(repository, supabaseDir);
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
      // BOTH streams, not whichever one spoke first. The Supabase CLI splits
      // a single failure across the two: the progress chatter goes to stderr
      // ("Connecting to remote database... Applying migration X...") and the
      // reason the thing died goes to stdout. Preferring stderr therefore
      // returns a message that reads like a success cut short, and drops the
      // only line anyone needed.
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${detail}`
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
    repository: string,
    supabaseDir?: string
  ): Promise<ReturnType<typeof databaseParts> & { readonly url: string; readonly status: Record<string, unknown> }> {
    const status = await this.#process.run({
      argv: [
        this.#executables.supabase,
        "status",
        "--output",
        "json"
      ],
      cwd: supabaseDir ?? repository,
      env: this.#localEnvironment({ NO_COLOR: "1" })
    });
    if (status.exitCode !== 0) {
      throw new Error(
        `Local Supabase stack is unavailable (exit code ${status.exitCode})`
      );
    }

    let values: string[];
    let statusValues: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(status.stdout);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("status is not an object");
      }
      statusValues = parsed as Record<string, unknown>;
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
      hostname !== "[::1]" &&
      !(isIP(hostname) === 4 && hostname.split(".")[0] === "127")
    ) {
      throw new Error(
        "Local Supabase database must use a loopback host"
      );
    }
    return { ...database, url: databaseUrl, status: statusValues };
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

  /**
   * Resolves the SQL file a job points at, refusing anything outside the
   * repository or whose content does not match the announced digest. Shared by
   * the remote and local executors so both enforce the same contract: what runs
   * is exactly what the caller hashed, and it lives in the repo.
   */
  #resolveSqlFile(job: Job, repository: string): string {
    const requestedPath = requiredString(job.payload, "path");
    const digest = requiredString(job.payload, "digest");
    const absolutePath = this.#repositoryPath(repository, requestedPath, "SQL file");
    const source = readFileSync(absolutePath);
    const actualDigest = createHash("sha256")
      .update(source)
      .digest("hex");
    if (actualDigest !== digest) {
      throw new Error(
        `SQL file digest mismatch: expected ${digest}, got ${actualDigest}`
      );
    }
    return absolutePath;
  }

  /** Resolves a path a job points at, refusing anything outside the repository. */
  #repositoryPath(repository: string, requested: string, what: string): string {
    const absolutePath = resolve(repository, requested);
    const relativePath = relative(resolve(repository), absolutePath);
    if (
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new Error(`${what} must be inside the project repository`);
    }
    return absolutePath;
  }

  /**
   * Generates the TypeScript types of one schema with the Supabase CLI and
   * writes them to a file inside the repository. Remote chambers read the
   * linked project through the management token; local chambers read the
   * running stack after the usual loopback preflight. The generated text never
   * travels in the job result — it can run to hundreds of kilobytes — only its
   * digest and size do, so the caller can verify what landed on disk.
   */
  async #generateTypes(
    job: Job,
    project: ProjectConfig,
    repository: string,
    repositoryOid: string,
    credentials: ResolvedCredentials | null
  ): Promise<ExecutionResult> {
    const { output, schema } = parseTypesGeneratePayload(job.payload);
    const absolutePath = this.#repositoryPath(
      repository,
      output,
      "Types output file"
    );
    if (credentials && !project.project_ref) {
      throw new Error(`Project ${job.project} has no project_ref`);
    }
    if (!credentials) {
      await this.#assertLocalStack(repository, project.supabase_dir);
    }
    const argv = [
      this.#executables.supabase,
      "gen",
      "types",
      "typescript",
      "--schema",
      schema,
      ...(credentials
        ? ["--project-id", project.project_ref as string]
        : ["--local"])
    ];
    const secrets = credentials ? Object.values(credentials) : [];
    const result = await this.#process.run({
      argv,
      cwd: credentials ? repository : project.supabase_dir ?? repository,
      env: credentials
        ? {
            ...process.env,
            NO_COLOR: "1",
            SUPABASE_ACCESS_TOKEN: credentials.management_token
          }
        : this.#localEnvironment({ NO_COLOR: "1" })
    });
    const stderr = redact(result.stderr, secrets);
    if (result.exitCode !== 0) {
      // stderr only here: this command's stdout is the generated type file,
      // not a message, and putting it in an exception explains nothing.
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${stderr.trim()}`
      );
    }
    const generated = redact(result.stdout, secrets);
    if (!generated.trim()) {
      throw new Error("Type generation produced no output");
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, generated);
    return {
      output: { exit_code: 0, stdout: "", stderr },
      verification: {
        repo_sha_verified: true,
        repository_oid: repositoryOid,
        output: relative(resolve(repository), absolutePath),
        digest: createHash("sha256").update(generated).digest("hex"),
        bytes: Buffer.byteLength(generated),
        ...(credentials ? {} : { target: "local", local_preflight: true })
      }
    };
  }

  async #executeSql(
    job: Job,
    project: ProjectConfig,
    credentials: ResolvedCredentials
  ): Promise<ExecutionResult> {
    const repository = project.repo as string;
    const absolutePath = this.#resolveSqlFile(job, repository);
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
      // BOTH streams, not whichever one spoke first. The Supabase CLI splits
      // a single failure across the two: the progress chatter goes to stderr
      // ("Connecting to remote database... Applying migration X...") and the
      // reason the thing died goes to stdout. Preferring stderr therefore
      // returns a message that reads like a success cut short, and drops the
      // only line anyone needed.
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${detail}`
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
      // BOTH streams, not whichever one spoke first. The Supabase CLI splits
      // a single failure across the two: the progress chatter goes to stderr
      // ("Connecting to remote database... Applying migration X...") and the
      // reason the thing died goes to stdout. Preferring stderr therefore
      // returns a message that reads like a success cut short, and drops the
      // only line anyone needed.
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${detail}`
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

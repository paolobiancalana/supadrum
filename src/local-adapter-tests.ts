import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

import type { ExecutionResult } from "./domain.js";
import type { ProjectConfig } from "./config.js";
import type { JobSubmission, Job } from "./domain.js";

export const ATLAS_WRITER_LOGIN = "supadrum_atlas_writer";
export const ATLAS_LOGIN_PREFIX = "supadrum_atlas_";

export function registeredAdapterTest(project: ProjectConfig, script: unknown) {
  return typeof script === "string" && project.adapter_tests &&
    Object.hasOwn(project.adapter_tests, script)
    ? project.adapter_tests[script]
    : undefined;
}

export function hasCompletedAdapterSetup(
  getJob: (id: string) => Job,
  project: ProjectConfig,
  submission: Pick<JobSubmission, "project" | "payload" | "repo_sha">
): boolean {
  const registration = registeredAdapterTest(project, submission.payload.script);
  if (!registration) return false;
  if (!registration.setup_sql_path) return true;
  const setupId = submission.payload.setup_job_id;
  if (typeof setupId !== "string") return false;
  let setup: Job;
  try { setup = getJob(setupId); } catch { return false; }
  let committedDigest: string;
  try {
    if (!project.repo || !/^[0-9a-f]{6,64}$/i.test(submission.repo_sha)) return false;
    const blob = execFileSync("git", ["-C", project.repo, "show",
      `${submission.repo_sha}:${registration.setup_sql_path}`],
    { maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    committedDigest = createHash("sha256").update(blob).digest("hex");
  } catch { return false; }
  const verification = setup.result && typeof setup.result === "object" &&
    "verification" in setup.result ? setup.result.verification : null;
  return setup.status === "completed" && setup.operation === "sql.execute" &&
    setup.project === submission.project && setup.repo_sha === submission.repo_sha &&
    setup.payload.path === registration.setup_sql_path &&
    setup.payload.digest === committedDigest &&
    verification !== null && typeof verification === "object" &&
    "repo_sha_verified" in verification && verification.repo_sha_verified === true;
}

export class AdapterTestFailure extends Error {
  constructor(readonly result: ExecutionResult) {
    const output = result.output as { exit_code: number };
    super(`Adapter test script failed with exit code ${output.exit_code}`);
    this.name = "AdapterTestFailure";
  }
}

function localUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Local status has no ${label}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Local ${label} is invalid`); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!(host === "localhost" || host === "::1" ||
    (isIP(host) === 4 && host.split(".")[0] === "127"))) {
    throw new Error(`Local ${label} must use a loopback host`);
  }
  if (url.protocol !== "http:") throw new Error(`Local ${label} must use HTTP`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`Local ${label} must not contain credentials or a path`);
  }
  return url.toString().replace(/\/$/, "");
}

export function verifiedLocalKey(key: string, secret: string, role = "anon"): string {
  const [header, payload, signature, extra] = key.split(".");
  if (!header || !payload || !signature || extra) throw new Error(`Local ${role} key is invalid`);
  try {
    const headerJson: unknown = JSON.parse(Buffer.from(header, "base64url").toString());
    const payloadJson: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!headerJson || typeof headerJson !== "object" || !("alg" in headerJson) || headerJson.alg !== "HS256" ||
      !payloadJson || typeof payloadJson !== "object" || !("role" in payloadJson) || payloadJson.role !== role ||
      !("exp" in payloadJson) || typeof payloadJson.exp !== "number" || payloadJson.exp <= Date.now() / 1000) {
      throw new Error("invalid claims");
    }
    const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new Error("invalid signature");
    }
  } catch {
    throw new Error(`Local ${role} key is invalid`);
  }
  return key;
}

export function parseLocalAdapterStatus(status: Record<string, unknown>) {
  const fields = Object.fromEntries(
    Object.entries(status).map(([key, value]) => [key.toLowerCase().replaceAll("_", " "), value])
  );
  const anonKey = fields["anon key"];
  const jwtSecret = fields["jwt secret"];
  if (typeof anonKey !== "string" || anonKey.length === 0) {
    throw new Error("Local status has no anon key");
  }
  if (typeof jwtSecret !== "string" || jwtSecret.length < 32) {
    throw new Error("Local status has no JWT secret");
  }
  return {
    apiUrl: localUrl(fields["api url"], "API URL"),
    anonKey: verifiedLocalKey(anonKey, jwtSecret),
    jwtSecret
  };
}

export function syntheticJwt(secret: string, sub: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "supabase",
    sub,
    aud: "authenticated",
    role: "authenticated",
    iat: issuedAt,
    exp: issuedAt + 3600
  })}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** PostgreSQL SCRAM verifier keeps the plaintext out of SQL and statement logs. */
export function postgresScramVerifier(password: string, salt = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

/** Recreate only the broker-owned login; dependencies or active use fail closed. */
export function writerProvisionSql(verifier: string): string {
  const verifierLiteral = quote(verifier);
  return `begin;
do $supadrum$
declare
  writer_oid oid;
begin
  select oid into writer_oid from pg_roles
  where rolname = 'atlas_session_writer' and not rolcanlogin
    and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolreplication and not rolbypassrls;
  if writer_oid is null then raise exception 'atlas_session_writer is unavailable'; end if;
  if exists (select 1 from pg_auth_members where member = writer_oid) then
    raise exception 'atlas_session_writer inherits another role';
  end if;
end
$supadrum$;
drop role if exists ${ATLAS_WRITER_LOGIN};
create role ${ATLAS_WRITER_LOGIN} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${verifierLiteral};
grant atlas_session_writer to ${ATLAS_WRITER_LOGIN};
do $supadrum$
begin
  if (select array_agg(p.proname::text order by p.proname, p.oid)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and has_function_privilege('${ATLAS_WRITER_LOGIN}', p.oid, 'EXECUTE'))
     is distinct from array[
       'live_owner_claim', 'live_owner_cycle',
       'session_activate', 'session_begin_opening', 'session_confirm_closed',
       'session_expire_leases', 'session_fail_opening', 'session_fail_stale_openings',
       'session_heartbeat',
       'session_mark_closing', 'session_owner_mark_closing', 'session_record_usage'
     ]::text[] then
    raise exception 'Broker writer login has unexpected app function privileges';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'public') and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (
        has_table_privilege('${ATLAS_WRITER_LOGIN}', c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('${ATLAS_WRITER_LOGIN}', c.oid,
          'SELECT,INSERT,UPDATE,REFERENCES')
      )
  ) then
    raise exception 'Broker writer login has table privileges';
  end if;
end
$supadrum$;
commit;
`;
}

export type HumanRole = "atlas_cost_owner" | "atlas_session_operator";

/**
 * Recreate one person's login as a member of only its human role; any wider reach fails closed.
 * `members` names every registered personal login of that role: any other member of the role
 * (a shared login, the writer, a retired person) is refused.
 */
export function personalLoginProvisionSql(login: string, role: HumanRole, verifier: string,
  members: readonly string[]): string {
  const other: HumanRole = role === "atlas_cost_owner" ? "atlas_session_operator" : "atlas_cost_owner";
  const memberList = members.map(quote).join(", ");
  // Reserved = executable by some role but not by PUBLIC. A PUBLIC function is nobody's.
  const reserved = `not (p.proacl is null or exists (
        select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`;
  return `begin;
do $supadrum$
declare
  role_oid oid;
begin
  select oid into role_oid from pg_roles
  where rolname = '${role}' and not rolcanlogin
    and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolreplication and not rolbypassrls;
  if role_oid is null then raise exception '${role} is unavailable'; end if;
  if exists (select 1 from pg_auth_members where member = role_oid) then
    raise exception '${role} inherits another role';
  end if;
  -- The provisioner itself is exempt: without superuser it may grant the role only as its admin.
  if exists (
    select 1 from pg_auth_members m join pg_roles r on r.oid = m.member
    where m.roleid = role_oid and r.rolname <> current_user
      and r.rolname <> all (array[${memberList}]::text[])
  ) then
    raise exception '${role} has a member that is not a registered personal login';
  end if;
end
$supadrum$;
drop role if exists ${login};
create role ${login} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${quote(verifier)};
grant ${role} to ${login};
do $supadrum$
declare
  other_oid oid;
begin
  select oid into other_oid from pg_roles where rolname = '${other}';
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and not ${reserved}
  ) then
    raise exception 'An app function is executable by PUBLIC';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'public') and ${reserved}
      and has_function_privilege('${login}', p.oid, 'EXECUTE')
      and has_function_privilege('atlas_session_writer', p.oid, 'EXECUTE')
  ) then
    raise exception 'Personal login can execute a writer function';
  end if;
  if other_oid is not null and exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'public') and ${reserved}
      and has_function_privilege('${login}', p.oid, 'EXECUTE')
      and has_function_privilege(other_oid, p.oid, 'EXECUTE')
  ) then
    raise exception 'Personal login can execute a function of ${other}';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'public') and (
      (c.relkind in ('r', 'p', 'v', 'm', 'f') and (
        has_table_privilege('${login}', c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('${login}', c.oid,
          'SELECT,INSERT,UPDATE,REFERENCES')))
      or (c.relkind = 'S' and has_sequence_privilege('${login}', c.oid, 'USAGE,SELECT,UPDATE'))
    )
  ) then
    raise exception 'Personal login has table privileges';
  end if;
  if has_database_privilege('${login}', current_database(), 'CREATE')
    or has_schema_privilege('${login}', 'app', 'CREATE')
    or has_schema_privilege('${login}', 'public', 'CREATE') then
    raise exception 'Personal login can create objects';
  end if;
end
$supadrum$;
commit;
`;
}

/** After a refused provisioning, a login left from an earlier run must not stay usable. */
export function personalLoginDisableSql(login: string): string {
  return `do $supadrum$
begin
  if exists (select 1 from pg_roles where rolname = '${login}') then
    execute 'alter role ${login} nologin';
  end if;
end
$supadrum$;
`;
}

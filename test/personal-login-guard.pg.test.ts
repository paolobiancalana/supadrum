import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

import { personalLoginDisableSql, personalLoginProvisionSql, type HumanRole } from "../src/local-adapter-tests.js";

// Behaviour of the personal-login guard on a real PostgreSQL. It creates and drops Atlas-named
// roles and the app schema, so it runs only against a throwaway cluster:
//   SUPADRUM_THROWAWAY_PG_URL=postgresql://postgres@127.0.0.1:55930/postgres npx vitest run test/personal-login-guard.pg.test.ts
const url = process.env.SUPADRUM_THROWAWAY_PG_URL;
const verifier = "SCRAM-SHA-256$4096:c2FsdHNhbHRzYWx0c2FsdA==$c3RvcmVkc3RvcmVkc3RvcmVkc3RvcmVkc3RvcmVkc3Q=:c2VydmVyc2VydmVyc2VydmVyc2VydmVyc2VydmVyc2U=";
const owner = "supadrum_atlas_cost_owner_p";
const operator = "supadrum_atlas_operator_p";

function psql(sql: string) {
  const run = spawnSync("psql", ["--no-psqlrc", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", url!],
    { input: `set client_min_messages = warning;\n${sql}`, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr };
}
const value = (sql: string) => psql(sql).stdout;

// sim_pg stands for Supabase's postgres: it can create roles but is not a superuser, so it may
// grant a human role only as that role's admin (PostgreSQL 16+ makes the creator one).
function reset(extra = "", rolesBySimPg = false) {
  const setup = psql(`
drop schema if exists app cascade;
drop function if exists public.pw(), public.pc2(), public.pp();
drop role if exists ${owner}, ${operator}, atlas_team_owner;
drop role if exists atlas_session_writer, atlas_cost_owner, atlas_session_operator;
drop role if exists sim_pg;
create role sim_pg login createrole;
${rolesBySimPg ? "set role sim_pg;" : ""}
create role atlas_session_writer nologin;
create role atlas_cost_owner nologin;
create role atlas_session_operator nologin;
reset role;
create schema app;
revoke create on schema public from public;
create table app.t (x int);
create sequence app.s;
create function app.w() returns int language sql as 'select 1';
create function app.c() returns int language sql as 'select 2';
create function app.o() returns int language sql as 'select 3';
revoke all on function app.w(), app.c(), app.o() from public;
grant execute on function app.w() to atlas_session_writer;
grant execute on function app.c() to atlas_cost_owner;
grant execute on function app.o() to atlas_session_operator;
${extra}`);
  expect(setup.status, setup.stderr).toBe(0);
}

const provision = (login: string, role: HumanRole, members = [login], asSimPg = false) =>
  psql(`${asSimPg ? "set role sim_pg;\n" : ""}${personalLoginProvisionSql(login, role, verifier, members)}`);
const memberships = (login: string) => value(`select string_agg(m.roleid::regrole::text, ',') from pg_auth_members m
  where m.member = '${login}'::regrole`);
const attributes = (login: string) => value(`select concat_ws('|', rolsuper, rolcreatedb, rolcreaterole, rolreplication,
  rolbypassrls, rolinherit, rolcanlogin) from pg_roles where rolname = '${login}'`);
const loginExists = (login: string) => value(`select count(*) from pg_roles where rolname = '${login}'`) === "1";
const canRun = (login: string, fn: string) => value(`select has_function_privilege('${login}', '${fn}', 'EXECUTE')`) === "t";

describe.skipIf(!url)("personal login guard on PostgreSQL", () => {
  test("refuses to run outside a loopback cluster without Supabase schemas", () => {
    expect(new URL(url!).hostname).toMatch(/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/);
    expect(value("select count(*) from pg_namespace where nspname in ('auth', 'storage')")).toBe("0");
  });

  test("a clean login is a plain login in only its role, reaching its own role's function and nothing else", () => {
    reset();
    expect(provision(owner, "atlas_cost_owner").status).toBe(0);
    expect(attributes(owner)).toBe("f|f|f|f|f|t|t");
    expect(memberships(owner)).toBe("atlas_cost_owner");
    expect([canRun(owner, "app.c()"), canRun(owner, "app.o()"), canRun(owner, "app.w()")]).toEqual([true, false, false]);
    expect(provision(operator, "atlas_session_operator").status).toBe(0);
    expect(canRun(operator, "app.o()")).toBe(true);
  });

  test("a provisioner without superuser that created the human roles provisions, and still refuses a shared admin", () => {
    reset("", true);
    const run = provision(owner, "atlas_cost_owner", [owner], true);
    expect(run.status, run.stderr).toBe(0);
    expect(memberships(owner)).toBe("atlas_cost_owner");
    expect(attributes(owner)).toBe("f|f|f|f|f|t|t");
    psql("create role atlas_team_owner login createrole; grant atlas_cost_owner to atlas_team_owner with admin option, inherit false, set false;");
    const shared = provision(owner, "atlas_cost_owner", [owner], true);
    expect(shared.stderr).toContain("has a member that is not a registered personal login");
  });

  test("a function of public executable by PUBLIC is nobody's and does not refuse the login", () => {
    reset("create function public.pp() returns int language sql as 'select 7';");
    expect(provision(owner, "atlas_cost_owner").status).toBe(0);
  });

  test("the other human role may be missing", () => {
    reset("drop owned by atlas_session_operator; drop role atlas_session_operator;");
    expect(provision(owner, "atlas_cost_owner").status).toBe(0);
  });

  const refused: [string, string, string, HumanRole?][] = [
    ["the role is missing", "drop owned by atlas_cost_owner; drop role atlas_cost_owner;", "atlas_cost_owner is unavailable"],
    ["the role can log in", "alter role atlas_cost_owner login;", "atlas_cost_owner is unavailable"],
    ["the role bypasses RLS", "alter role atlas_cost_owner bypassrls;", "atlas_cost_owner is unavailable"],
    ["the role is a superuser", "alter role atlas_cost_owner superuser;", "atlas_cost_owner is unavailable"],
    ["the role creates databases", "alter role atlas_cost_owner createdb;", "atlas_cost_owner is unavailable"],
    ["the role creates roles", "alter role atlas_cost_owner createrole;", "atlas_cost_owner is unavailable"],
    ["the role replicates", "alter role atlas_cost_owner replication;", "atlas_cost_owner is unavailable"],
    ["the role belongs to the writer", "grant atlas_session_writer to atlas_cost_owner;", "atlas_cost_owner inherits another role"],
    ["the role may only SET ROLE to the writer", "grant atlas_session_writer to atlas_cost_owner with inherit false, set true;", "atlas_cost_owner inherits another role"],
    ["the role only administers the writer", "grant atlas_session_writer to atlas_cost_owner with admin true, inherit false, set false;", "atlas_cost_owner inherits another role"],
    ["the role belongs to a system role", "grant pg_read_server_files to atlas_cost_owner;", "atlas_cost_owner inherits another role"],
    ["the role belongs to the other human role", "grant atlas_session_operator to atlas_cost_owner;", "atlas_cost_owner inherits another role"],
    ["the writer belongs to the role", "grant atlas_cost_owner to atlas_session_writer;", "has a member that is not a registered personal login"],
    ["a shared login belongs to the role", "create role atlas_team_owner login; grant atlas_cost_owner to atlas_team_owner;", "has a member that is not a registered personal login"],
    ["an app function is executable by PUBLIC", "create function app.p() returns int language sql as 'select 4';", "An app function is executable by PUBLIC"],
    ["the role also runs a writer function", "grant execute on function app.w() to atlas_cost_owner;", "Personal login can execute a writer function"],
    ["the role runs a writer function in public", "create function public.pw() returns int language sql as 'select 5'; revoke all on function public.pw() from public; grant execute on function public.pw() to atlas_session_writer, atlas_cost_owner;", "Personal login can execute a writer function"],
    ["the operator also runs the cost owner's function", "grant execute on function app.c() to atlas_session_operator;", "Personal login can execute a function of atlas_cost_owner", "atlas_session_operator"],
    ["the cost owner also runs the operator's function", "grant execute on function app.o() to atlas_cost_owner;", "Personal login can execute a function of atlas_session_operator"],
    ["both human roles run a function in public", "create function public.pc2() returns int language sql as 'select 8'; revoke all on function public.pc2() from public; grant execute on function public.pc2() to atlas_cost_owner, atlas_session_operator;", "Personal login can execute a function of atlas_session_operator"],
    ["default privileges give new app functions to both roles", "alter default privileges in schema app grant execute on functions to atlas_session_operator; create function app.waive() returns int language sql as 'select 6'; revoke all on function app.waive() from public; grant execute on function app.waive() to atlas_cost_owner;", "Personal login can execute a function of atlas_session_operator"],
    ["the role reads a table", "grant select on app.t to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role reads a column", "grant select (x) on app.t to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role deletes from a table", "grant delete on app.t to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role truncates a table", "grant truncate on app.t to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role inserts into a column", "grant insert (x) on app.t to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role updates a column", "grant update (x) on app.t to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role reads a materialized view", "create materialized view app.mv as select 1 as x; grant select on app.mv to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role reads a partitioned table", "create table app.pt (x int) partition by range (x); grant select on app.pt to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role reads a sequence", "grant select on sequence app.s to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role reads a view", "create view app.v as select 1 as x; grant select on app.v to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role advances a sequence", "grant usage on sequence app.s to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role sets a sequence", "grant update on sequence app.s to atlas_cost_owner;", "Personal login has table privileges"],
    ["the role creates in app", "grant create on schema app to atlas_cost_owner;", "Personal login can create objects"],
    ["the role creates in public", "grant create on schema public to atlas_cost_owner;", "Personal login can create objects"],
    ["the role creates in the database", "grant create on database postgres to atlas_cost_owner;", "Personal login can create objects"]
  ];
  test.each(refused)("refuses when %s, leaving no new login", (_, extra, message, role = "atlas_cost_owner") => {
    reset(extra);
    const login = role === "atlas_cost_owner" ? owner : operator;
    const result = provision(login, role);
    psql("revoke create on database postgres from atlas_cost_owner; revoke create on schema public from atlas_cost_owner;");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(loginExists(login)).toBe(false);
  });

  test("a login left from an earlier run is disabled when the guard later refuses", () => {
    reset();
    expect(provision(owner, "atlas_cost_owner").status).toBe(0);
    psql("grant select on app.t to atlas_cost_owner;");
    expect(provision(owner, "atlas_cost_owner").status).not.toBe(0);
    expect(value(`select rolcanlogin from pg_roles where rolname = '${owner}'`)).toBe("t");
    expect(psql(personalLoginDisableSql(owner)).status).toBe(0);
    expect(value(`select rolcanlogin from pg_roles where rolname = '${owner}'`)).toBe("f");
    expect(psql(personalLoginDisableSql("supadrum_atlas_absent_p")).status).toBe(0);
  });
});

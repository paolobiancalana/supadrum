/** The project-scoped operations needed to activate configured local workers. */
export interface WorkerActivation {
  stop(): Promise<void>;
  secrets(): Promise<void>;
  runtime(): Promise<void>;
  schedule(): Promise<void>;
  verify(): Promise<void>;
  activate(): Promise<void>;
}

/** The registered job names as a SQL list; anything outside the registration is refused before it reaches SQL. */
function jobList(names: readonly string[]): string {
  if (!names.length || new Set(names).size !== names.length || names.some(name => !/^[a-zA-Z0-9_-]{1,63}$/.test(name))) {
    throw new Error("Local worker jobs are not registered");
  }
  return names.map(name => `'${name}'`).join(",");
}

/** Disables only the jobs named in the operator's configuration. */
export function stopLocalWorkerSql(names: readonly string[]): string {
  const jobs = jobList(names);
  return `begin;
do $supadrum$ declare j record; begin
  for j in select jobid from cron.job where jobname in (${jobs}) loop
    perform cron.alter_job(j.jobid, active := false);
  end loop;
  if exists (select 1 from cron.job where jobname in (${jobs}) and active) then
    raise exception 'Local worker jobs remain active';
  end if;
end $supadrum$;
commit;`;
}

/** A committed schedule script is read as one psql session; this bounds what one job may feed it. */
export const LOCAL_WORKER_SCHEDULE_MAX_BYTES = 256 * 1024;

/**
 * The committed schedule scripts followed by the stop, as one psql session. The scripts create their jobs
 * active (`cron.schedule` does), so the stop runs in the same session. The window between a script's own
 * commit and the stop is milliseconds; a cron tick landing in it is the residual risk (docs/local-functions-design.md).
 *
 * psql reads a backslash anywhere outside a quoted string or comment as a meta-command, mid-line included
 * (`select 1; \! cmd` runs `cmd` on this host), and only the server's lexer can tell where a string ends. So
 * a backslash anywhere in a script is refused, strings and comments included: no parser, nothing to bypass.
 */
export function scheduleLocalWorkersSql(scripts: readonly string[], names: readonly string[]): string {
  if (!scripts.length || scripts.some(script => !script.trim() || Buffer.byteLength(script) > LOCAL_WORKER_SCHEDULE_MAX_BYTES)) {
    throw new Error("Local worker schedule script is not acceptable");
  }
  const sql = `${scripts.map(script => script.replace(/\s+$/, "")).join("\n")}\n${stopLocalWorkerSql(names)}`;
  if (sql.includes("\\")) throw new Error("Local worker schedule script is not acceptable");
  return sql;
}

/** Each registered job exists exactly once and none is running yet. */
export function verifyLocalWorkersSql(names: readonly string[]): string {
  const jobs = jobList(names);
  return `do $supadrum$ begin
  if (select count(*) from cron.job where jobname in (${jobs})) <> ${names.length}
     or (select count(distinct jobname) from cron.job where jobname in (${jobs})) <> ${names.length} then
    raise exception 'Local worker jobs are not scheduled exactly once';
  end if;
  if exists (select 1 from cron.job where jobname in (${jobs}) and active) then
    raise exception 'Local worker jobs are already active';
  end if;
end $supadrum$;`;
}

/** Enables only the jobs named in the operator's configuration, all or none. */
export function activateLocalWorkerSql(names: readonly string[]): string {
  const jobs = jobList(names);
  return `begin;
do $supadrum$ declare j record; begin
  for j in select jobid from cron.job where jobname in (${jobs}) loop
    perform cron.alter_job(j.jobid, active := true);
  end loop;
  if (select count(*) from cron.job where jobname in (${jobs}) and active) <> ${names.length} then
    raise exception 'Local worker jobs did not all activate';
  end if;
end $supadrum$;
commit;`;
}

/** Stop the previous schedule before preparing or activating its replacement. */
export async function activateLocalWorkers(operations: WorkerActivation): Promise<void> {
  await operations.stop();
  try {
    await operations.secrets();
    await operations.runtime();
    await operations.schedule();
    await operations.verify();
    await operations.activate();
  } catch (failure) {
    try { await operations.stop(); }
    catch (stopFailure) { throw new AggregateError([failure, stopFailure], "Worker reconfiguration and stop failed"); }
    throw failure;
  }
}

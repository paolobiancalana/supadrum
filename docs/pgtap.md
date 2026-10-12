# pgTAP on a staged tree

`supadrum pgtap <alias> <tree-oid>` runs the pgTAP tests of a project against
exactly one git **tree**, in a disposable Supabase stack, and exits with a code
a `pre-commit` hook can act on. The tree is the staged content (what
`git write-tree` makes of the index), not the working tree and not `HEAD`.

The command only queues a `pgtap.run` job (capability `pgtap`, no approval) and
waits for the runner; the runner does the work. It reads no credential and the
job payload is empty: the caller supplies nothing but the tree.

For tests that need the whole stack (Playwright, Edge Functions), see
[docs/stack.md](stack.md): same tree, same stack, kept up for one command.

No hook ships in `examples/`. The hook is yours to write (see
[Limits](#limits) for what it has to do).

## Command

```
supadrum pgtap <alias> <tree-oid> [--config PATH]
```

- `<alias>` is the project name in the operator config. The working directory
  is **not** used to find the project, the repository or the config: a hook runs
  inside the repository it checks, so a `supadrum.yml` there is never read.
- `<tree-oid>` is a full 40 or 64 hex-digit object name. A prefix, a branch or
  `HEAD` is refused.
- The config comes from `--config`, else `SUPADRUM_CONFIG`, else
  `$XDG_CONFIG_HOME/supadrum/config.yml` (`~/.config/supadrum/config.yml`).
- `supadrum-runner` must be running (`runner.pid` beside the database).
- The job id is printed at once. While waiting, a status line goes to stderr
  every 5 s. The test's own stdout and stderr are then printed as they are,
  followed by `pgtap: verde|rosso (exit N) tree <oid> db <image> in <s> s`, and a
  `pgtap: residuo dopo la pulizia: ...` line if cleanup left something.
- Every non-zero exit says why on stderr, and that `git commit --no-verify`
  skips the hook. The messages are in Italian.

## Configuration

The chamber needs a `pgtap` block, and the project lists the capability:

```yaml
version: 1
executor: command            # dry-run is refused: a fake green is a skipped proof
pgtap:                       # broker-wide, optional, shown with its defaults
  queue_timeout_ms: 120000
  port_base: 56321
  min_free_gib: 5
chambers:
  example-local:
    target: local
    pgtap:                   # per chamber, required for a project with `pgtap`
      tests_path: supabase/tests    # start_timeout_ms: 300000, test_timeout_ms: 120000
projects:
  example:
    repo: /absolute/path/to/example
    chamber: example-local
    mode: live
    capabilities: [pgtap]
```

| Key | Default | Meaning |
| --- | --- | --- |
| chamber `pgtap.tests_path` | required | Folder of the pgTAP tests in the tree. Relative, `^[a-zA-Z0-9_./-]+$`, not absolute, no `..`. Fixed here, never in the job. |
| chamber `pgtap.start_timeout_ms` | `300000` | Limit of the `supabase start` phase. Covers a cold image pull. |
| chamber `pgtap.test_timeout_ms` | `120000` | Limit of the `supabase test db` phase. |
| root `pgtap.queue_timeout_ms` | `120000` | How long a queued run may wait for the runner before it is cancelled unrun. |
| root `pgtap.port_base` | `56321` | Where the scan for free ports starts (the CLI's own stack sits at 543xx, a second manual one usually at 553xx). |
| root `pgtap.min_free_gib` | `5` | Free space the Docker VM disk must report before a stack is created. |

Both blocks reject unknown keys. A project that lists `pgtap` must be `target:
local`, its chamber must have the `pgtap` block (`loadConfig` fails otherwise),
and its name may only use `[a-z0-9-]`, because it becomes part of the stack id.
The prepare and cleanup phases have a fixed 60 s limit each.

## What a run does

The stack id is `supadrum-tmp-<project>`; the prefix is reserved to the broker.

1. **Prepare.** Checks that the OID is a tree and that every object under it is
   present; that Docker answers, the Supabase CLI is 2.116.0 or newer (a floor,
   not an allowlist) and the VM disk has `min_free_gib` (measured by `df` in a
   throwaway container from an image already on the host; nothing is pulled);
   removes any previous stack with this id; extracts the tree with `git archive`
   under a neutral git config (`GIT_CONFIG_GLOBAL=/dev/null`,
   `GIT_CONFIG_NOSYSTEM=1`, git-lfs smudge off) into
   `~/.cache/supadrum/supadrum-tmp-<project>`. The folder is under `$HOME`
   because Colima does not share `/private/tmp` with its VM.
2. **Config.** The tree's `supabase/config.toml` is copied with four overrides:
   `project_id` becomes the stack id (a tree that already has the reserved
   prefix is refused), every integer `port` or `*_port` key in any table gets a
   free port from `port_base`, `[db.seed] enabled = false`. The rest of the file
   is the tree's. The broker also creates the stack's network, labelled like the
   rest.
3. **Start.** `supabase start` with every service excluded but the database
   (`-x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`),
   then the image tag of the database container is read from Docker.
4. **Test.** `supabase test db <tests_path>`. Its exit code is the verdict.
5. **Cleanup**, always, even after an error or a timeout.

Cleanup never uses `supabase stop`. It lists containers, volumes and networks
whose label `com.supabase.cli.project` equals the stack id exactly (never a
prefix or a name pattern), removes them and the folder, and then reports as
residue anything still carrying the id in its label or name. The id must match
`^supadrum-tmp-[a-z0-9-]+$` before any Docker call, which is what keeps a manual
stack (`com.supabase.cli.project=<project>`) out of reach.

A cleanup that fails **before** the run is a refusal and nothing starts. A
cleanup that fails **after** it does not change the verdict: the residue is
reported separately (`verification.cleanup_residue`), because failing the commit
for it would push people to `--no-verify`.

## Result

```
output:       { exit_code, stdout, stderr }     # of `supabase test db`, redacted
verification: { target: "local", tree_oid, db_image, duration_ms,
                phases: { prepare_ms, start_ms, test_ms, cleanup_ms },
                reason, cleanup_residue? }      # residue only when there is one
```

`db_image` is the tag Docker reports for the database container; `reason` is
null on a pass.

## Exit codes

| Code | Class | Causes (`reason`) |
| --- | --- | --- |
| 0 | pass | `supabase test db` exited 0. |
| 1 | tests failed | `tests_failed`: `supabase test db` exited non-zero. |
| 2 | command refusal, before queuing | Wrong usage; config unreadable; unknown alias; project not `local`; no `pgtap` capability; chamber without the `pgtap` block; `mode` not `live`; `executor` not `command`; OID not a full object name; runner not running. Also when the runner dies while the command waits (the job is cancelled if it had not started). |
| 3 | runner refusal, before any container | `tree_invalid`, `tree_incomplete`, `extraction_failed`, `docker_unreachable`, `supabase_cli_missing`, `supabase_cli_too_old`, `no_probe_image`, `space_probe_failed`, `insufficient_space`, `reserved_project_id`, `original_port_left`, `ports_exhausted`, `tests_path_missing`, `cleanup_before_failed`. |
| 4 | failure while running | `start_failed`, `phase_timeout` (the message names the phase and its limit), and any failed job without a recognised `reason`. |
| 5 | queue | `queue_timeout`: still unclaimed after `queue_timeout_ms`, job cancelled. Also the waiting ceiling (`queue_timeout_ms` + start + test + 210 s): the job is left as it is. |
| 130 | interrupted | SIGINT, SIGTERM or SIGHUP. The job is cancelled if it had not started; otherwise it keeps going and the runner cleans up. |

## Limits

Declared, not worked around:

- **Local chambers only.** A remote chamber is refused (exit 2).
- **Not supported in the tree:** submodules (a gitlink arrives as an empty
  folder), git-lfs (pointers are not resolved), and files marked `export-ignore`
  in a `.gitattributes` of the tree (`git archive` leaves them out).
- **`auth` and `realtime` are incomplete.** Their services are not started, so
  some of their tables do not exist. A test or migration that needs one fails
  with Postgres's own error, in the output; it is not masked.
- **No image pinning.** The stack uses the CLI's default images for the major
  version in the tree's `config.toml`, not the `supabase/.temp/*-version` files
  of a manual stack (they are untracked and absent from `git archive`). Compare
  `verification.db_image` with the manual stack's tag if a patch release could
  matter. The first run after a CLI upgrade pulls images (3 to 4 GiB) and may
  hit `phase_timeout` in the start phase: retry.
- **One runner per host.** The stack id, its network and its folder are fixed
  per project and nothing locks them. A second runner on the same host would see
  the database vanish under it and fail visibly, never pass falsely.
- **No sweeper.** A `kill -9` of the CLI or a crash mid-start leaves one orphan
  at most per project (about 75 MiB and a volume), removed by the next run of
  that project. A project that never runs again can keep it for good: remove it
  by hand, by exact label (`<project>` is the alias):

  ```
  docker ps -a --filter label=com.supabase.cli.project=supadrum-tmp-<project>
  docker volume ls --filter label=com.supabase.cli.project=supadrum-tmp-<project>
  docker network ls --filter label=com.supabase.cli.project=supadrum-tmp-<project>
  ```

  then `docker rm -f`, `docker volume rm` and `docker network rm` on what those
  list, and delete `~/.cache/supadrum/supadrum-tmp-<project>`.
- **The tree is the hook's.** The broker never computes it. The hook must run
  `git write-tree` on its own `GIT_INDEX_FILE`, made absolute: for `git commit
  -a`, `--include` and `--only` git points the hook at a different index file,
  and only that one holds what will be committed. Verified with git 2.50.1 on
  macOS for `-a`, `--include`, `--only`, `--amend` and linked worktrees. **Not
  verified:** Linux, Windows, `commit -p`, a merge in progress. Details, and the
  experiments behind them, in
  [docs/research/staged-tree-pre-commit.md](research/staged-tree-pre-commit.md).
  That behaviour belongs to git and the hook, so the test suite does not cover
  it; it covers that the broker extracts the tree it is given and not the
  working tree.
- **`git commit --no-verify` skips the hook,** and with it the proof.
- **A cleanup that cannot finish before the next run** blocks that next run
  (`cleanup_before_failed`, exit 3) instead of starting on stale data.

## Testing it for real

`npm test` covers the command, the executor and the cleanup with fake processes
and real git. The Docker proof is a separate file that does nothing unless asked
(it needs Docker, the CLI 2.116.0 or newer and a local
`public.ecr.aws/supabase/postgres` image):

```
SUPADRUM_DOCKER_TESTS=1 node_modules/.bin/vitest run test/pgtap.docker.test.ts
```

It runs a green and a red fixture tree through `LiveSupabaseExecutor`, checks
that `db_image` is the tag Docker reported while the proof ran, that nothing
labelled with the fixture's stack id survives, and that the cleanup removes a
disposable stack while leaving a neighbour with a similar id. It uses its own
ids (`supadrum-tmp-pgtapfixture`, `supadrum-tmp-pgtapnb`, `pgtapnb`) and never
touches any other project's stack.

Run vitest by its path as above, not through `npx` or `npm run`: those put every
ancestor `node_modules/.bin` on `PATH`, and a `supabase` found there before the
one you installed is the one the runner will use. The check refuses a CLI that
is too old (`supabase_cli_too_old`), which is how this was found.

# A disposable stack for a command

`supadrum stack <alias> <tree-oid> -- <command...>` starts a disposable local
Supabase stack from exactly one git **tree**, runs the command with the stack's
addresses in its environment, and removes the stack when the command ends. It
exists so a `pre-commit` hook can run Playwright or Deno Edge Function tests
against the staged content, the way `supadrum pgtap` runs pgTAP (#59). Read
[docs/pgtap.md](pgtap.md) first: the tree, the prerequisites, the stack id and
most limits are the same, and this page says only what differs.

The command opens a **session** (capability `stack`, lease of 30 s kept alive by
a heartbeat every 5 s), queues one `stack.serve` job inside it, and waits. The
runner prepares and starts the stack as for pgTAP, but stops there and answers
with `supabase status -o env`. When the command ends, the session is closed and
the runner removes the stack. The exit code is the command's own.

## Command

```
supadrum stack <alias> <tree-oid> [--config PATH] -- <command...>
```

- `<alias>`, `<tree-oid>` and `--config` are as for `pgtap`; the runner must be
  running.
- Everything after `--` is the command: spawned as it is, no shell, with the
  operator's working directory and stdin, stdout and stderr. `supadrum stack
  example $(git write-tree) -- npx playwright test` is the shape.
- `stack: sessione <id>` is printed at once on stderr; a status line follows
  every 5 s while waiting. When the command ends: `stack: <command> exit N tree
  <oid> db <image> in <s> s`.

## Configuration

The project lists `stack` beside `pgtap`; there is no block of its own. The
chamber's `pgtap` block supplies the limits (`start_timeout_ms` covers the
start), the root `pgtap` block the queue timeout, the port base and the disk
floor:

```yaml
projects:
  example:
    repo: /absolute/path/to/example
    chamber: example-local
    mode: live
    capabilities: [pgtap, stack]
```

A project with `stack` has the same constraints as one with `pgtap`: `target:
local`, a chamber with the `pgtap` block, a `[a-z0-9-]` name, `mode: live` and
`executor: command`.

## What the command gets

The stack is `supadrum-tmp-<alias>`, started with every service a test may
call; only the tooling is left out (`studio`, `logflare`, `vector`,
`supavisor`, `postgres-meta`). Its `tests_path` is not required in the tree.

The command inherits the operator's environment, plus one variable per line of
`supabase status -o env`, prefixed with `SUPADRUM_` so nothing of the
operator's is shadowed and nothing of the stack's is mistaken for a real
project's:

```
SUPADRUM_API_URL        SUPADRUM_DB_URL        SUPADRUM_ANON_KEY
SUPADRUM_SERVICE_ROLE_KEY ...                  (whatever the CLI prints)
```

Quotes around a value are stripped. The database URL is not redacted here: it
is the caller's to use, and the stack has the CLI's default password.

## Exit codes

The command's exit code is returned as it is, `128 + signal` if a signal ended
it. The stack's own refusals use the pgTAP codes; a command that exits 2 to 5
is therefore told apart by the `stack: ...` line on stderr, not by the code.

| Code | Meaning |
| --- | --- |
| 2 | Refused before the session: usage, config, alias, capability `stack` missing, mode, executor, OID, runner not running. Also the runner dying while waiting. |
| 3, 4 | The runner could not serve the stack: `reason` and phase as in pgTAP (`start_failed`, `phase_timeout`, `tree_invalid`, ...). 4 also for a session the runner refused, or a job without a status. |
| 5 | Still queued after `queue_timeout_ms`, or the start waited past `start_timeout_ms` + 90 s. |
| 127 | The command could not be spawned. |
| 130 | SIGINT, SIGTERM or SIGHUP before the command started. Once it runs, the signal is forwarded to it and its own code is returned. |

In every case but 127 and a running command, the session is closed and the
runner removes the stack; the command waits up to 90 s for that so the next
`pgtap` or `stack` on the same project finds the chamber free.

## Limits

- **One thing at a time.** The runner serves one session at a time and nothing
  else while it lasts: a `pgtap.run` or any other job queued meanwhile waits.
  There is no duration cap; a hook's test suite is expected to end.
- **A config edit during the session ends it.** The runner reloads its config
  by restarting the loop, which closes the session and removes the stack
  under the command.
- **A runner restart orphans the stack.** The next run of the same project
  removes it (cleanup before the run), as for pgTAP; remove it by hand as
  [docs/pgtap.md](pgtap.md#limits) says if the project never runs again.
- **A signal sent to the command's pid alone** (`kill -INT <pid>`, not the
  terminal's Ctrl-C) is forwarded to the child only. A wrapper such as
  `sh -c` or `npx` may wait for its own children instead of dying, and the
  command then ends when they do. Ctrl-C signals the whole process group and
  has no such gap.
- **`kill -9` of the command** leaves its child running and the stack up
  until the lease expires (about 30 s), when the runner removes the stack
  under the child.
- **Everything in [pgtap's limits](pgtap.md#limits)** about the tree
  (submodules, lfs, `export-ignore`, `git write-tree` on the hook's index) and
  about images applies.

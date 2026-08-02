# Security

## Supported version

Security fixes currently target the latest `0.x` release.

## Reporting

Do not open a public issue for a credential disclosure, command-injection path,
authorization bypass, approval bypass, redaction failure, or queue-isolation
failure. Use the repository host's private security-advisory feature and
include a minimal reproduction without real credentials.

## Secret visibility boundary

Supadrum is an open-source, local-first broker. It has no hosted secret service
and no telemetry code path that sends credential values to Supadrum
maintainers. The maintainers do not receive, escrow, or have a recovery path
for operator credentials.

The bundled credential flow is designed so Supadrum never places resolved
values in MCP messages or LLM prompts:

- values are read from a masked interactive TTY and written to the operator's
  local macOS Keychain;
- [Keychain](https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web)
  stores secret data encrypted at rest and applies macOS access controls;
- config files contain only references, while MCP schemas reject credential
  fields, vault references, and PostgreSQL URLs in job payloads;
- SQLite persists intents and redacted results, not credential values;
- resolved values exist briefly in runner and child-process memory and are
  injected only into environment names selected by operator-owned command
  templates;
- exact resolved values are redacted from captured child stdout and stderr.

This reduces the exposure surface compared with a plaintext `.env`: a coding
agent with repository access can read an `.env`, while it cannot resolve a
Keychain reference through the MCP surface.

This is not a sandbox boundary. An agent with unrestricted shell access running
as the same macOS user can invoke local executables and shares that user's
Keychain security boundary. Hard separation between an agent and credentials
requires running the broker and vault resolver under a dedicated OS identity
that the agent cannot access, or using an external vault with independently
enforced identity and policy. Malware, a compromised operator account, or an
explicitly authorized malicious resolver or executable may still access or
transform credential material. JavaScript strings also cannot be reliably
zeroed after use.

Open source makes these claims auditable; it does not replace OS hardening,
least privilege, token rotation, command review, or an optional manual
approval policy.

## Deployment boundary

`dry-run` is the default. Enabling `command` mode is an operator decision:

- Keep `supadrum.yml` writable only by the broker operator.
- Pin and audit the vault, Supabase CLI, and PostgreSQL executables.
- Use non-production Supabase projects first.
- Keep command templates as argv arrays and never wrap them in `sh -c`.
- Grant only the project capabilities that are actually needed.
- Grant only capabilities whose operations the agent may execute autonomously.
- Set `approval_mode: manual` if the deployment requires a second human gate
  for mutations.
- Keep repository SHA verification enabled for repository-backed operations.
- Run the runner as a dedicated OS identity with access only to required
  repositories and vault paths.

Supadrum prevents credentials from entering MCP inputs and SQLite. It cannot
protect credentials from a malicious executable that an operator explicitly
configures as a vault resolver or command template.

## Keychain and SOPS/age

The bundled macOS adapter stores each value under a deterministic
`supadrum:vault://...` generic-password service. Values reach the `security`
interactive process through stdin, not argv. The age private identity uses the
fixed reference `vault://supadrum/keys/age`.

`supadrum project credentials set` accepts values only from an interactive TTY,
masks input, and restores terminal state after success, cancellation, EOF, or
failure. It prompts only for missing Keychain entries and verifies every write
before reporting readiness. JavaScript strings cannot be reliably erased from
memory; the guarantee is process isolation and non-persistence, not memory
zeroization.

For the portable backend:

- commit only SOPS ciphertext and public age recipients;
- never commit `AGE-SECRET-KEY-...` identities, decrypted files, dotenv
  materializations, or real migration backups;
- do not use the unauthenticated SOPS remote key-service mode;
- pin SOPS and age versions and verify checksums and provenance in CI;
- remember that SOPS key names, recipients, timestamps, and metadata are
  visible;
- decrypt only in the runner boundary and consume the selected scalar through
  a pipe.

SOPS provides authenticated encryption for configuration at rest. It is not an
authorization server and does not supply agent identity, policy evaluation,
audit trails, dynamic credentials, or revocation. Use OpenBao, Infisical, or
another resolver behind the same `vault_command` boundary when those controls
are required.

On macOS, a LaunchAgent running as the interactive user shares that user's
security boundary. Keychain custody and SOPS encryption do not protect against
another malicious process already running as that user. Keep `executor:
dry-run` until the runner has a dedicated OS identity or equivalent ACL.

## Project discovery

`supadrum project add` treats the project alias, local Git repository, and
Supabase project ref as separate identifiers. Automatic discovery checks
linked CLI metadata and four conventional dotenv files, but extracts only the
allow-listed public URL names `SUPABASE_URL`, `VITE_SUPABASE_URL`, and
`NEXT_PUBLIC_SUPABASE_URL`. It never returns or logs other dotenv values.
Conflicting public refs or an explicit ref that disagrees with repository
metadata abort registration.

New operator configs and atomic rewrites use mode `0600`. Project registration
always leaves `executor: dry-run`; it does not run `supabase login`, link a
project, contact the Management API, or enable command execution.

By default, `project add` and `project setup` install repository-scoped Codex
workflow files. The copied skill and managed `AGENTS.md` block contain
instructions only. The managed MCP block contains the absolute operator config
path but no credential values or `vault://` references. Existing direct
Supabase MCP definitions are disabled, not deleted, so an operator can audit
the previous configuration. `--no-agent-setup` is the explicit opt-out.

Agent setup does not alter a running Codex task. Start a new task after setup;
otherwise the current process may continue with the tools it loaded at startup.

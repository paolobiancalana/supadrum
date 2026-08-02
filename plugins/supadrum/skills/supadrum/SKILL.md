---
name: supadrum
description: Route every Supabase inspection, SQL query, migration, Auth Admin, Storage, Realtime, Edge Function, secret, or project-management task through the Supadrum MCP broker. Use whenever work targets a Supabase project managed by Supadrum, including read-only work.
---

# Supadrum

Use the broker as the only Supabase access path. Declare project and intent;
never acquire or handle its credentials.

## Required workflow

1. Call `projects.inspect` for the target project.
2. Choose one atomic operation supported by its declared capabilities.
3. Call `jobs.submit` with a credential-free payload, repository SHA, and
   stable idempotency key.
4. Preserve the returned cursor and call `jobs.wait`.
5. On `waiting_approval`, keep the cursor and call `jobs.wait` again once.
   The default automatic policy releases legacy approval-gated jobs in the
   runner. If the job remains blocked, the operator configured manual mode:
   report the job ID and request operator approval. Never bypass that policy.
6. On `waiting_credentials`, report the missing credential names. Do not ask
   for credential values.
7. Treat only `completed` as success. Surface `failed`, `cancelled`, and
   `lease_expired` exactly.

Use `jobs.status` for a snapshot and `jobs.cancel` only before execution begins.

## Sessions

Prefer atomic jobs. Use a session only when multiple interactive operations
must share one chamber.

1. Call `sessions.open` with one least-privilege capability and a short TTL.
2. Wait on the returned `open_job.id` until it completes.
3. Call `sessions.exec` only with operations covered by that capability.
4. Always call `sessions.close`, including after errors.

## Prohibitions

- Never run `supabase login`.
- Never use Supabase CLI, Management API, Postgres, or the official Supabase
  MCP directly.
- Never read local credential files or ask for database URLs, tokens, secret
  keys, service-role keys, passwords, or vault values.
- Never put credentials or `vault://` references in job payloads.
- Never replace a denied capability or a configured manual gate with a more
  privileged operation.
- Never claim success from `granted`, `running`, or `verifying`.

The operator-owned project configuration is the authority for credentials,
commands, capabilities, and approval policy. The default policy is automatic:
capability-authorized jobs proceed without a second human decision. Manual
approval is an explicit operator opt-in.

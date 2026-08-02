# SOPS with age

This backend keeps encrypted project bundles in a portable SOPS JSON file. The
age private identity stays in macOS Keychain and is supplied to SOPS only in
the child-process environment.

## Install and bootstrap

Install pinned, verified releases of
[SOPS](https://github.com/getsops/sops/releases) and
[age](https://github.com/FiloSottile/age/releases). For local macOS
development:

```bash
brew install sops age
npm run build
./dist/vault-cli.js sops bootstrap-age
```

The bootstrap command prints only the public `age1...` recipient. It creates
`vault://supadrum/keys/age` in the current user's Keychain if the identity does
not already exist. An inaccessible existing identity is an error and is never
silently rotated.

Copy [`.sops.yaml.example`](.sops.yaml.example) to an operator-owned
`.sops.yaml` and replace its example recipient. Supadrum's atomic migration
passes the recipient explicitly, so the configuration file is optional for the
broker and useful for normal SOPS operator workflows.

## Migrate a dotenv file

Preview is the default. Values are copied to Keychain and to a verified SOPS
backup, but the source file is not changed:

```bash
supadrum-vault migrate dotenv \
  --source /absolute/path/to/.env \
  --backup /absolute/path/to/secrets.enc.json \
  --map DATABASE_URL=vault://supabase/example/postgres \
  --map SUPABASE_SERVICE_ROLE_KEY=vault://supabase/example/secret
```

Inspect the metadata-only JSON report, then repeat the exact command with
`--apply`. Only the mapped assignments are replaced with `vault-managed`
comments. The replacement is atomic and occurs only after every Keychain
round-trip and the encrypted-backup round-trip succeeds.

Mapping names and vault references enter argv; values do not. Do not place the
source dotenv or a real encrypted local backup in Git unless that repository's
operator policy explicitly permits the ciphertext.

## Configure the resolver

```yaml
executor: dry-run
approval_mode: automatic
vault_command:
  - /absolute/path/to/supadrum-vault
  - sops
  - resolve
  - --file
  - /absolute/path/to/secrets.enc.json
```

The runner writes one `vault://` reference to stdin. For example,
`vault://supabase/example-web/management` maps to the SOPS extract path
`["supabase"]["example-web"]["management"]`. Only the resolved scalar is returned
on stdout.

Keep `executor: dry-run` until the runner has a dedicated OS identity or an
equivalent ACL boundary.

## Security boundaries

- Commit only the encrypted SOPS document and public recipient.
- Never commit an age identity, decrypted output, generated dotenv file, or
  real migration backup.
- SOPS key names and metadata remain visible; do not put sensitive data in key
  names.
- Do not enable the unauthenticated SOPS remote key service.
- Pin SOPS and age in CI and verify release checksums and provenance.
- SOPS protects configuration at rest. It does not provide agent
  authorization, audit policy, dynamic credentials, or revocation.

The local acceptance baseline used while developing this adapter was SOPS
3.13.3 and age 1.3.1. These are observed versions, not unpinned runtime
dependencies.

import type {
  ProjectDoctorReport,
  ProjectProfile
} from "./projects.js";

export interface ProjectAddedOutput {
  readonly alias: string;
  readonly repository: string;
  readonly project_ref: string;
  readonly profile: ProjectProfile;
  readonly ready: boolean;
  readonly configured_credentials: number;
  readonly executor: "dry-run" | "command";
}

export function credentialCount(
  credentials: ProjectDoctorReport["credentials"]
): number {
  return Object.values(credentials).filter(Boolean).length;
}

export function formatProjectAdded(report: ProjectAddedOutput): string {
  return [
    `✓ Project ${report.alias} added`,
    "",
    `  Repository   ${report.repository}`,
    `  Supabase     ${report.project_ref}`,
    `  Profile      ${report.profile}`,
    `  Mode         ${report.executor}`,
    "",
    `${report.ready ? "✓" : "○"} Credentials  ${report.configured_credentials}/3 configured`,
    ...(report.ready
      ? []
      : [
          "",
          "Next:",
          `  supadrum project credentials set ${report.alias}`
        ]),
    ""
  ].join("\n");
}

export function formatProjectDoctor(
  report: ProjectDoctorReport
): string {
  const configuredCredentials = credentialCount(report.credentials);
  return [
    `Supadrum doctor — ${report.project}`,
    "",
    `${report.repository ? "✓" : "✗"} Repository`,
    `${report.project_ref ? "✓" : "✗"} Supabase ref`,
    `✓ Chamber      ${report.chamber}`,
    `${report.migrations === "owner" ? "✓" : "○"} Migrations   ${report.migrations}`,
    `✓ Driver       ${report.migration_driver}`,
    `${configuredCredentials === 3 ? "✓" : "○"} Credentials  ${configuredCredentials}/3 valid`,
    ...(report.invalid_credentials.length > 0
      ? [`  Invalid       ${report.invalid_credentials.join(", ")}`]
      : []),
    `${report.mode === "live" ? "✓" : "○"} Mode         ${report.mode}${report.mode === "dry-run" ? " (safe)" : ""}`,
    "",
    report.ready ? "✓ Ready" : "Not ready",
    ...(report.ready
      ? []
      : [
          "",
          "Next:",
          ...(report.invalid_credentials.length > 0
            ? [
                `  supadrum project credentials set ${report.project} --replace ${report.invalid_credentials[0]}`
              ]
            : [
                `  supadrum project credentials set ${report.project}`
              ])
        ]),
    ""
  ].join("\n");
}

export function formatCredentialSetup(
  project: string,
  ready: boolean
): string {
  return [
    "",
    "✓ Credential bundle saved in macOS Keychain",
    ready ? "✓ Project ready" : "○ Project not ready",
    ...(ready ? [] : [`  supadrum project doctor ${project}`]),
    ""
  ].join("\n");
}

export function formatCredentialSecurityNotice(): string {
  return [
    "Security",
    "",
    "  Supadrum is local and open source. It does not send secret values",
    "  to its maintainers or a hosted Supadrum service, and never places",
    "  them in MCP messages or LLM prompts.",
    "  The masked CLI writes them to macOS Keychain, encrypted at rest",
    "  under operating-system access controls.",
    "",
    "  Secret values never enter jobs, the queue, config, the repository,",
    "  argv, shell history or CLI output. The broker resolves them only",
    "  in local process memory for operator-authorized command execution.",
    "",
    "  This reduces accidental exposure compared with plaintext .env files.",
    "  It is not a sandbox: a process with unrestricted shell access running",
    "  as your macOS user shares that user's security boundary. Use a dedicated",
    "  runner identity or policy-enforcing vault for hard agent isolation.",
    ""
  ].join("\n");
}

function supadrumCredentialName(project: string): string {
  return `supadrum_${project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

export function formatSecretKeyGuide(
  project: string,
  projectRef: string
): string {
  const keyName = supadrumCredentialName(project);
  return [
    "Secret key",
    "",
    "  Open:",
    `  https://supabase.com/dashboard/project/${projectRef}/settings/api-keys`,
    "",
    "  Project Settings → API Keys → Publishable and secret API keys",
    "  Use an existing sb_secret_… key, or choose New secret key,",
    `  name it "${keyName}", then choose Create API key.`,
    "  Do not paste a publishable or anon key.",
    "",
    "  If Supabase redirects to Organizations, sign in with an account",
    `  that can access project ${projectRef}.`,
    ""
  ].join("\n");
}

export function formatManagementTokenGuide(project: string): string {
  const tokenName = supadrumCredentialName(project);
  return [
    "Management token",
    "",
    "  What:",
    "  A Supabase Personal Access Token for Management API and CLI.",
    "  It belongs to your account, not to one project, and normally",
    "  starts with sbp_. It can act on every project your account can access.",
    "",
    "  Open:",
    "  https://supabase.com/dashboard/account/tokens",
    "",
    "  Account → Access Tokens → Generate new token",
    `  Name it "${tokenName}", choose an expiration, then generate it.`,
    "  Copy the complete sbp_… token and paste it below.",
    "  Do not paste a project secret key or database password.",
    ""
  ].join("\n");
}

export function formatDatabaseAccessGuide(projectRef: string): string {
  return [
    "Database access",
    "",
    "  What:",
    "  The complete PostgreSQL connection string, including its password.",
    "  It starts with postgres:// or postgresql:// and is used for SQL,",
    "  migrations, dumps and other native database operations.",
    "",
    "  Open:",
    `  https://supabase.com/dashboard/project/${projectRef}`,
    "",
    "  Choose Connect → Direct connection → URI, then copy the string.",
    "  Replace [YOUR-PASSWORD] with the project's database password.",
    "  Paste the complete URI, not the password by itself.",
    "  URL-encode reserved password characters when required (for example",
    "  / as %2F, # as %23 and ? as %3F).",
    "  If Direct connection cannot use IPv6 on your network, choose",
    "  Session pooler on port 5432 instead.",
    "  Do not paste the project URL, a secret key or a transaction pooler URL.",
    "",
    "  Reset a forgotten password in Database → Settings:",
    `  https://supabase.com/dashboard/project/${projectRef}/database/settings`,
    ""
  ].join("\n");
}

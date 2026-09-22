import type { LocalPasswordAccount, ProjectConfig } from "./config.js";
import { parseLocalAdapterStatus, verifiedLocalKey } from "./local-adapter-tests.js";

export function registeredPasswordAccount(project: ProjectConfig, name: unknown): LocalPasswordAccount | undefined {
  return typeof name === "string" && project.auth_password_accounts &&
    Object.hasOwn(project.auth_password_accounts, name)
    ? project.auth_password_accounts[name] : undefined;
}

export function passwordAccountRequest(project: ProjectConfig, payload: Record<string, unknown>) {
  if (project.target !== "local" || project.mode !== "live") {
    throw new Error("Supabase password accounts require a live local chamber");
  }
  if (payload.adapter !== "supabase-password" || payload.action !== "upsert" ||
    Object.keys(payload).some((key) => !["adapter", "action", "account"].includes(key))) {
    throw new Error("Unsupported local auth admin action or adapter");
  }
  const account = registeredPasswordAccount(project, payload.account);
  if (!account) throw new Error("Local password account is not registered");
  return { name: payload.account as string, account };
}

export function validateLocalPasswordStatus(status: Record<string, unknown>) {
  const { apiUrl, anonKey, jwtSecret } = parseLocalAdapterStatus(status);
  const fields = Object.fromEntries(Object.entries(status).map(([key, value]) =>
    [key.toLowerCase().replaceAll("_", " "), value]));
  const rawServiceKey = fields["service role key"];
  if (typeof rawServiceKey !== "string") throw new Error("Local status has no service role key");
  return { apiUrl, anonKey, jwtSecret, serviceKey: verifiedLocalKey(rawServiceKey, jwtSecret, "service_role") };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Normalize the minimal seed row so GoTrue can find it by instance and audience. */
export function placeholderReconciliationSql(account: LocalPasswordAccount): string {
  const id = sqlLiteral(account.user_id);
  const email = sqlLiteral(account.email);
  return `begin;
do $supadrum$
begin
  if (select count(*) from auth.users
      where id = ${id}::uuid and lower(email) = lower(${email})) <> 1 then
    raise exception 'Registered Auth placeholder is absent or mismatched';
  end if;
  if (select count(*) from public.users
      where auth_user_id = ${id}::uuid and lower(email) = lower(${email})) <> 1 then
    raise exception 'Registered Auth placeholder is not linked to one application user';
  end if;
  if exists (select 1 from auth.users where id = ${id}::uuid
      and ((instance_id is not null and instance_id <> '00000000-0000-0000-0000-000000000000'::uuid)
        or (aud is not null and aud <> 'authenticated')
        or (role is not null and role <> 'authenticated')
        or is_sso_user = true or is_anonymous = true)) then
    raise exception 'Registered Auth placeholder has incompatible login fields';
  end if;
  update auth.users set
    instance_id = coalesce(instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
    aud = coalesce(aud, 'authenticated'),
    role = coalesce(role, 'authenticated'),
    confirmation_token = coalesce(confirmation_token, ''),
    recovery_token = coalesce(recovery_token, ''),
    email_change_token_current = coalesce(email_change_token_current, ''),
    email_change_token_new = coalesce(email_change_token_new, ''),
    email_change = coalesce(email_change, ''),
    phone_change_token = coalesce(phone_change_token, ''),
    phone_change = coalesce(phone_change, ''),
    reauthentication_token = coalesce(reauthentication_token, ''),
    email_change_confirm_status = coalesce(email_change_confirm_status, 0),
    raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb),
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb),
    is_sso_user = coalesce(is_sso_user, false),
    is_anonymous = coalesce(is_anonymous, false),
    created_at = coalesce(created_at, now()),
    updated_at = coalesce(updated_at, now())
  where id = ${id}::uuid;
end
$supadrum$;
commit;
`;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local Auth response");
  return value as Record<string, unknown>;
}

async function safeAuthFailure(response: Response): Promise<string> {
  try {
    const body = jsonObject(await response.json());
    const code = body.error_code;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
      ? ` (${response.status}, ${code})` : ` (${response.status})`;
  } catch { return ` (${response.status})`; }
}

function matchingAccessTokenClaims(token: unknown, userId: string): boolean {
  if (typeof token !== "string") return false;
  const [header, payload, signature, extra] = token.split(".");
  if (!header || !payload || !signature || extra) return false;
  try {
    const claims = jsonObject(JSON.parse(Buffer.from(payload, "base64url").toString()));
    return claims.sub === userId && claims.role === "authenticated" &&
      typeof claims.exp === "number" && claims.exp > Date.now() / 1000;
  } catch { return false; }
}

/** All Auth traffic stays inside the broker and on the verified local API URL. */
export async function upsertLocalPasswordAccount(
  account: LocalPasswordAccount,
  password: string,
  status: Record<string, unknown>,
  request: typeof fetch
): Promise<void> {
  const { apiUrl, anonKey, serviceKey } = validateLocalPasswordStatus(status);
  if (password.length < 12) throw new Error("Local Auth password in vault is too short");
  const adminUrl = `${apiUrl}/auth/v1/admin/users/${encodeURIComponent(account.user_id)}`;
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const options = { redirect: "error" as const, cache: "no-store" as const };
  let found: Response;
  try { found = await request(adminUrl, { ...options, method: "GET", headers: adminHeaders }); }
  catch { throw new Error("Local Auth account lookup failed"); }
  if (!found.ok) throw new Error(`Local Auth placeholder lookup failed${await safeAuthFailure(found)}`);
  const existing = jsonObject(await found.json());
  if (existing.id !== account.user_id || typeof existing.email !== "string" ||
    existing.email.toLowerCase() !== account.email.toLowerCase()) {
    throw new Error("Local Auth placeholder does not match registered account");
  }
  let updated: Response;
  try {
    updated = await request(adminUrl, { ...options, method: "PUT", headers: adminHeaders,
      body: JSON.stringify({ email: account.email, password, email_confirm: true }) });
  } catch { throw new Error("Local Auth account update failed"); }
  if (!updated.ok) throw new Error(`Local Auth account update failed${await safeAuthFailure(updated)}`);
  const user = jsonObject(await updated.json());
  if (user.id !== account.user_id || typeof user.email !== "string" ||
    user.email.toLowerCase() !== account.email.toLowerCase()) {
    throw new Error("Local Auth update returned the wrong account");
  }
  if (!Array.isArray(user.identities) || !user.identities.some((identity: unknown) => {
    const value = identity && typeof identity === "object" ? identity as Record<string, unknown> : {};
    return value.provider === "email" && value.user_id === account.user_id;
  })) {
    throw new Error("Local Auth email identity is absent");
  }
  let login: Response;
  try {
    login = await request(`${apiUrl}/auth/v1/token?grant_type=password`, {
      ...options, method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, password })
    });
  } catch { throw new Error("Local Auth password login verification failed"); }
  if (!login.ok) throw new Error(`Local Auth password login verification failed${await safeAuthFailure(login)}`);
  const session = jsonObject(await login.json());
  const sessionUser = jsonObject(session.user);
  if (sessionUser.id !== account.user_id || !matchingAccessTokenClaims(session.access_token, account.user_id)) {
    throw new Error("Local Auth password login verification failed");
  }
  let authenticated: Response;
  try {
    authenticated = await request(`${apiUrl}/auth/v1/user`, {
      ...options, method: "GET", headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}` }
    });
  } catch { throw new Error("Local Auth bearer verification failed"); }
  if (!authenticated.ok) throw new Error(`Local Auth bearer verification failed${await safeAuthFailure(authenticated)}`);
  if (jsonObject(await authenticated.json()).id !== account.user_id) {
    throw new Error("Local Auth bearer belongs to another user");
  }
}

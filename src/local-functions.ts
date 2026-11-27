import { parseLocalAdapterStatus, syntheticJwt } from "./local-adapter-tests.js";
import type { ProjectConfig } from "./config.js";
import { LocalFunctionPayload } from "./local-edge-payload.js";

const MAX_BYTES = 64 * 1024;

/** Invokes a function explicitly registered by the operator on the local gateway. */
export async function invokeLocalFunction(project: ProjectConfig, payload: unknown,
  status: Record<string, unknown>, fetcher: typeof fetch) {
  if (project.target !== "local" || project.mode !== "live" || !project.capabilities.includes("edge-functions")) {
    throw new Error("Local function invocation requires the edge-functions capability");
  }
  const input = LocalFunctionPayload.parse(payload);
  if (!project.local_functions || !Object.hasOwn(project.local_functions, input.name)) {
    throw new Error("Local function is not registered");
  }
  const registration = project.local_functions[input.name]!;
  const { apiUrl, anonKey, jwtSecret } = parseLocalAdapterStatus(status);
  const accounts = project.auth_password_accounts ?? {};
  const account = registration.identity === "account" && Object.hasOwn(accounts, registration.account)
    ? accounts[registration.account] : null;
  if (registration.identity === "account" && !account) throw new Error("Local function account is not registered");
  const bearer = account ? syntheticJwt(jwtSecret, account.user_id) : anonKey;
  const body = JSON.stringify(input.body ?? {});
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Local function request is too large");
  let response: Response;
  try {
    response = await fetcher(`${apiUrl}/functions/v1/${input.name}`, { method: "POST", body,
      headers: { apikey: anonKey, authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error("Local function request failed"); }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Do not expose stream errors. */ }
    throw new Error(`Local function returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  let size = 0;
  if (reader) try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Local function response is too large"); }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Local function response is too large") throw error;
    throw new Error("Local function response failed");
  } finally { reader.releaseLock(); }
  return { status: response.status, response_bytes: size };
}

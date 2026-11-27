import { z } from "zod";

/** Invoke an operator-registered local function without accepting headers or URLs. */
export const LocalFunctionPayload = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  body: z.record(z.string(), z.unknown()).optional()
}).strict();

/** Check registered secret names without carrying credential material. */
export const LocalSecretCheckPayload = z.object({ names: z.array(z.string().regex(/^(?!SUPABASE_)[A-Z][A-Z0-9_]*$/))
  .min(1).max(100).refine(names => new Set(names).size === names.length) }).strict();

/** A local secret update restarts the runtime as one unit, so it must name every registered secret. */
export function localSecretUpdate(payload: unknown, registered: readonly string[]): string[] {
  const { names } = LocalSecretCheckPayload.parse(payload);
  if (names.length !== registered.length || names.some(name => !registered.includes(name))) {
    throw new Error("Local secret updates must cover the entire runtime configuration");
  }
  return names;
}

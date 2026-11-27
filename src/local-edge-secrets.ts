import { MissingCredentialsError } from "./runner.js";

/** Resolves only registered names; failures disclose names, never values or references. */
export async function resolveLocalSecrets(names: readonly string[], references: Record<string, string>,
  resolve: (reference: string) => Promise<string>): Promise<Record<string, string>> {
  if (!names.length || new Set(names).size !== names.length || names.some(name => !/^(?!SUPABASE_)[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error("Invalid local secret names");
  }
  const missing = names.filter(name => !Object.hasOwn(references, name) || !references[name]);
  if (missing.length) throw new MissingCredentialsError(missing);
  const result: Record<string, string> = {};
  for (const name of names) {
    try {
      const value = await resolve(references[name]!);
      if (!value || value.includes("\0")) throw new Error();
      result[name] = value;
    } catch { throw new MissingCredentialsError([name]); }
  }
  return result;
}

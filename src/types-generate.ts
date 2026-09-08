import { z } from "zod";

/**
 * Payload of `types.generate`: which schema to read and where, inside the
 * project repository, the generated TypeScript must be written.
 */
export const TypesGeneratePayloadSchema = z.object({
  output: z.string().min(1).max(500),
  schema: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, "schema must be a plain PostgreSQL identifier")
    .max(63)
    .default("public")
});

export type TypesGeneratePayload = z.infer<typeof TypesGeneratePayloadSchema>;

export function parseTypesGeneratePayload(
  payload: unknown
): TypesGeneratePayload {
  return TypesGeneratePayloadSchema.parse(payload);
}

import { z } from "zod";

/** Most exact object paths one `storage.admin` delete may name. */
export const STORAGE_DELETE_LIMIT = 100;

/**
 * One path segment (a bucket or one part of an object name) that can neither
 * move a local path nor start a different one: not empty, not `.` or `..`,
 * no `/` and no control characters.
 */
export function safeSegment(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." &&
    !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value);
}

const bucket = z.string().min(1).max(255)
  .refine(safeSegment, "bucket is not a plain name");
/** Storage routes under `/object/`: a bucket by that name would turn an upload or delete into one of them. */
const ROUTES = new Set(["sign", "upload", "list", "info", "public", "authenticated", "move", "copy"]);
const writableBucket = bucket.refine((value) => !ROUTES.has(value.toLowerCase()), "bucket name is a Storage route");
const objectPath = z.string().min(1).max(1024)
  .refine((value) => value.split("/").every(safeSegment), "object must be an exact path, not a prefix");
const dest = z.string().min(1).max(500);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

const TOKEN = String.raw`[\w!#$&^.+-]+`;
const CONTENT_TYPE = new RegExp(
  `^${TOKEN}/${TOKEN}(?:\\s*;\\s*${TOKEN}=(?:"[^"\\r\\n]*"|${TOKEN}))*$`
);

/**
 * Payload of `storage.admin`. Buckets are read-only: no action creates,
 * changes or deletes one. Object paths and contents never come back in the
 * job result, they only land in files under a git-ignored `dest`.
 */
export const StorageAdminPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), dest: dest.optional() }).strict(),
  z.object({
    action: z.literal("download"),
    dest,
    buckets: z.array(bucket).min(1).refine(unique, "buckets must be distinct").optional()
  }).strict(),
  z.object({
    action: z.literal("upload"),
    bucket: writableBucket,
    object: objectPath,
    path: z.string().min(1).max(500),
    digest: z.string().regex(/^[0-9a-f]{64}$/, "digest must be a lowercase sha256"),
    content_type: z.string().min(1).max(255).regex(CONTENT_TYPE, "content_type must be a media type"),
    upsert: z.boolean().optional()
  }).strict(),
  z.object({
    action: z.literal("delete"),
    bucket: writableBucket,
    objects: z.array(objectPath.refine((value) => !/[*?]/.test(value), "no wildcards"))
      .min(1)
      .max(STORAGE_DELETE_LIMIT, `at most ${STORAGE_DELETE_LIMIT} objects per job`)
      .refine(unique, "objects must be distinct"),
    dest
  }).strict()
]);

export type StorageAdminPayload = z.infer<typeof StorageAdminPayloadSchema>;

/** Throws an error that names the offending keys but never echoes a value. */
export function parseStorageAdminPayload(payload: unknown): StorageAdminPayload {
  const parsed = StorageAdminPayloadSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid storage.admin payload (${issues})`);
}

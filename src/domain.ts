import { z } from "zod";

import {
  capabilityNames,
  operationNames,
  type Capability,
  type Operation
} from "./catalog.js";
import { MigrationBaselinePayloadSchema } from "./prisma-baseline.js";
import { SchemaInspectionPayloadSchema } from "./schema-inspection.js";
import { StorageAdminPayloadSchema } from "./storage-payload.js";
import { TypesGeneratePayloadSchema } from "./types-generate.js";

export const jobStatusNames = [
  "queued",
  "waiting_credentials",
  "waiting_approval",
  "granted",
  "running",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "lease_expired"
] as const;

export type JobStatus = (typeof jobStatusNames)[number];
export type JobOperation = Operation | "session.open";

export const terminalJobStatuses = [
  "completed",
  "failed",
  "cancelled",
  "lease_expired"
] as const satisfies readonly JobStatus[];

export const CapabilitySchema = z.enum(capabilityNames);
export const OperationSchema = z.enum(operationNames);
export const JobStatusSchema = z.enum(jobStatusNames);

const sensitiveKey =
  /(^|_)(secret|token|password|credential|database_url|service_role|api_key)($|_)/i;

function findSensitiveKey(value: unknown, path: string[] = []): string | null {
  if (
    typeof value === "string" &&
    /^(vault:\/\/|postgres(?:ql)?:\/\/)/i.test(value)
  ) {
    return path.join(".") || "payload";
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSensitiveKey(item, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = [...path, key];
      if (sensitiveKey.test(key.replace(/([a-z])([A-Z])/g, "$1_$2"))) {
        return nextPath.join(".");
      }
      const found = findSensitiveKey(item, nextPath);
      if (found) return found;
    }
  }

  return null;
}

export const CredentialFreePayloadSchema = z
  .record(z.string(), z.unknown())
  .superRefine((payload, context) => {
    const key = findSensitiveKey(payload);
    if (key) {
      context.addIssue({
        code: "custom",
        message: `Credential material is forbidden in job payloads (${key})`
      });
    }
  });

const AdapterTestsPayloadSchema = z.object({
  script: z.string().regex(/^[a-z][a-z0-9._-]*$/),
  setup_job_id: z.uuid().optional()
}).strict();

// A pgTAP run or a served stack is fully described by the project and the
// tree: the caller chooses nothing, so any key at all is a mistake (#41).
const PgtapPayloadSchema = z.object({}).strict();
const TREE_OPERATIONS = ["pgtap.run", "stack.serve"] as const;

// repo_sha carries the tree OID the hook staged (#41). A prefix, a branch or
// HEAD would be resolved against whatever the repository holds later.
export const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export const JobSubmissionSchema = z
  .object({
    project: z.string().min(1).max(100),
    operation: OperationSchema,
    payload: CredentialFreePayloadSchema.default({}),
    repo_sha: z.string().min(6).max(64),
    idempotency_key: z.string().min(1).max(255)
  })
  .superRefine((submission, context) => {
    if (
      (TREE_OPERATIONS as readonly string[]).includes(submission.operation) &&
      !FULL_OBJECT_NAME.test(submission.repo_sha)
    ) {
      context.addIssue({
        code: "custom",
        path: ["repo_sha"],
        message: `${submission.operation} needs the full tree object name (40 or 64 hex characters)`
      });
    }
    const schema =
      submission.operation === "schema.inspect"
        ? SchemaInspectionPayloadSchema
        : submission.operation === "tests.run"
          ? AdapterTestsPayloadSchema
        : submission.operation === "pgtap.run" || submission.operation === "stack.serve"
          ? PgtapPayloadSchema
        : submission.operation === "migration.baseline"
          ? MigrationBaselinePayloadSchema
          : submission.operation === "types.generate"
            ? TypesGeneratePayloadSchema
            : submission.operation === "storage.admin"
              ? StorageAdminPayloadSchema
              : null;
    if (!schema) return;
    const parsed = schema.safeParse(submission.payload);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["payload", ...issue.path],
        message: issue.message
      });
    }
  });

export type JobSubmission = z.infer<typeof JobSubmissionSchema>;

export interface Job extends Omit<JobSubmission, "operation"> {
  readonly id: string;
  readonly operation: JobOperation;
  readonly capability: Capability;
  readonly requires_approval: boolean;
  readonly session_id: string | null;
  readonly status: JobStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly lease_expires_at: string | null;
  readonly approved_at: string | null;
  readonly approved_by: string | null;
  readonly result: unknown | null;
  readonly error: string | null;
}

export interface JobEvent {
  readonly cursor: number;
  readonly job_id: string;
  readonly status: JobStatus;
  readonly detail: unknown | null;
  readonly created_at: string;
}

export interface ExecutionResult {
  readonly output: unknown;
  readonly verification: unknown;
}

export interface Session {
  readonly id: string;
  readonly project: string;
  readonly capability: Capability;
  readonly status: "queued" | "active" | "closing" | "closed" | "lease_expired";
  readonly open_job_id: string;
  readonly created_at: string;
  readonly heartbeat_at: string;
  readonly expires_at: string | null;
  readonly ttl_ms: number;
  readonly repo_sha: string;
}

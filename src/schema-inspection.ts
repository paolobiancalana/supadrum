import { z } from "zod";

function utf8String(maximum: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximum,
      `Must be at most ${maximum} UTF-8 bytes`
    );
}

const IdentifierSchema = utf8String(63);
const ArgumentTypeSchema = utf8String(255);
const PolicyCommandSchema = z.enum([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "ALL"
]);
const SchemaPrivilegeNameSchema = z.enum(["USAGE", "CREATE"]);
const RelationPrivilegeNameSchema = z.enum([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN"
]);
const UniqueRolesSchema = z
  .array(IdentifierSchema)
  .min(1)
  .max(16)
  .superRefine((roles, context) => {
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: "custom",
        message: "Roles must be unique"
      });
    }
  });

const MigrationCheckSchema = z.strictObject({
  kind: z.literal("migration"),
  version: z.string().regex(/^[0-9]{1,64}$/)
});

const RelationCheckSchema = z.strictObject({
  kind: z.literal("relation"),
  schema: IdentifierSchema,
  name: IdentifierSchema
});

const ColumnCheckSchema = z.strictObject({
  kind: z.literal("column"),
  schema: IdentifierSchema,
  relation: IdentifierSchema,
  name: IdentifierSchema
});

const TriggerCheckSchema = z.strictObject({
  kind: z.literal("trigger"),
  schema: IdentifierSchema,
  relation: IdentifierSchema,
  name: IdentifierSchema
});

const RoutineCheckSchema = z.strictObject({
  kind: z.literal("routine"),
  schema: IdentifierSchema,
  name: IdentifierSchema,
  argument_types: z.array(ArgumentTypeSchema).max(64)
});

const RowSecurityCheckSchema = z.strictObject({
  kind: z.literal("row-security"),
  schema: IdentifierSchema,
  relation: IdentifierSchema,
  enabled: z.boolean(),
  force: z.boolean(),
  roles_without_bypass: UniqueRolesSchema
});

const PolicyCheckSchema = z.strictObject({
  kind: z.literal("policy"),
  schema: IdentifierSchema,
  relation: IdentifierSchema,
  name: IdentifierSchema,
  command: PolicyCommandSchema,
  roles: UniqueRolesSchema,
  permissive: z.boolean()
});

const SchemaPrivilegeCheckSchema = z.strictObject({
  kind: z.literal("schema-privilege"),
  schema: IdentifierSchema,
  role: IdentifierSchema,
  privilege: SchemaPrivilegeNameSchema,
  granted: z.boolean()
});

const RelationPrivilegeCheckSchema = z.strictObject({
  kind: z.literal("relation-privilege"),
  schema: IdentifierSchema,
  relation: IdentifierSchema,
  role: IdentifierSchema,
  privilege: RelationPrivilegeNameSchema,
  granted: z.boolean()
});

const RoutinePrivilegeCheckSchema = z.strictObject({
  kind: z.literal("routine-privilege"),
  schema: IdentifierSchema,
  name: IdentifierSchema,
  argument_types: z.array(ArgumentTypeSchema).max(64),
  role: IdentifierSchema,
  privilege: z.literal("EXECUTE"),
  granted: z.boolean()
});

export const SchemaInspectionCheckSchema = z.discriminatedUnion(
  "kind",
  [
    MigrationCheckSchema,
    RelationCheckSchema,
    ColumnCheckSchema,
    TriggerCheckSchema,
    RoutineCheckSchema,
    RowSecurityCheckSchema,
    PolicyCheckSchema,
    SchemaPrivilegeCheckSchema,
    RelationPrivilegeCheckSchema,
    RoutinePrivilegeCheckSchema
  ]
);

export const SchemaInspectionPayloadSchema = z
  .strictObject({
    checks: z.array(SchemaInspectionCheckSchema).min(1).max(100)
  })
  .superRefine((payload, context) => {
    if (
      Buffer.byteLength(JSON.stringify(payload.checks), "utf8") >
      65_536
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message:
          "Serialized checks must be at most 65536 UTF-8 bytes"
      });
    }
  });

export type SchemaInspectionCheck = z.infer<
  typeof SchemaInspectionCheckSchema
>;
export type SchemaInspectionPayload = z.infer<
  typeof SchemaInspectionPayloadSchema
>;

const ResultBaseFields = {
  index: z.number().int().min(0),
  target: z.string().min(1),
  present: z.boolean()
} as const;

const RelationResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("relation"),
  relation_kind: z.string().min(1).optional()
});

const ColumnResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("column"),
  data_type: z.string().min(1).optional(),
  nullable: z.boolean().optional()
});

const TriggerResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("trigger"),
  enabled: z.boolean().optional()
});

const RoutineResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("routine"),
  identity_arguments: z.string().optional()
});

const RowSecurityResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("row-security"),
  enabled: z.boolean().optional(),
  force: z.boolean().optional(),
  roles: z.array(z.strictObject({
    role: IdentifierSchema,
    bypasses_rls: z.boolean()
  })).optional()
});

const PolicyResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("policy"),
  command: PolicyCommandSchema.optional(),
  roles: UniqueRolesSchema.optional(),
  permissive: z.boolean().optional(),
  using_present: z.boolean().optional(),
  with_check: z
    .enum(["explicit", "inherited", "not-applicable"])
    .optional()
});

const SchemaPrivilegeResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("schema-privilege"),
  role: IdentifierSchema,
  privilege: SchemaPrivilegeNameSchema,
  granted: z.boolean().optional()
});

const RelationPrivilegeResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("relation-privilege"),
  role: IdentifierSchema,
  privilege: RelationPrivilegeNameSchema,
  granted: z.boolean().optional()
});

const RoutinePrivilegeResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("routine-privilege"),
  identity_arguments: z.string().optional(),
  role: IdentifierSchema,
  privilege: z.literal("EXECUTE"),
  granted: z.boolean().optional()
});

const MigrationResultSchema = z.strictObject({
  ...ResultBaseFields,
  kind: z.literal("migration"),
  history_available: z.boolean()
});

const CatalogCheckResultSchema = z.discriminatedUnion("kind", [
  RelationResultSchema,
  ColumnResultSchema,
  TriggerResultSchema,
  RoutineResultSchema,
  RowSecurityResultSchema,
  PolicyResultSchema,
  SchemaPrivilegeResultSchema,
  RelationPrivilegeResultSchema,
  RoutinePrivilegeResultSchema
]);

const SchemaInspectionCheckResultSchema = z.discriminatedUnion(
  "kind",
  [
    RelationResultSchema,
    ColumnResultSchema,
    TriggerResultSchema,
    RoutineResultSchema,
    RowSecurityResultSchema,
    PolicyResultSchema,
    SchemaPrivilegeResultSchema,
    RelationPrivilegeResultSchema,
    RoutinePrivilegeResultSchema,
    MigrationResultSchema
  ]
);

const CatalogInspectionOutputSchema = z.strictObject({
  migration_history_available: z.boolean(),
  checks: z.array(CatalogCheckResultSchema)
});

const MigrationInspectionOutputSchema = z.strictObject({
  checks: z.array(MigrationResultSchema)
});

export type CatalogInspectionOutput = z.infer<
  typeof CatalogInspectionOutputSchema
>;
export type MigrationInspectionOutput = z.infer<
  typeof MigrationInspectionOutputSchema
>;
export type SchemaInspectionCheckResult = z.infer<
  typeof SchemaInspectionCheckResultSchema
>;

export interface SchemaInspectionResult {
  readonly compatible: boolean;
  readonly scope: {
    readonly requested_checks: number;
    readonly meaning: string;
  };
  readonly checks: readonly SchemaInspectionCheckResult[];
}

export function parseSchemaInspectionPayload(
  payload: unknown
): SchemaInspectionPayload {
  return SchemaInspectionPayloadSchema.parse(payload);
}

export function schemaInspectionPsqlInput(
  payload: SchemaInspectionPayload,
  sql: string
): string {
  const encodedChecks = Buffer.from(
    JSON.stringify(payload.checks),
    "utf8"
  ).toString("base64");
  return (
    `\\set supadrum_schema_checks_base64 ${encodedChecks}\n` +
    sql
  );
}

function parseOutput<T>(
  stdout: string,
  label: string,
  schema: z.ZodType<T>
): T {
  const source = stdout.trim();
  if (source.length === 0 || source.includes("\n")) {
    throw new Error(`Invalid ${label} inspection output`);
  }
  try {
    return schema.parse(JSON.parse(source));
  } catch {
    throw new Error(`Invalid ${label} inspection output`);
  }
}

export function parseCatalogInspection(
  stdout: string
): CatalogInspectionOutput {
  return parseOutput(
    stdout,
    "catalog",
    CatalogInspectionOutputSchema
  );
}

export function parseMigrationInspection(
  stdout: string
): MigrationInspectionOutput {
  return parseOutput(
    stdout,
    "migration",
    MigrationInspectionOutputSchema
  );
}

function migrationTarget(check: SchemaInspectionCheck): string {
  if (check.kind !== "migration") {
    throw new Error("Expected a migration check");
  }
  return check.version;
}

export function assembleSchemaInspection(
  payload: SchemaInspectionPayload,
  catalog: CatalogInspectionOutput,
  migrations: MigrationInspectionOutput | null
): SchemaInspectionResult {
  const catalogByIndex = new Map<
    number,
    CatalogInspectionOutput["checks"][number]
  >();
  for (const check of catalog.checks) {
    const requested = payload.checks[check.index];
    if (
      !requested ||
      requested.kind === "migration" ||
      requested.kind !== check.kind ||
      catalogByIndex.has(check.index)
    ) {
      throw new Error(
        `Unexpected catalog inspection result for check ${check.index}`
      );
    }
    catalogByIndex.set(check.index, check);
  }

  const migrationsByIndex = new Map<
    number,
    MigrationInspectionOutput["checks"][number]
  >();
  for (const check of migrations?.checks ?? []) {
    const requested = payload.checks[check.index];
    if (
      !requested ||
      requested.kind !== "migration" ||
      migrationsByIndex.has(check.index)
    ) {
      throw new Error(
        `Unexpected migration inspection result for check ${check.index}`
      );
    }
    migrationsByIndex.set(check.index, check);
  }

  const checks = payload.checks.map(
    (requested, index): SchemaInspectionCheckResult => {
      if (requested.kind === "migration") {
        if (!catalog.migration_history_available) {
          return {
            index,
            kind: "migration",
            target: migrationTarget(requested),
            present: false,
            history_available: false
          };
        }
        const result = migrationsByIndex.get(index);
        if (!result) {
          throw new Error(
            `Missing migration inspection result for check ${index}`
          );
        }
        return result;
      }
      const result = catalogByIndex.get(index);
      if (!result || result.kind !== requested.kind) {
        throw new Error(
          `Missing catalog inspection result for check ${index}`
        );
      }
      return result;
    }
  );

  return {
    compatible: checks.every((check) => check.present),
    scope: {
      requested_checks: payload.checks.length,
      meaning:
        "Compatibility applies only to the requested checks"
    },
    checks
  };
}

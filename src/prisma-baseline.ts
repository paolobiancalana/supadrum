import { z } from "zod";

const MAX_BASELINE_PAYLOAD_BYTES = 65_536;

const MigrationNameSchema = z.string().min(1).superRefine(
  (name, context) => {
    if (Buffer.byteLength(name, "utf8") > 255) {
      context.addIssue({
        code: "custom",
        message: "Migration names must be at most 255 UTF-8 bytes"
      });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      context.addIssue({
        code: "custom",
        message: "Migration name contains unsupported characters"
      });
    }
  }
);

export const MigrationBaselinePayloadSchema = z
  .object({
    migrations: z
      .array(MigrationNameSchema)
      .min(1, "Migration list must contain at least 1 entry")
      .max(100, "Migration list must contain at most 100 entries")
      .superRefine((migrations, context) => {
        if (new Set(migrations).size !== migrations.length) {
          context.addIssue({
            code: "custom",
            message: "Migration names must be unique"
          });
        }
      })
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      Buffer.byteLength(JSON.stringify(payload), "utf8") >
      MAX_BASELINE_PAYLOAD_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Migration baseline payload must be at most 65,536 UTF-8 bytes"
      });
    }
  });

export type MigrationBaselinePayload = z.infer<
  typeof MigrationBaselinePayloadSchema
>;

export interface LocalPrismaMigration {
  readonly name: string;
  readonly checksum: string;
}

export interface PrismaMigrationHistoryRow {
  readonly migration_name: string;
  readonly checksum: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly rolled_back_at: string | null;
  readonly logs: string | null;
}

export interface BaselineHistoryPlan {
  readonly alreadyApplied: readonly string[];
  readonly missing: readonly string[];
}

const PrismaHistoryAvailabilitySchema = z.strictObject({
  available: z.boolean()
});

const PrismaMigrationHistoryRowSchema = z.strictObject({
  migration_name: z.string().min(1),
  checksum: z.string().min(1),
  started_at: z.string().min(1),
  finished_at: z.string().min(1).nullable(),
  rolled_back_at: z.string().min(1).nullable(),
  logs: z.string().nullable()
});

const PrismaMigrationHistoryOutputSchema = z.strictObject({
  rows: z.array(PrismaMigrationHistoryRowSchema)
});

export function parseMigrationBaselinePayload(
  payload: unknown
): MigrationBaselinePayload {
  return MigrationBaselinePayloadSchema.parse(payload);
}

function parsePrismaOutput<T>(
  stdout: string,
  schema: z.ZodType<T>,
  label: string
): T {
  const source = stdout.trim();
  if (source.length === 0 || source.includes("\n")) {
    throw new Error(`Invalid ${label} output`);
  }
  try {
    return schema.parse(JSON.parse(source));
  } catch {
    throw new Error(`Invalid ${label} output`);
  }
}

export function parsePrismaHistoryAvailability(
  stdout: string
): boolean {
  return parsePrismaOutput(
    stdout,
    PrismaHistoryAvailabilitySchema,
    "Prisma migration history availability"
  ).available;
}

export function parsePrismaHistoryRows(
  stdout: string
): PrismaMigrationHistoryRow[] {
  return parsePrismaOutput(
    stdout,
    PrismaMigrationHistoryOutputSchema,
    "Prisma migration history"
  ).rows;
}

export function validateMigrationPrefix(
  requested: readonly string[],
  repositoryMigrations: readonly string[]
): readonly string[] {
  if (
    requested.some(
      (migration, index) => repositoryMigrations[index] !== migration
    )
  ) {
    throw new Error(
      "Requested migrations must form a contiguous prefix of repository migrations"
    );
  }
  return [...requested];
}

export function analyzeMigrationHistory(
  localPrefix: readonly LocalPrismaMigration[],
  rows: readonly PrismaMigrationHistoryRow[]
): BaselineHistoryPlan {
  for (const [index, row] of rows.entries()) {
    const expected = localPrefix[index];
    if (
      !expected ||
      !localPrefix.some(
        (migration) => migration.name === row.migration_name
      )
    ) {
      throw new Error(
        `Migration ${row.migration_name} is outside the requested prefix`
      );
    }
    if (row.rolled_back_at !== null) {
      throw new Error(`Migration ${row.migration_name} was rolled back`);
    }
    if (row.finished_at === null) {
      throw new Error(`Migration ${row.migration_name} is not completed`);
    }
    if (row.migration_name !== expected.name) {
      throw new Error(
        `Migration history order mismatch: expected ${expected.name}, got ${row.migration_name}`
      );
    }
    if (row.checksum !== expected.checksum) {
      throw new Error(
        `Migration ${row.migration_name} checksum mismatch`
      );
    }
  }

  return {
    alreadyApplied: rows.map(({ migration_name }) => migration_name),
    missing: localPrefix
      .slice(rows.length)
      .map(({ name }) => name)
  };
}

import { describe, expect, test } from "vitest";

import { JobSubmissionSchema } from "../src/domain.js";
import {
  analyzeMigrationHistory,
  parsePrismaHistoryAvailability,
  parsePrismaHistoryRows,
  parseMigrationBaselinePayload,
  validateMigrationPrefix,
  type LocalPrismaMigration,
  type PrismaMigrationHistoryRow
} from "../src/prisma-baseline.js";
import {
  PRISMA_BASELINE_HISTORY_SQL,
  PRISMA_HISTORY_AVAILABILITY_SQL
} from "../src/prisma-baseline-sql.js";

const localMigrations: readonly LocalPrismaMigration[] = [
  { name: "001_init", checksum: "checksum-001" },
  { name: "002_rls", checksum: "checksum-002" },
  { name: "003_api", checksum: "checksum-003" }
];

function completed(
  migration_name: string,
  checksum: string,
  started_at = "2026-07-30T00:00:00.000Z"
): PrismaMigrationHistoryRow {
  return {
    migration_name,
    checksum,
    started_at,
    finished_at: "2026-07-30T00:00:01.000Z",
    rolled_back_at: null,
    logs: null
  };
}

describe("Prisma baseline payload", () => {
  test("accepts an explicit credential-free migration prefix", () => {
    expect(
      parseMigrationBaselinePayload({
        migrations: ["001_init", "002_rls"]
      })
    ).toEqual({
      migrations: ["001_init", "002_rls"]
    });

    expect(
      JobSubmissionSchema.parse({
        project: "example-service",
        operation: "migration.baseline",
        payload: { migrations: ["001_init", "002_rls"] },
        repo_sha: "abc123",
        idempotency_key: "example-service:abc123:baseline:2"
      }).operation
    ).toBe("migration.baseline");
  });

  test.each([
    [{ migrations: [] }, "at least 1"],
    [
      { migrations: Array.from({ length: 101 }, (_, index) => `m_${index}`) },
      "at most 100"
    ],
    [{ migrations: ["001_init", "001_init"] }, "unique"],
    [{ migrations: ["../001_init"] }, "unsupported"],
    [{ migrations: [`001_${"x".repeat(252)}`] }, "255 UTF-8 bytes"],
    [{ migrations: ["001_init"], extra: true }, "Unrecognized key"]
  ])("rejects malformed payload %#", (payload, message) => {
    expect(() => parseMigrationBaselinePayload(payload)).toThrow(message);
  });
});

describe("Prisma baseline prefix", () => {
  test("accepts only the exact contiguous repository prefix", () => {
    expect(
      validateMigrationPrefix(
        ["001_init", "002_rls"],
        ["001_init", "002_rls", "003_api"]
      )
    ).toEqual(["001_init", "002_rls"]);
  });

  test.each([
    [["001_init", "003_api"]],
    [["002_rls"]],
    [["002_rls", "001_init"]]
  ])("rejects a non-prefix request %#", (requested) => {
    expect(() =>
      validateMigrationPrefix(
        requested,
        ["001_init", "002_rls", "003_api"]
      )
    ).toThrow("contiguous prefix");
  });
});

describe("Prisma baseline history", () => {
  test("uses static read-only history queries with bounded timeouts", () => {
    for (const sql of [
      PRISMA_HISTORY_AVAILABILITY_SQL,
      PRISMA_BASELINE_HISTORY_SQL
    ]) {
      expect(sql).toContain("begin transaction read only");
      expect(sql).toContain("statement_timeout = '5s'");
      expect(sql).toContain("lock_timeout = '1s'");
      expect(sql).not.toMatch(/delete|insert|update/i);
    }
    expect(PRISMA_BASELINE_HISTORY_SQL).toContain(
      "from public._prisma_migrations"
    );
  });

  test("parses only a strict ordered migration-history result", () => {
    expect(
      parsePrismaHistoryAvailability('{"available":true}\n')
    ).toBe(true);
    expect(
      parsePrismaHistoryRows(JSON.stringify({
        rows: [
          completed("001_init", "checksum-001")
        ]
      }))
    ).toEqual([
      completed("001_init", "checksum-001")
    ]);
    expect(() =>
      parsePrismaHistoryRows('{"rows":[{"migration_name":"001"}]}')
    ).toThrow("Invalid Prisma migration history output");
    expect(() =>
      parsePrismaHistoryRows("not-json")
    ).toThrow("Invalid Prisma migration history output");
  });

  test("skips a verified completed prefix and returns only its missing suffix", () => {
    expect(
      analyzeMigrationHistory(localMigrations, [
        completed("001_init", "checksum-001")
      ])
    ).toEqual({
      alreadyApplied: ["001_init"],
      missing: ["002_rls", "003_api"]
    });
  });

  test("treats missing history as a completely missing suffix", () => {
    expect(analyzeMigrationHistory(localMigrations, [])).toEqual({
      alreadyApplied: [],
      missing: ["001_init", "002_rls", "003_api"]
    });
  });

  test.each([
    [
      [{
        ...completed("001_init", "checksum-001"),
        finished_at: null,
        logs: "database error"
      }],
      "not completed"
    ],
    [
      [{
        ...completed("001_init", "checksum-001"),
        finished_at: null,
        logs: null
      }],
      "not completed"
    ],
    [
      [{
        ...completed("001_init", "checksum-001"),
        rolled_back_at: "2026-07-30T00:00:02.000Z"
      }],
      "rolled back"
    ],
    [
      [completed("001_init", "different-checksum")],
      "checksum mismatch"
    ],
    [
      [completed("002_rls", "checksum-002")],
      "order mismatch"
    ],
    [
      [
        completed("001_init", "checksum-001"),
        completed("unexpected", "checksum-unexpected")
      ],
      "outside the requested prefix"
    ]
  ])("blocks unsafe history %#", (rows, message) => {
    expect(() =>
      analyzeMigrationHistory(
        localMigrations,
        rows as PrismaMigrationHistoryRow[]
      )
    ).toThrow(message);
  });
});

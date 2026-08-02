import { describe, expect, test } from "vitest";

import * as schemaInspection from "../src/schema-inspection.js";
import {
  assembleSchemaInspection,
  parseCatalogInspection,
  parseMigrationInspection,
  parseSchemaInspectionPayload,
  schemaInspectionPsqlInput
} from "../src/schema-inspection.js";
import {
  CATALOG_INSPECTION_SQL,
  MIGRATION_INSPECTION_SQL,
  SCHEMA_INSPECTION_PSQL_ARGS
} from "../src/schema-inspection-sql.js";

describe("schema inspection support", () => {
  test("exposes the static-query and result assembly boundary", async () => {
    const schemaInspectionSql = await import(
      "../src/schema-inspection-sql.js"
    ).catch(() => null);
    expect(typeof schemaInspection.schemaInspectionPsqlInput).toBe(
      "function"
    );
    expect(typeof schemaInspection.parseCatalogInspection).toBe(
      "function"
    );
    expect(typeof schemaInspection.parseMigrationInspection).toBe(
      "function"
    );
    expect(typeof schemaInspection.assembleSchemaInspection).toBe(
      "function"
    );
    expect(schemaInspectionSql).not.toBeNull();
    expect(
      schemaInspectionSql?.SCHEMA_INSPECTION_PSQL_ARGS
    ).toBeDefined();
    expect(schemaInspectionSql?.CATALOG_INSPECTION_SQL).toBeDefined();
    expect(schemaInspectionSql?.MIGRATION_INSPECTION_SQL).toBeDefined();
  });

  test("serializes validated checks into psql stdin without requiring getenv", () => {
    const payload = parseSchemaInspectionPayload({
      checks: [{
        kind: "relation",
        schema: "we'ird",
        name: "table"
      }]
    });

    const input = schemaInspectionPsqlInput(
      payload,
      CATALOG_INSPECTION_SQL
    );
    const firstLine = input.split("\n", 1)[0] as string;
    const encoded = firstLine.split(" ", 3)[2] as string;
    expect(firstLine).toMatch(
      /^\\set supadrum_schema_checks_base64 [A-Za-z0-9+/=]+$/
    );
    expect(
      Buffer.from(encoded, "base64").toString("utf8")
    ).toBe(JSON.stringify(payload.checks));
    expect(input).not.toContain("\\getenv");
    expect(input).not.toContain("we'ird");
    expect(input.endsWith(CATALOG_INSPECTION_SQL)).toBe(true);
    expect(SCHEMA_INSPECTION_PSQL_ARGS).toEqual([
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--file",
      "-"
    ]);
    expect(CATALOG_INSPECTION_SQL).not.toBe("");
    expect(MIGRATION_INSPECTION_SQL).not.toBe("");
  });

  test("emits only static catalog predicates for schema security checks", () => {
    expect(CATALOG_INSPECTION_SQL).toContain(
      "pg_catalog.has_schema_privilege("
    );
    expect(CATALOG_INSPECTION_SQL).toContain(
      "pg_catalog.has_table_privilege("
    );
    expect(CATALOG_INSPECTION_SQL).toContain(
      "pg_catalog.has_function_privilege("
    );
    expect(CATALOG_INSPECTION_SQL).toContain(
      "relation.relrowsecurity"
    );
    expect(CATALOG_INSPECTION_SQL).toContain(
      "relation.relforcerowsecurity"
    );
    expect(CATALOG_INSPECTION_SQL).toContain("rolbypassrls");
    expect(CATALOG_INSPECTION_SQL).toContain("rolsuper");
    expect(CATALOG_INSPECTION_SQL).toContain(
      "from pg_catalog.pg_policy policy"
    );
    expect(CATALOG_INSPECTION_SQL).toContain(
      "policy.polqual is not null"
    );
    expect(CATALOG_INSPECTION_SQL).toContain(
      "policy.polwithcheck is not null"
    );
    expect(CATALOG_INSPECTION_SQL).toContain(
      "routine.prokind = 'f'"
    );
    expect(CATALOG_INSPECTION_SQL).toMatch(
      /begin transaction read only;[\s\S]*statement_timeout = '5s';[\s\S]*lock_timeout = '1s';/
    );
    expect(CATALOG_INSPECTION_SQL).not.toContain("pg_get_expr");
    expect(CATALOG_INSPECTION_SQL).not.toMatch(
      /\b(?:relacl|nspacl|proacl)\b/
    );
  });

  test("guards every effective privilege predicate inside its lateral branch", () => {
    const branchContaining = (predicate: string, alias: string) => {
      const predicateIndex = CATALOG_INSPECTION_SQL.indexOf(predicate);
      const branchStart = CATALOG_INSPECTION_SQL.lastIndexOf(
        "left join lateral (",
        predicateIndex
      );
      const branchEnd = CATALOG_INSPECTION_SQL.indexOf(
        `) ${alias}`,
        predicateIndex
      );
      return CATALOG_INSPECTION_SQL.slice(branchStart, branchEnd);
    };

    expect(
      branchContaining(
        "pg_catalog.has_schema_privilege(",
        "schema_privilege_match"
      )
    ).toContain(
      "requested.check ->> 'kind' = 'schema-privilege'"
    );
    expect(
      branchContaining(
        "pg_catalog.has_table_privilege(",
        "relation_privilege_match"
      )
    ).toContain(
      "requested.check ->> 'kind' = 'relation-privilege'"
    );
    expect(
      branchContaining(
        "pg_catalog.has_function_privilege(",
        "routine_privilege_match"
      )
    ).toContain(
      "requested.check ->> 'kind' = 'routine-privilege'"
    );
  });

  test("parses exactly one machine-readable document per phase", () => {
    const catalogSource = JSON.stringify({
      migration_history_available: true,
      checks: [{
        index: 1,
        kind: "relation",
        target: "public.templates",
        present: true,
        relation_kind: "table"
      }]
    });
    const migrationSource = JSON.stringify({
      checks: [{
        index: 0,
        kind: "migration",
        target: "20260729164000",
        present: false,
        history_available: true
      }]
    });

    expect(parseCatalogInspection(`${catalogSource}\n`)).toEqual(
      JSON.parse(catalogSource)
    );
    expect(parseMigrationInspection(migrationSource)).toEqual(
      JSON.parse(migrationSource)
    );
    expect(() => parseCatalogInspection("")).toThrow(
      /catalog inspection output/i
    );
    expect(() =>
      parseCatalogInspection(`${catalogSource}\n${catalogSource}`)
    ).toThrow(/catalog inspection output/i);
    expect(() => parseMigrationInspection("not-json")).toThrow(
      /migration inspection output/i
    );
  });

  test("parses and assembles strict schema security results in request order", () => {
    const payload = parseSchemaInspectionPayload({
      checks: [
        {
          kind: "row-security",
          schema: "public",
          relation: "templates",
          enabled: true,
          force: false,
          roles_without_bypass: ["anon", "authenticated"]
        },
        {
          kind: "policy",
          schema: "public",
          relation: "templates",
          name: "templates_update",
          command: "UPDATE",
          roles: ["authenticated"],
          permissive: true
        },
        {
          kind: "schema-privilege",
          schema: "private",
          role: "authenticated",
          privilege: "USAGE",
          granted: true
        },
        {
          kind: "relation-privilege",
          schema: "public",
          relation: "templates",
          role: "anon",
          privilege: "MAINTAIN",
          granted: false
        },
        {
          kind: "routine-privilege",
          schema: "private",
          name: "is_organization_member",
          argument_types: ["text"],
          role: "authenticated",
          privilege: "EXECUTE",
          granted: true
        }
      ]
    });
    const source = {
      migration_history_available: true,
      checks: [
        {
          index: 4,
          kind: "routine-privilege",
          target: "private.is_organization_member(text):authenticated:EXECUTE",
          present: true,
          identity_arguments: "target_organization_id text",
          role: "authenticated",
          privilege: "EXECUTE",
          granted: true
        },
        {
          index: 2,
          kind: "schema-privilege",
          target: "private:authenticated:USAGE",
          present: true,
          role: "authenticated",
          privilege: "USAGE",
          granted: true
        },
        {
          index: 0,
          kind: "row-security",
          target: "public.templates",
          present: true,
          enabled: true,
          force: false,
          roles: [
            { role: "anon", bypasses_rls: false },
            { role: "authenticated", bypasses_rls: false }
          ]
        },
        {
          index: 3,
          kind: "relation-privilege",
          target: "public.templates:anon:MAINTAIN",
          present: true,
          role: "anon",
          privilege: "MAINTAIN",
          granted: false
        },
        {
          index: 1,
          kind: "policy",
          target: "public.templates.templates_update",
          present: true,
          command: "UPDATE",
          roles: ["authenticated"],
          permissive: true,
          using_present: true,
          with_check: "explicit"
        }
      ]
    };

    const catalog = parseCatalogInspection(JSON.stringify(source));
    expect(
      assembleSchemaInspection(payload, catalog, null)
    ).toEqual({
      compatible: true,
      scope: {
        requested_checks: 5,
        meaning: "Compatibility applies only to the requested checks"
      },
      checks: [
        source.checks[2],
        source.checks[4],
        source.checks[1],
        source.checks[3],
        source.checks[0]
      ]
    });
  });

  test("rejects security results that expose policy or ACL internals", () => {
    const result = {
      migration_history_available: true,
      checks: [{
        index: 0,
        kind: "policy",
        target: "public.templates.templates_select",
        present: true,
        command: "SELECT",
        roles: ["authenticated"],
        permissive: true,
        using_present: true,
        with_check: "not-applicable"
      }]
    };

    expect(() =>
      parseCatalogInspection(JSON.stringify({
        ...result,
        checks: [{ ...result.checks[0], expression: "auth.uid() = user_id" }]
      }))
    ).toThrow(/catalog inspection output/i);
    expect(() =>
      parseCatalogInspection(JSON.stringify({
        ...result,
        checks: [{ ...result.checks[0], relacl: ["authenticated=r"] }]
      }))
    ).toThrow(/catalog inspection output/i);
  });

  test("assembles results in request order and preserves duplicates", () => {
    const payload = parseSchemaInspectionPayload({
      checks: [
        { kind: "migration", version: "20260729164000" },
        { kind: "relation", schema: "public", name: "templates" },
        { kind: "relation", schema: "public", name: "templates" }
      ]
    });
    const catalog = parseCatalogInspection(JSON.stringify({
      migration_history_available: true,
      checks: [
        {
          index: 2,
          kind: "relation",
          target: "public.templates",
          present: true,
          relation_kind: "table"
        },
        {
          index: 1,
          kind: "relation",
          target: "public.templates",
          present: true,
          relation_kind: "table"
        }
      ]
    }));
    const migrations = parseMigrationInspection(JSON.stringify({
      checks: [{
        index: 0,
        kind: "migration",
        target: "20260729164000",
        present: false,
        history_available: true
      }]
    }));

    expect(
      assembleSchemaInspection(payload, catalog, migrations)
    ).toEqual({
      compatible: false,
      scope: {
        requested_checks: 3,
        meaning: "Compatibility applies only to the requested checks"
      },
      checks: [
        {
          index: 0,
          kind: "migration",
          target: "20260729164000",
          present: false,
          history_available: true
        },
        {
          index: 1,
          kind: "relation",
          target: "public.templates",
          present: true,
          relation_kind: "table"
        },
        {
          index: 2,
          kind: "relation",
          target: "public.templates",
          present: true,
          relation_kind: "table"
        }
      ]
    });
  });

  test("completes missing migration history as an incompatible result", () => {
    const payload = parseSchemaInspectionPayload({
      checks: [
        { kind: "migration", version: "20260729164000" },
        { kind: "relation", schema: "pg_catalog", name: "pg_class" }
      ]
    });
    const catalog = parseCatalogInspection(JSON.stringify({
      migration_history_available: false,
      checks: [{
        index: 1,
        kind: "relation",
        target: "pg_catalog.pg_class",
        present: true,
        relation_kind: "table"
      }]
    }));

    expect(assembleSchemaInspection(payload, catalog, null)).toEqual({
      compatible: false,
      scope: {
        requested_checks: 2,
        meaning: "Compatibility applies only to the requested checks"
      },
      checks: [
        {
          index: 0,
          kind: "migration",
          target: "20260729164000",
          present: false,
          history_available: false
        },
        {
          index: 1,
          kind: "relation",
          target: "pg_catalog.pg_class",
          present: true,
          relation_kind: "table"
        }
      ]
    });
  });

  test("reports compatibility only when every requested check is present", () => {
    const payload = parseSchemaInspectionPayload({
      checks: [{
        kind: "routine",
        schema: "pg_catalog",
        name: "current_database",
        argument_types: []
      }]
    });
    const catalog = parseCatalogInspection(JSON.stringify({
      migration_history_available: true,
      checks: [{
        index: 0,
        kind: "routine",
        target: "pg_catalog.current_database()",
        present: true,
        identity_arguments: ""
      }]
    }));

    expect(
      assembleSchemaInspection(payload, catalog, null).compatible
    ).toBe(true);
  });

  test("rejects catalog results outside the requested check set", () => {
    const payload = parseSchemaInspectionPayload({
      checks: [{
        kind: "relation",
        schema: "pg_catalog",
        name: "pg_class"
      }]
    });
    const catalog = parseCatalogInspection(JSON.stringify({
      migration_history_available: true,
      checks: [
        {
          index: 0,
          kind: "relation",
          target: "pg_catalog.pg_class",
          present: true,
          relation_kind: "table"
        },
        {
          index: 99,
          kind: "relation",
          target: "pg_catalog.pg_proc",
          present: true,
          relation_kind: "table"
        }
      ]
    }));

    expect(() =>
      assembleSchemaInspection(payload, catalog, null)
    ).toThrow(/unexpected catalog inspection result/i);
  });
});

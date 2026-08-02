export const capabilityNames = [
  "data-api",
  "auth-admin",
  "storage",
  "realtime",
  "edge-functions",
  "secrets",
  "migrations",
  "schema-inspection",
  "sql",
  "project-management"
] as const;

export type Capability = (typeof capabilityNames)[number];

export const operationNames = [
  "project.inspect",
  "data.query",
  "auth.admin",
  "storage.admin",
  "realtime.admin",
  "functions.deploy",
  "secrets.set",
  "migration.plan",
  "migration.baseline",
  "migration.apply",
  "schema.inspect",
  "sql.execute",
  "project.manage"
] as const;

export type Operation = (typeof operationNames)[number];

export interface OperationDefinition {
  readonly capability: Capability;
  readonly approval: boolean;
}

export const operationCatalog = {
  "project.inspect": {
    capability: "project-management",
    approval: false
  },
  "data.query": { capability: "data-api", approval: false },
  "auth.admin": { capability: "auth-admin", approval: true },
  "storage.admin": { capability: "storage", approval: true },
  "realtime.admin": { capability: "realtime", approval: true },
  "functions.deploy": { capability: "edge-functions", approval: true },
  "secrets.set": { capability: "secrets", approval: true },
  "migration.plan": { capability: "migrations", approval: false },
  "migration.baseline": { capability: "migrations", approval: true },
  "migration.apply": { capability: "migrations", approval: true },
  "schema.inspect": {
    capability: "schema-inspection",
    approval: false
  },
  "sql.execute": { capability: "sql", approval: true },
  "project.manage": { capability: "project-management", approval: true }
} as const satisfies Record<Operation, OperationDefinition>;

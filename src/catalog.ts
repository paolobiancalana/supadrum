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
  "adapter-tests",
  "pgtap",
  "project-management",
  "deploy"
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
  "migration.diff",
  "migration.plan",
  "migration.baseline",
  "migration.apply",
  "schema.inspect",
  "sql.execute",
  "tests.run",
  "pgtap.run",
  "project.manage",
  "types.generate",
  "deploy.inspect",
  "deploy.plan",
  "deploy.apply"
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
  // Writing a migration file into the repository is the same blast radius as
  // types.generate: reviewable, reversible, and nowhere near a database write.
  "migration.diff": { capability: "migrations", approval: false },
  "migration.plan": { capability: "migrations", approval: false },
  "migration.baseline": { capability: "migrations", approval: true },
  "migration.apply": { capability: "migrations", approval: true },
  "schema.inspect": {
    capability: "schema-inspection",
    approval: false
  },
  "sql.execute": { capability: "sql", approval: true },
  "tests.run": { capability: "adapter-tests", approval: true },
  // pgTAP runs against a disposable Docker stack built from git objects of the
  // registered repository, in a directory under $HOME that is removed after.
  // Nothing persistent is written, no credential is resolved, and the payload
  // leaves the caller no choices: the blast radius is runner time, so a commit
  // hook can queue it without a human approving each run (#40).
  "pgtap.run": { capability: "pgtap", approval: false },
  "project.manage": { capability: "project-management", approval: true },
  "types.generate": { capability: "schema-inspection", approval: false },
  // Deploying is the one operation whose blast radius is the public internet:
  // reading and rehearsing are free, shipping is gated like every other write.
  "deploy.inspect": { capability: "deploy", approval: false },
  "deploy.plan": { capability: "deploy", approval: false },
  "deploy.apply": { capability: "deploy", approval: true }
} as const satisfies Record<Operation, OperationDefinition>;

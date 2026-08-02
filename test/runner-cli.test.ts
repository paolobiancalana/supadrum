import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import { runRunner } from "../src/runner-cli.js";
import type { Job } from "../src/domain.js";
import { SqliteStore } from "../src/store.js";

function configYaml(projects: readonly string[]): string {
  const chambers = projects
    .map(
      (name) => `  ${name}:
    project_ref: ${name}-ref-00000000000000
    credentials:
      secret_key: vault://supabase/${name}/secret
      management_token: vault://supabase/${name}/management
      database_access: vault://supabase/${name}/postgres`
    )
    .join("\n");
  const entries = projects
    .map(
      (name) => `  ${name}:
    chamber: ${name}
    mode: dry-run
    capabilities:
      - project-management`
    )
    .join("\n");
  return `version: 1
database: queue.sqlite
executor: dry-run
approval_mode: automatic
chambers:
${chambers}
projects:
${entries}
`;
}

async function waitForSettled(
  store: SqliteStore,
  jobId: string
): Promise<Job> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const job = store.getJob(jobId);
    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() > deadline) {
      throw new Error(`Job ${jobId} did not settle: ${job.status}`);
    }
    await delay(20);
  }
}

describe("runner CLI", () => {
  test("reloads configuration when the file changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supadrum-runner-cli-"));
    const configPath = join(directory, "supadrum.yml");
    writeFileSync(configPath, configYaml(["alpha"]));
    const store = new SqliteStore(join(directory, "queue.sqlite"));
    const running = runRunner(["--config", configPath, "--poll-ms", "10"]);

    try {
      const before = store.submit({
        project: "beta",
        operation: "project.inspect",
        payload: {},
        repo_sha: "abc123",
        idempotency_key: "beta-before-reload"
      });
      const failed = await waitForSettled(store, before.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("Unknown project: beta");

      writeFileSync(configPath, configYaml(["alpha", "beta"]));

      const after = store.submit({
        project: "beta",
        operation: "project.inspect",
        payload: {},
        repo_sha: "abc123",
        idempotency_key: "beta-after-reload"
      });
      const settled = await waitForSettled(store, after.id);
      expect(settled.status).toBe("completed");
    } finally {
      process.emit("SIGTERM");
      await running;
      store.close();
    }
  });
});

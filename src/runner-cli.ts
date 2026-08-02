#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";

import { configMtime, loadConfig } from "./config.js";
import { isEntrypoint } from "./entrypoint.js";
import { createRuntime } from "./executors.js";
import { resolveOperatorConfigPath } from "./projects.js";
import { Runner } from "./runner.js";
import { SqliteStore } from "./store.js";

function numericOption(
  args: readonly string[],
  name: string,
  fallback: number
): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

export async function runRunner(args: readonly string[]): Promise<void> {
  const configPath = resolveOperatorConfigPath({
    args,
    environment: process.env,
    cwd: process.cwd(),
    homeDirectory: homedir()
  });
  const once = args.includes("--once");
  const pollMs = numericOption(args, "--poll-ms", 250);
  let config = loadConfig(configPath);
  let mtime = configMtime(configPath);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    do {
      const store = new SqliteStore(
        config.database_path,
        undefined,
        config.approval_mode
      );
      const runtime = createRuntime(config);
      const runner = new Runner(
        store,
        config,
        runtime.credentials,
        runtime.executor
      );
      try {
        do {
          const result = await runner.tick();
          if (once) {
            process.stdout.write(`${JSON.stringify(result)}\n`);
            return;
          }
          if (result) continue;
          await delay(pollMs);
          const current = configMtime(configPath);
          if (current === null || current === mtime) continue;
          mtime = current;
          try {
            config = loadConfig(configPath);
          } catch (error) {
            process.stderr.write(
              `config reload failed, keeping previous config: ${
                error instanceof Error ? error.message : String(error)
              }\n`
            );
            continue;
          }
          process.stdout.write(`config reloaded: ${configPath}\n`);
          break;
        } while (!stopping);
      } finally {
        await runner.close();
        store.close();
      }
    } while (!stopping);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/*
 * Process bootstrap: binds this module to the real process — its argv, its
 * stdio, its exit code. The guard is false by design whenever the module is
 * imported rather than executed, so a coverage instrument scoped to the test
 * process can never observe it. The logic it wires into is exported and
 * tested directly; excluded from the measurement so the reported number means
 * "code the instrument can see" rather than carrying a permanent red block.
 */
/* v8 ignore start */
const entrypoint = process.argv[1];
if (isEntrypoint(import.meta.url, entrypoint)) {
  runRunner(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
/* v8 ignore stop */

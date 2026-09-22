import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { writeLocalViteEnvironment } from "./local-vite-env.js";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd?: string
) => Promise<CommandResult>;

/** Runs one command without a shell so project paths cannot become code. */
export const runCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8").trim(),
      stderr: Buffer.concat(stderr).toString("utf8").trim()
    }));
  });

/** Returns the dedicated Docker network used to keep one local stack private. */
export function localNetworkName(repository: string): string {
  const project = basename(repository).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const identity = createHash("sha256").update(resolve(repository)).digest("hex").slice(0, 8);
  return `supadrum-${project}-${identity}-loopback`;
}

function hasLoopbackBinding(inspection: string): boolean {
  try {
    const networks: unknown = JSON.parse(inspection);
    if (!Array.isArray(networks) || networks.length !== 1) return false;
    const options = networks[0]?.Options as Record<string, unknown> | undefined;
    return options?.["com.docker.network.bridge.host_binding_ipv4"] === "127.0.0.1";
  } catch {
    return false;
  }
}

/** Starts one local stack on a Docker network bound only to host loopback. */
export async function startLocalStack(
  repository: string,
  execute: CommandRunner = runCommand,
  supabaseDir = repository
): Promise<string> {
  const network = localNetworkName(repository);
  const inspect = await execute("docker", ["network", "inspect", network]);
  if (inspect.code !== 0) {
    const created = await execute("docker", ["network", "create", "-o",
      "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network]);
    if (created.code !== 0) throw new Error("Unable to create loopback Docker network");
  } else if (!hasLoopbackBinding(inspect.stdout)) {
    throw new Error(`Docker network ${network} is not bound to loopback`);
  }
  const started = await execute("supabase", ["start", "--network-id", network], supabaseDir);
  if (started.code !== 0) {
    const detail = `${started.stdout}\n${started.stderr}`.split("\n")
      .find((line) => /error|unhealthy|not ready/i.test(line));
    throw new Error(`Local Supabase start failed (${started.code})${detail ? `: ${detail}` : ""}`);
  }
  const status = await execute("supabase", ["status", "-o", "env"], supabaseDir);
  if (status.code !== 0) throw new Error("Unable to read local Supabase status");
  const viteUpdated = writeLocalViteEnvironment(repository, status.stdout, supabaseDir);
  return viteUpdated
    ? "Local Supabase stack started on loopback; Vite environment updated."
    : "Local Supabase stack started on loopback.";
}

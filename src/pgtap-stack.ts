import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandRunner } from "./local-stack.js";

type Version = readonly [major: number, minor: number, patch: number];

/**
 * Oldest Supabase CLI the disposable stack was proven against. A floor, not
 * an allowlist: a `brew upgrade` must not turn every commit into a refusal.
 */
export const MIN_SUPABASE_CLI: Version = [2, 116, 0];

/** The prefix is reserved to the broker; nothing else may match. */
const DISPOSABLE_ID = /^supadrum-tmp-[a-z0-9-]+$/;
const PROJECT_LABEL = "com.supabase.cli.project";

export type PgtapPrerequisiteReason =
  | "docker_unreachable"
  | "supabase_cli_missing"
  | "supabase_cli_too_old"
  | "no_probe_image"
  | "space_probe_failed"
  | "insufficient_space";

/** A refusal raised before any container exists, so there is nothing to clean. */
export class PgtapPrerequisiteError extends Error {
  constructor(readonly reason: PgtapPrerequisiteReason, message: string) {
    super(message);
    this.name = "PgtapPrerequisiteError";
  }
}

/**
 * The only defence of a manual stack's volume, which carries no folder label:
 * an id outside the reserved shape never reaches Docker or the filesystem.
 */
function assertDisposableId(id: string): void {
  if (!DISPOSABLE_ID.test(id))
    throw new Error(`Refusing ${JSON.stringify(id)}: not a disposable stack id`);
}

const DOCKER_KINDS = [
  { name: "container", list: ["ps", "-a"], format: "{{.Names}}", remove: ["rm", "-f"] },
  { name: "volume", list: ["volume", "ls"], format: "{{.Name}}", remove: ["volume", "rm", "-f"] },
  { name: "network", list: ["network", "ls"], format: "{{.Name}}", remove: ["network", "rm"] }
] as const;

type DockerKind = (typeof DOCKER_KINDS)[number];

/** Names matching one Docker filter, or undefined when Docker would not say. */
async function listNames(
  execute: CommandRunner,
  kind: DockerKind,
  filter: string
): Promise<string[] | undefined> {
  const listed = await execute("docker", [...kind.list, "--filter", filter, "--format", kind.format]);
  return listed.code === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : undefined;
}

/**
 * Removes one disposable stack and reports what survived, one object per
 * line; the empty string means clean. Objects are selected for removal only by
 * the exact value of the CLI project label, never by name or prefix, and never
 * through `supabase stop`. Afterwards anything still carrying the id in its
 * label or its name is a residue, as is a kind Docker refused to list.
 */
export async function removeDisposableStack(
  id: string,
  execute: CommandRunner = runCommand,
  cacheRoot = join(homedir(), ".cache", "supadrum")
): Promise<string> {
  assertDisposableId(id);
  const byLabel = `label=${PROJECT_LABEL}=${id}`;
  for (const kind of DOCKER_KINDS) {
    const names = await listNames(execute, kind, byLabel) ?? [];
    // A failed removal is not judged here: the residue scan below sees it.
    if (names.length > 0) await execute("docker", [...kind.remove, ...names]);
  }
  await rm(join(cacheRoot, id), { recursive: true, force: true });

  const residues: string[] = [];
  for (const kind of DOCKER_KINDS) {
    const found = new Set<string>();
    for (const filter of [byLabel, `name=${id}`]) {
      const names = await listNames(execute, kind, filter);
      if (names === undefined) residues.push(`${kind.name}s unverified (${filter})`);
      else for (const name of names) found.add(name);
    }
    for (const name of found) residues.push(`${kind.name} ${name}`);
  }
  return residues.join("\n");
}

/**
 * Creates the stack's network with the project label itself: networks the
 * CLI joins through `--network-id` do not inherit it, and cleanup selects
 * by label. Published ports bind to loopback only, as for the local chamber:
 * the disposable database keeps the CLI's default password.
 */
export async function createDisposableNetwork(
  id: string,
  execute: CommandRunner = runCommand
): Promise<string> {
  assertDisposableId(id);
  const network = `supabase_network_${id}`;
  const created = await execute("docker", ["network", "create",
    "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
    "--label", `${PROJECT_LABEL}=${id}`, network]);
  if (created.code !== 0) throw new Error(`Unable to create Docker network ${network}`);
  return network;
}

function parseVersion(text: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function isOlder([major, minor, patch]: Version, [minMajor, minMinor, minPatch]: Version): boolean {
  if (major !== minMajor) return major < minMajor;
  if (minor !== minMinor) return minor < minMinor;
  return patch < minPatch;
}

/** The "Available" column of `df -Pk` output, in KiB. */
function parseAvailableKib(output: string): number | undefined {
  const available = output.split("\n")[1]?.trim().split(/\s+/)[3];
  return available !== undefined && /^\d+$/.test(available) ? Number(available) : undefined;
}

const KIB_PER_GIB = 1024 * 1024;
const gib = (kib: number): string => (kib / KIB_PER_GIB).toFixed(2);

export interface PgtapPrerequisites {
  /** An image already on the host; the space probe never pulls. */
  readonly probeImage: string;
  /** `pgtap.min_free_gib`: free space Docker's disk must have before a start. */
  readonly minFreeGib: number;
}

/**
 * Refuses before any stack container exists: an unreachable daemon, a missing
 * or too old CLI, or a Docker disk without room. Space is measured inside a
 * throwaway container because Docker's disk is the VM's, not the host's.
 */
export async function checkPgtapPrerequisites(
  { probeImage, minFreeGib }: PgtapPrerequisites,
  execute: CommandRunner = runCommand
): Promise<void> {
  const info = await execute("docker", ["info"]).catch(() => undefined);
  if (info?.code !== 0)
    throw new PgtapPrerequisiteError("docker_unreachable", "Docker daemon is not reachable: docker info failed");

  const cli = await execute("supabase", ["--version"]).catch(() => undefined);
  const version = cli?.code === 0 ? parseVersion(cli.stdout) : undefined;
  if (version === undefined)
    throw new PgtapPrerequisiteError("supabase_cli_missing", "Supabase CLI is not installed or did not report a version");
  if (isOlder(version, MIN_SUPABASE_CLI))
    throw new PgtapPrerequisiteError("supabase_cli_too_old",
      `Supabase CLI ${version.join(".")} is older than ${MIN_SUPABASE_CLI.join(".")}`);

  const image = await execute("docker", ["image", "inspect", probeImage]);
  if (image.code !== 0)
    throw new PgtapPrerequisiteError("no_probe_image", `No local image ${probeImage} to measure free space with`);

  const df = await execute("docker", ["run", "--rm", "--pull=never", "--network", "none",
    "--entrypoint", "df", probeImage, "-Pk", "/"]);
  const freeKib = df.code === 0 ? parseAvailableKib(df.stdout) : undefined;
  if (freeKib === undefined)
    throw new PgtapPrerequisiteError("space_probe_failed", `Unable to measure free space with df in ${probeImage}`);
  const neededKib = minFreeGib * KIB_PER_GIB;
  if (freeKib < neededKib)
    throw new PgtapPrerequisiteError("insufficient_space",
      `Docker has ${gib(freeKib)} GiB free but pgTAP needs ${minFreeGib} GiB: ${gib(neededKib - freeKib)} GiB short`);
}

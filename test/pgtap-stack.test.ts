import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CommandResult, CommandRunner } from "../src/local-stack.js";
import {
  checkPgtapPrerequisites,
  createDisposableNetwork,
  removeDisposableStack,
  type PgtapPrerequisiteReason
} from "../src/pgtap-stack.js";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed: CommandResult = { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };

const id = "supadrum-tmp-presnap";
const label = `label=com.supabase.cli.project=${id}`;

interface FakeObject {
  readonly kind: "container" | "volume" | "network";
  readonly name: string;
  readonly project?: string;
  /** Survives `rm`, as a container stuck in removal would. */
  readonly stuck?: boolean;
}

const stack = (project: string): FakeObject[] => [
  { kind: "container", name: `supabase_db_${project}`, project },
  { kind: "container", name: `supabase_rest_${project}`, project },
  { kind: "volume", name: `supabase_db_${project}`, project },
  { kind: "network", name: `supabase_network_${project}`, project }
];

/**
 * A Docker that keeps its objects between calls and understands only an exact
 * project label and a name substring; any other selector throws, so a prefix
 * or key-only filter cannot pass by accident.
 */
function fakeDocker(initial: FakeObject[], unlistable: FakeObject["kind"][] = []) {
  let objects = [...initial];
  const calls: string[] = [];
  const execute: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command !== "docker") throw new Error(`unexpected ${command}`);
    const kind = args[0] === "volume" || args[0] === "network" ? args[0] : "container";
    const filterAt = args.indexOf("--filter");
    if (filterAt >= 0) {
      if (unlistable.includes(kind)) return failed;
      const filter = args[filterAt + 1] ?? "";
      const labelPrefix = "label=com.supabase.cli.project=";
      const matches = filter.startsWith(labelPrefix)
        ? (object: FakeObject) => object.project === filter.slice(labelPrefix.length)
        : filter.startsWith("name=")
          ? (object: FakeObject) => object.name.includes(filter.slice("name=".length))
          : undefined;
      if (!matches) throw new Error(`unsupported filter ${filter}`);
      return ok(objects.filter((object) => object.kind === kind && matches(object))
        .map((object) => object.name).join("\n"));
    }
    if (args.includes("rm")) {
      const names = args.slice(args.indexOf("rm") + 1).filter((arg) => arg !== "-f");
      const targeted = (object: FakeObject) => object.kind === kind && names.includes(object.name);
      objects = objects.filter((object) => !targeted(object) || object.stuck);
      return objects.some(targeted) ? failed : ok();
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { execute, calls, remaining: () => objects };
}

function cacheWith(...directories: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "supadrum-pgtap-cache-"));
  for (const directory of directories) {
    mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, "config.toml"), "project_id = \"x\"\n");
  }
  return root;
}

describe("disposable stack cleanup", () => {
  test.each([
    "presnap",
    "supadrum-tmp-",
    "supadrum-tmp-PreSnap",
    "supadrum-tmp-pre_snap",
    "supadrum-tmp-pre/snap",
    "xsupadrum-tmp-presnap",
    "supadrum-tmp-presnap\n"
  ])("refuses %j before any Docker call", async (unsafe) => {
    const docker = fakeDocker(stack("presnap"));
    await expect(removeDisposableStack(unsafe, docker.execute, cacheWith()))
      .rejects.toThrow("not a disposable stack id");
    expect(docker.calls).toEqual([]);
  });

  test("leaves the cache directory of a refused id in place", async () => {
    const cacheRoot = cacheWith("presnap");
    await expect(removeDisposableStack("presnap", fakeDocker([]).execute, cacheRoot)).rejects.toThrow();
    expect(existsSync(join(cacheRoot, "presnap"))).toBe(true);
  });

  test("removes only the objects labelled with the exact id, and its directory", async () => {
    const docker = fakeDocker([...stack("presnap"), ...stack(id)]);
    const cacheRoot = cacheWith(id, "presnap");

    const residues = await removeDisposableStack(id, docker.execute, cacheRoot);

    expect(residues).toBe("");
    expect(docker.remaining()).toEqual(stack("presnap"));
    expect(existsSync(join(cacheRoot, id))).toBe(false);
    expect(existsSync(join(cacheRoot, "presnap"))).toBe(true);
  });

  test("never selects by name: an unlabelled object named after the id stays and is reported", async () => {
    const stray: FakeObject = { kind: "container", name: `backup-of-${id}` };
    const docker = fakeDocker([...stack(id), stray]);

    const residues = await removeDisposableStack(id, docker.execute, cacheWith());

    expect(residues).toBe(`container backup-of-${id}`);
    expect(docker.remaining()).toEqual([stray]);
  });

  test("reports a labelled object that survived its removal", async () => {
    const docker = fakeDocker([...stack(id),
      { kind: "volume", name: "orphan-volume", project: id, stuck: true }]);

    const residues = await removeDisposableStack(id, docker.execute, cacheWith());

    expect(residues).toBe("volume orphan-volume");
  });

  test("does not call a kind clean when Docker refuses to list it", async () => {
    const docker = fakeDocker(stack(id), ["volume"]);

    const residues = await removeDisposableStack(id, docker.execute, cacheWith());

    expect(residues).toBe(`volumes unverified (${label})\nvolumes unverified (name=${id})`);
  });
});

describe("disposable stack network", () => {
  test("creates the network bound to loopback and carrying the project label cleanup selects by", async () => {
    const calls: string[] = [];
    const network = await createDisposableNetwork(id, async (command, args) => {
      calls.push([command, ...args].join(" "));
      return ok();
    });
    expect(network).toBe(`supabase_network_${id}`);
    expect(calls).toEqual([
      `docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 --label com.supabase.cli.project=${id} supabase_network_${id}`
    ]);
  });

  test("refuses a non-disposable id before any Docker call", async () => {
    const docker = fakeDocker([]);
    await expect(createDisposableNetwork("presnap", docker.execute))
      .rejects.toThrow("not a disposable stack id");
    expect(docker.calls).toEqual([]);
  });

  test("fails when Docker does not create the network", async () => {
    await expect(createDisposableNetwork(id, async () => failed))
      .rejects.toThrow(`Unable to create Docker network supabase_network_${id}`);
  });
});

describe("pgTAP prerequisites", () => {
  const image = "public.ecr.aws/supabase/postgres:17.6.1.166";
  const inspect = `docker image inspect ${image}`;
  const dfProbe = `docker run --rm --pull=never --network none --entrypoint df ${image} -Pk /`;
  const probes = ["docker info", "supabase --version", inspect, dfProbe];
  const GIB = 1024 * 1024;
  const df = (availableKib: number) => ok([
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    `overlay           61202244  47318712  ${availableKib}      81% /`
  ].join("\n"));

  function host(overrides: Record<string, CommandResult | Error> = {}) {
    const responses: Record<string, CommandResult | Error> = {
      "docker info": ok("Server Version: 28.0.1"),
      "supabase --version": ok("2.116.0"),
      [inspect]: ok("[{}]"),
      [dfProbe]: df(10 * GIB),
      ...overrides
    };
    const calls: string[] = [];
    const execute: CommandRunner = async (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      const response = responses[call];
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error(`unexpected ${call}`);
      return response;
    };
    return { execute, calls };
  }

  const check = (execute: CommandRunner) =>
    checkPgtapPrerequisites({ probeImage: image, minFreeGib: 10 }, execute);

  test("passes with a recent CLI and exactly the free space required", async () => {
    const machine = host();
    await expect(check(machine.execute)).resolves.toBeUndefined();
    expect(machine.calls).toEqual(probes);
  });

  test.each<{ when: string; overrides: Record<string, CommandResult | Error>; reason: PgtapPrerequisiteReason; ran: number }>([
    { when: "the daemon is down", overrides: { "docker info": failed }, reason: "docker_unreachable", ran: 1 },
    { when: "docker is not installed", overrides: { "docker info": new Error("spawn docker ENOENT") }, reason: "docker_unreachable", ran: 1 },
    { when: "the CLI is absent", overrides: { "supabase --version": new Error("spawn supabase ENOENT") }, reason: "supabase_cli_missing", ran: 2 },
    { when: "the CLI prints no version", overrides: { "supabase --version": ok("") }, reason: "supabase_cli_missing", ran: 2 },
    { when: "the CLI is 2.115.9", overrides: { "supabase --version": ok("2.115.9") }, reason: "supabase_cli_too_old", ran: 2 },
    { when: "the probe image is not present", overrides: { [inspect]: failed }, reason: "no_probe_image", ran: 3 },
    { when: "df cannot run in the image", overrides: { [dfProbe]: { code: 127, stdout: "", stderr: "df: not found" } }, reason: "space_probe_failed", ran: 4 },
    { when: "free space is one KiB short", overrides: { [dfProbe]: df(10 * GIB - 1) }, reason: "insufficient_space", ran: 4 }
  ])("refuses with $reason when $when, and runs nothing after", async ({ overrides, reason, ran }) => {
    const machine = host(overrides);
    await expect(check(machine.execute))
      .rejects.toMatchObject({ name: "PgtapPrerequisiteError", reason });
    expect(machine.calls).toEqual(probes.slice(0, ran));
  });

  test("says how much space is missing", async () => {
    const machine = host({ [dfProbe]: df(7.5 * GIB) });
    await expect(check(machine.execute))
      .rejects.toThrow("Docker has 7.50 GiB free but pgTAP needs 10 GiB: 2.50 GiB short");
  });

  test.each(["2.116.0", "2.116.1", "2.117.0", "3.0.0", "10.0.0"])(
    "accepts Supabase CLI %s", async (version) => {
      await expect(check(host({ "supabase --version": ok(version) }).execute)).resolves.toBeUndefined();
    });

  test.each(["2.115.9", "2.99.0", "1.200.0"])(
    "refuses Supabase CLI %s as older than 2.116.0", async (version) => {
      await expect(check(host({ "supabase --version": ok(version) }).execute))
        .rejects.toMatchObject({ reason: "supabase_cli_too_old" });
    });
});

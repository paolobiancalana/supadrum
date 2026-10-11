import { createServer, type Server } from "node:net";
import { describe, expect, test } from "vitest";
import {
  buildPgtapConfig,
  isLoopbackPortFree,
  PgtapConfigError
} from "../src/pgtap-config.js";

const TREE = [
  'project_id = "original"',
  "",
  "[api]",
  "port = 54321",
  "",
  "[db]",
  "port = 54322",
  "shadow_port = 54320",
  "",
  "[x.y]",
  "foo_port = 9000",
  "",
  "[db.seed]",
  "enabled = true",
  'sql_paths = ["./seed.sql"]',
  ""
].join("\n");

const always = async () => true;

/** Probe that reports a port as taken when it is in the set. */
const takenPorts = (taken: readonly number[]) =>
  async (port: number) => !taken.includes(port);

function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("no address");
      resolve({ server, port: address.port });
    });
  });
}

async function rejectReason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof PgtapConfigError ? error.reason : `not typed: ${String(error)}`;
  }
}

describe("pgTAP disposable config", () => {
  test("rewrites project_id and every port key in any table, leaving the rest intact", async () => {
    const result = await buildPgtapConfig({
      tree: TREE, project: "demo", portBase: 54330, isFree: always
    });
    expect(result).toBe([
      'project_id = "supadrum-tmp-demo"',
      "",
      "[api]",
      "port = 54330",
      "",
      "[db]",
      "port = 54331",
      "shadow_port = 54332",
      "",
      "[x.y]",
      "foo_port = 54333",
      "",
      "[db.seed]",
      "enabled = false",
      'sql_paths = ["./seed.sql"]',
      ""
    ].join("\n"));
  });

  test("refuses a tree whose project_id already has the temporary prefix", async () => {
    const tree = TREE.replace('"original"', '"supadrum-tmp-x"');
    expect(await rejectReason(buildPgtapConfig({
      tree, project: "demo", portBase: 54330, isFree: always
    }))).toBe("reserved_project_id");
  });

  test("adds project_id when the tree has none", async () => {
    const result = await buildPgtapConfig({
      tree: "[api]\nport = 1\n", project: "demo", portBase: 54330, isFree: always
    });
    expect(result.startsWith('project_id = "supadrum-tmp-demo"\n')).toBe(true);
  });

  test("skips original ports of the tree when assigning", async () => {
    const tree = 'project_id = "p"\n[api]\nport = 54330\n[db]\nport = 54331\n';
    const result = await buildPgtapConfig({
      tree, project: "demo", portBase: 54330, isFree: always
    });
    expect(result).toContain("[api]\nport = 54332\n");
    expect(result).toContain("[db]\nport = 54333\n");
  });

  test("skips a port that something already listens on", async () => {
    const busy = await listen();
    try {
      const tree = 'project_id = "p"\n[api]\nport = 1\n';
      const result = await buildPgtapConfig({
        tree, project: "demo", portBase: busy.port
      });
      const assigned = Number(/port = (\d+)/.exec(result)?.[1]);
      expect(assigned).toBeGreaterThan(busy.port);
    } finally {
      busy.server.close();
    }
  });

  test("skips a port the injected probe reports as taken", async () => {
    const tree = 'project_id = "p"\n[api]\nport = 1\n';
    const result = await buildPgtapConfig({
      tree, project: "demo", portBase: 54330, isFree: takenPorts([54330])
    });
    expect(result).toContain("port = 54331");
  });

  test("refuses when fewer free ports than keys exist inside the scan window", async () => {
    const tree = 'project_id = "p"\n[api]\nport = 1\n[db]\nport = 2\n';
    expect(await rejectReason(buildPgtapConfig({
      tree, project: "demo", portBase: 54330, isFree: async () => false
    }))).toBe("ports_exhausted");
  });

  test("forces the seed table off, adding the key or the table when missing", async () => {
    const withoutKey = await buildPgtapConfig({
      tree: 'project_id = "p"\n[db.seed]\nsql_paths = []\n',
      project: "demo", portBase: 54330, isFree: always
    });
    expect(withoutKey).toContain("[db.seed]\nenabled = false\nsql_paths = []\n");
    const missing = await buildPgtapConfig({
      tree: 'project_id = "p"\n[api]\nport = 1\n',
      project: "demo", portBase: 54330, isFree: always
    });
    expect(missing.endsWith("\n[db.seed]\nenabled = false\n")).toBe(true);
  });

  test("refuses a port key whose value is not a bare integer, since it would stay original", async () => {
    const tree = 'project_id = "p"\n[api]\nport = "54321"\n';
    expect(await rejectReason(buildPgtapConfig({
      tree, project: "demo", portBase: 54330, isFree: always
    }))).toBe("original_port_left");
  });

  test("refuses an assignment whose key has quotes, since it cannot be safely rewritten", async () => {
    const treeDouble = 'project_id = "p"\n[db]\n"port" = 54322\n';
    expect(await rejectReason(buildPgtapConfig({
      tree: treeDouble, project: "demo", portBase: 54330, isFree: always
    }))).toBe("original_port_left");

    const treeSingle = 'project_id = "p"\n[db]\n\'port\' = 54322\n';
    expect(await rejectReason(buildPgtapConfig({
      tree: treeSingle, project: "demo", portBase: 54330, isFree: always
    }))).toBe("original_port_left");

    const treeNonPort = 'project_id = "p"\n"foo" = "bar"\n';
    expect(await rejectReason(buildPgtapConfig({
      tree: treeNonPort, project: "demo", portBase: 54330, isFree: always
    }))).toBe("original_port_left");

    const treeDotted = 'project_id = "p"\ndb.port = 54322\n';
    expect(await rejectReason(buildPgtapConfig({
      tree: treeDotted, project: "demo", portBase: 54330, isFree: always
    }))).toBe("original_port_left");
  });

  test("ignores comments that contain equals signs", async () => {
    const tree = 'project_id = "p"\n# port = 54321\n[api]\nport = 54321\n';
    const result = await buildPgtapConfig({
      tree, project: "demo", portBase: 54330, isFree: always
    });
    expect(result).toContain("# port = 54321\n");
    expect(result).toContain("port = 54330\n");
  });

  test("a port key whose name is not port or *_port is left alone", async () => {
    const tree = 'project_id = "p"\n[api]\nportal = 1\nreport_ports = 2\n';
    const result = await buildPgtapConfig({
      tree, project: "demo", portBase: 54330, isFree: always
    });
    expect(result).toContain("portal = 1\n");
    expect(result).toContain("report_ports = 2\n");
  });

  test("reports whether a loopback port is free", async () => {
    const busy = await listen();
    expect(await isLoopbackPortFree(busy.port)).toBe(false);
    await new Promise<void>((resolve) => busy.server.close(() => resolve()));
    expect(await isLoopbackPortFree(busy.port)).toBe(true);
  });
});

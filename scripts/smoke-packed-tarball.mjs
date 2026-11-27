import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tarball] = process.argv.slice(2);
if (!tarball) throw new Error("Expected the exact npm pack .tgz path");
assert.ok(tarball.endsWith(".tgz"), "Expected a .tgz tarball path");
if (process.env.CI_EXPECT_WIN32_X64 === "1") {
  assert.equal(process.platform, "win32", "CI must run on Windows");
  assert.equal(process.arch, "x64", "CI must run on x64");
}
const lockfile = await readFile("package-lock.json");
console.log(JSON.stringify({
  checkoutSha: await run("git", ["rev-parse", "HEAD"], process.cwd(), true),
  node: process.version,
  npm: await run(process.execPath, [process.env.npm_execpath, "--version"], process.cwd(), true),
  platform: process.platform,
  arch: process.arch,
  tarball: { path: tarball, sha256: sha256(await readFile(tarball)) },
  packageLockSha256: sha256(lockfile)
}, null, 2));

const root = await mkdtemp(join(tmpdir(), "supadrum packed smoke "));
const install = join(root, "installed package");
const fixture = join(root, "synthetic fixture");
const configPath = join(fixture, "supadrum.yml");
await mkdir(install);
await mkdir(fixture);
try {
  await writeFile(join(install, "package.json"), '{"private":true,"type":"module"}\n');
  const npmExecPath = process.env.npm_execpath;
  assert.ok(npmExecPath, "npm_execpath must identify the active npm CLI");
  await run(process.execPath, [npmExecPath, "install", "--no-audit", "--no-fund", tarball], install);
  await writeFile(configPath, fixtureConfig(fixture));

  const entrypoint = join(install, "node_modules", "supadrum", "dist", "mcp.js");
  const canonicalNames = [
    "projects.list", "projects.inspect", "jobs.submit", "jobs.wait", "jobs.status",
    "jobs.cancel", "sessions.open", "sessions.exec", "sessions.close"
  ];
  for (const portable of [false, true]) {
    const env = { ...process.env, SUPADRUM_CONFIG: configPath };
    delete env.SUPADRUM_MCP_TOOL_NAMES;
    if (portable) env.SUPADRUM_MCP_TOOL_NAMES = "portable";
    const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], cwd: fixture, env });
    const client = new Client({ name: "packed-tarball-smoke", version: "1.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const expected = canonicalNames.map((name) => portable ? name.replaceAll(".", "_") : name);
      assert.deepEqual(tools.map(({ name }) => name), expected);
      const result = await client.callTool({
        name: portable ? "projects_inspect" : "projects.inspect",
        arguments: { project: "fixture" }
      });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent?.name, "fixture");
    } finally {
      await client.close();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

function fixtureConfig(repository) {
  const project = [
    "  fixture:",
    `    repo: ${JSON.stringify(repository)}`,
    "    chamber: fixture",
    "    mode: dry-run",
    "    migrations: consumer",
    "    capabilities:",
    "      - data-api",
    "      - schema-inspection"
  ].join("\n");
  return [
    "version: 1",
    "database: queue.sqlite",
    "approval_mode: automatic",
    "chambers:",
    "  fixture:",
    "    project_ref: abcdefghijklmnopqrst",
    "    credentials:",
    "      secret_key: vault://fixture/secret",
    "      management_token: vault://fixture/management",
    "      database_access: vault://fixture/database",
    "projects:",
    project,
    ""
  ].join("\n");
}

function run(command, args, cwd, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", shell: false });
    let output = "";
    if (capture) child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(capture ? output.trim() : undefined) : reject(new Error(`${command} exited ${code}`)));
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

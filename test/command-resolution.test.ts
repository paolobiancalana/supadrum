import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { findAdjacentNpmEntrypoint, resolveNativeExecutable, resolveNodeCommand } from "../src/command-resolution.js";

describe("command resolution", () => {
  test("resolves an explicit native executable file", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum native command "));
    const executable = join(root, "tool.exe");
    writeFileSync(executable, "synthetic");
    chmodSync(executable, 0o755);
    expect(resolveNativeExecutable("tool", {
      PATH: root,
      SUPADRUM_TOOL_BIN: executable
    })).toBe(realpathSync(executable));
  });

  test("refuses invalid explicit executable overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum native path "));
    const executable = join(root, "tool.exe");
    writeFileSync(executable, "synthetic");
    expect(() => resolveNativeExecutable("tool", {
      PATH: root,
      SUPADRUM_TOOL_BIN: join(root, "missing.exe")
    })).toThrow(/override/);
  });

  test("uses the supplied npm JS entrypoint with the current Node executable", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum npm command "));
    const entrypoint = join(root, "npm-cli.js");
    writeFileSync(entrypoint, "");
    expect(resolveNodeCommand("npm", {
      environment: { npm_execpath: entrypoint }
    })).toEqual({
      argv: [process.execPath, realpathSync(entrypoint)],
      path: expect.any(String)
    });
  });

  test("finds a verified Node-adjacent npm CLI entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum npm global "));
    const node = join(root, "node");
    const entrypoint = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(root, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(entrypoint, "");
    expect(realpathSync(findAdjacentNpmEntrypoint(node)!)).toBe(realpathSync(entrypoint));
  });

  test("refuses command-script overrides without shell interpretation", () => {
    expect(() => resolveNodeCommand("npm", {
      environment: { SUPADRUM_NPM_BIN: "npm.cmd" }
    })).toThrow(/shell:false/);
  });

  test("resolves local Prisma only from its package metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "supadrum prisma command "));
    const packageDirectory = join(root, "node_modules", "prisma");
    mkdirSync(packageDirectory, { recursive: true });
    const entrypoint = join(packageDirectory, "build", "index.js");
    mkdirSync(join(packageDirectory, "build"));
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ bin: { prisma: "build/index.js" } }));
    writeFileSync(entrypoint, "");
    expect(resolveNodeCommand("prisma", { repository: root })).toEqual({
      argv: [process.execPath, realpathSync(entrypoint)],
      path: expect.any(String)
    });
  });
});

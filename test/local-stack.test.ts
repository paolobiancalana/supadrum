import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  localNetworkName,
  startLocalStack,
  type CommandResult
} from "../src/local-stack.js";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

describe("local Supabase stack isolation", () => {
  test("does not give repositories with the same basename one network", () => {
    expect(localNetworkName("/one/app")).not.toBe(localNetworkName("/two/app"));
    expect(localNetworkName("/one/app")).toBe(localNetworkName("/one/app"));
  });

  test("starts a non-Vite project without writing frontend environment", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-non-vite-"));
    mkdirSync(join(repository, "supabase"));
    writeFileSync(join(repository, "supabase", "config.toml"),
      '[auth]\nsite_url = "http://127.0.0.1:3000"\n');

    const result = await startLocalStack(repository, async (command, args) => {
      if (command === "docker" && args[1] === "inspect")
        return { code: 1, stdout: "", stderr: "missing" };
      if (command === "supabase" && args[0] === "status")
        return ok('ANON_KEY="public-local-key"');
      return ok();
    });

    expect(result).toBe("Local Supabase stack started on loopback.");
    expect(() => readFileSync(join(repository, ".env.development.local")))
      .toThrow();
  });

  test("starts a nested Supabase project without changing the Vite output directory", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-nested-start-"));
    const supabaseDir = join(repository, "database");
    mkdirSync(join(supabaseDir, "supabase"), { recursive: true });
    writeFileSync(join(repository, "package.json"),
      '{"devDependencies":{"vite":"^7.0.0"}}');
    writeFileSync(join(supabaseDir, "supabase", "config.toml"),
      '[auth]\nexternal_url = "https://local.example.test/supabase"\n');
    const calls: Array<{ command: string; cwd?: string }> = [];
    await startLocalStack(repository, async (command, args, cwd) => {
      calls.push({ command, ...(cwd ? { cwd } : {}) });
      if (command === "docker" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      if (command === "supabase" && args[0] === "status") return ok('ANON_KEY="public-local-key"');
      return ok();
    }, supabaseDir);
    expect(calls.filter((call) => call.command === "supabase").map((call) => call.cwd))
      .toEqual([supabaseDir, supabaseDir]);
    expect(readFileSync(join(repository, ".env.development.local"), "utf8"))
      .toContain("VITE_SUPABASE_URL=https://local.example.test/supabase");
  });

  test("creates a project network bound to loopback before startup", async () => {
    const repository = join(mkdtempSync(join(tmpdir(), "supadrum-start-")), "PreSnap");
    mkdirSync(join(repository, "supabase"), { recursive: true });
    writeFileSync(join(repository, "package.json"),
      '{"devDependencies":{"vite":"^7.0.0"}}');
    writeFileSync(join(repository, "supabase", "config.toml"),
      '[auth]\nexternal_url = "https://dev-api.presnap.co"\n');
    const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
    const result = await startLocalStack(repository, async (command, args, cwd) => {
      calls.push({ command, args, ...(cwd ? { cwd } : {}) });
      if (args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "status") return ok('ANON_KEY="local-public-key"');
      return ok("credentials that must not escape");
    });

    expect(localNetworkName(repository)).toMatch(/^supadrum-presnap-[a-f0-9]{8}-loopback$/);
    expect(calls[1]?.args).toContain("com.docker.network.bridge.host_binding_ipv4=127.0.0.1");
    expect(calls[2]).toEqual({
      command: "supabase",
      args: ["start", "--network-id", localNetworkName(repository)],
      cwd: repository
    });
    expect(calls[3]?.args).toEqual(["status", "-o", "env"]);
    expect(result).toBe(
      "Local Supabase stack started on loopback; Vite environment updated."
    );
    expect(result).not.toContain("credentials");
  });

  test("refuses an existing network that could publish on the LAN", async () => {
    const execute = async (): Promise<CommandResult> => ok('[{"Options":{}}]');
    await expect(startLocalStack("/workspace/presnap", execute))
      .rejects.toThrow("is not bound to loopback");
  });

  test("accepts a valid existing network regardless of Docker JSON formatting", async () => {
    const repository = mkdtempSync(join(tmpdir(), "supadrum-inspect-"));
    mkdirSync(join(repository, "supabase"));
    writeFileSync(join(repository, "supabase", "config.toml"), "[auth]\n");
    const calls: string[] = [];
    const result = await startLocalStack(repository, async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "docker")
        return ok('[{"Options":{"com.docker.network.bridge.host_binding_ipv4":"127.0.0.1"}}]');
      if (args[0] === "status") return ok('ANON_KEY="public-local-key"');
      return ok();
    });
    expect(result).toBe("Local Supabase stack started on loopback.");
    expect(calls.some((call) => call.startsWith("docker network create"))).toBe(false);
  });
});

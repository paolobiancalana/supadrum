import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  installCodexAgentSetup,
  inspectCodexAgentSetup
} from "../src/agent-setup.js";

const skillSource = join(
  process.cwd(),
  "plugins",
  "supadrum",
  "skills",
  "supadrum"
);

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "supadrum-agent-setup-"));
  mkdirSync(join(root, ".codex"), { recursive: true });
  return root;
}

describe("Codex agent setup", () => {
  test("installs the repository skill and broker while preserving existing guidance", () => {
    const root = repository();
    const codexConfig = join(root, ".codex", "config.toml");
    writeFileSync(
      codexConfig,
      [
        "model_reasoning_effort = \"high\"",
        "",
        "[mcp_servers.supabase]",
        "enabled = true",
        "",
        "[mcp_servers.supabase_fanta]",
        "url = \"https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst\"",
        "auth = \"oauth\"",
        "",
        "[mcp_servers.context7]",
        "url = \"https://mcp.context7.com/mcp\"",
        ""
      ].join("\n")
    );
    writeFileSync(
      join(root, "AGENTS.md"),
      "# Existing guidance\n\nKeep this instruction.\n"
    );

    const report = installCodexAgentSetup({
      repository: root,
      configPath: "/operator/supadrum/config.yml",
      skillSource,
      mcpCommand: "/usr/local/bin/node",
      mcpArgs: ["/opt/supadrum/dist/mcp.js"],
      mcpCwd: "/opt/supadrum"
    });

    const configured = readFileSync(codexConfig, "utf8");
    expect(configured).toContain('model_reasoning_effort = "high"');
    expect(configured).toMatch(
      /\[mcp_servers\.supabase\]\nenabled = false/
    );
    expect(configured).toMatch(
      /\[mcp_servers\.supabase_fanta\][\s\S]*?enabled = false/
    );
    expect(configured).toContain(
      '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"'
    );
    expect(configured).toContain(
      'command = "/usr/local/bin/node"'
    );
    expect(configured).toContain(
      'args = ["/opt/supadrum/dist/mcp.js"]'
    );
    expect(configured).toContain(
      'cwd = "/opt/supadrum"'
    );
    expect(configured).toContain(
      'SUPADRUM_CONFIG = "/operator/supadrum/config.yml"'
    );

    const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Keep this instruction.");
    expect(instructions).toContain("$supadrum");

    const installedSkill = join(
      root,
      ".agents",
      "skills",
      "supadrum",
      "SKILL.md"
    );
    expect(readFileSync(installedSkill, "utf8")).toContain(
      "name: supadrum"
    );
    expect(report).toEqual({
      repository: root,
      skillPath: installedSkill,
      codexConfigPath: codexConfig,
      agentsPath: join(root, "AGENTS.md"),
      restartRequired: true
    });
    expect(
      inspectCodexAgentSetup({
        repository: root,
        configPath: "/operator/supadrum/config.yml",
        mcpCommand: "/usr/local/bin/node",
        mcpArgs: ["/opt/supadrum/dist/mcp.js"],
        mcpCwd: "/opt/supadrum"
      })
    ).toEqual({
      skill: true,
      mcp: true,
      instructions: true,
      ready: true
    });
  });

  test("refreshes only managed content and remains byte-stable on repeated setup", () => {
    const root = repository();

    installCodexAgentSetup({
      repository: root,
      configPath: "/operator/old.yml",
      skillSource,
      mcpCommand: "supadrum-mcp"
    });
    installCodexAgentSetup({
      repository: root,
      configPath: "/operator/current.yml",
      skillSource,
      mcpCommand: "supadrum-mcp"
    });

    const codexConfig = join(root, ".codex", "config.toml");
    const agentsPath = join(root, "AGENTS.md");
    const afterRefresh = {
      config: readFileSync(codexConfig, "utf8"),
      agents: readFileSync(agentsPath, "utf8")
    };
    expect(afterRefresh.config).not.toContain("/operator/old.yml");
    expect(afterRefresh.config.match(/supadrum managed: start/g)).toHaveLength(
      1
    );
    expect(afterRefresh.agents.match(/supadrum managed: start/g)).toHaveLength(
      1
    );

    installCodexAgentSetup({
      repository: root,
      configPath: "/operator/current.yml",
      skillSource,
      mcpCommand: "supadrum-mcp"
    });

    expect(readFileSync(codexConfig, "utf8")).toBe(afterRefresh.config);
    expect(readFileSync(agentsPath, "utf8")).toBe(afterRefresh.agents);
  });
});

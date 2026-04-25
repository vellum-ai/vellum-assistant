import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { installAcpConfigStub } from "./__tests__/helpers/acp-config-stub.js";
import { installWhichStub } from "./__tests__/helpers/which-stub.js";

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

const { resolveAcpAgent, listAcpAgents } = await import("./resolve-agent.js");

beforeEach(() => {
  config.setConfig({});
  // Default: every command on PATH so binary preflight passes unless a test
  // explicitly says otherwise.
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
});

// ---------------------------------------------------------------------------
// resolveAcpAgent
// ---------------------------------------------------------------------------

describe("resolveAcpAgent", () => {
  test("returns acp_disabled when config.acp.enabled is false", () => {
    config.setConfig({ enabled: false });

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("acp_disabled");
    if (result.reason !== "acp_disabled") return;
    expect(result.hint).toContain("acp.enabled");
    expect(result.hint).toContain("config.json");
  });

  test("user config wins over default profile", () => {
    config.setConfig({
      agents: {
        claude: {
          command: "my-custom-claude",
          args: ["--my-flag"],
          description: "user override",
        },
      },
    });

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe("my-custom-claude");
    expect(result.agent.args).toEqual(["--my-flag"]);
    expect(result.agent.description).toBe("user override");
  });

  test("falls back to default profile when no user entry", () => {
    config.setConfig({ agents: {} });

    const result = resolveAcpAgent("codex");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe("codex-acp");
    expect(result.agent.description).toContain("@zed-industries/codex-acp");
  });

  test("falls back to default profile for claude when no user entry", () => {
    config.setConfig({ agents: {} });

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.command).toBe("claude-agent-acp");
  });

  test("returns unknown_agent with merged available list when id not found", () => {
    config.setConfig({
      agents: {
        "user-only": { command: "some-binary", args: [] },
      },
    });

    const result = resolveAcpAgent("nonexistent");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_agent");
    if (result.reason !== "unknown_agent") return;
    // Defaults plus user-only ids, deduped, in stable order (defaults first).
    expect(result.available).toEqual(["claude", "codex", "user-only"]);
  });

  test("unknown_agent available list contains both defaults when user config is empty", () => {
    config.setConfig({ agents: {} });

    const result = resolveAcpAgent("nonexistent");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_agent");
    if (result.reason !== "unknown_agent") return;
    expect(result.available).toContain("claude");
    expect(result.available).toContain("codex");
  });

  test("returns binary_not_found with the registered install hint", () => {
    config.setConfig({ agents: {} });
    which.setWhich({}); // no commands on PATH

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe("npm i -g @agentclientprotocol/claude-agent-acp");
    expect(result.command).toBe("claude-agent-acp");
  });

  test("binary_not_found uses generic hint for user-only commands without a registered hint", () => {
    config.setConfig({
      agents: {
        custom: { command: "unknown-binary", args: [] },
      },
    });
    which.setWhich({});

    const result = resolveAcpAgent("custom");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe(
      "Install 'unknown-binary' and ensure it is on PATH.",
    );
    expect(result.command).toBe("unknown-binary");
  });

  test("binary_not_found uses the install hint based on the resolved command, not the agent id", () => {
    // User aliases id "claude" to the codex binary — the install hint should
    // follow the binary, not the id.
    config.setConfig({
      agents: {
        claude: { command: "codex-acp", args: [] },
      },
    });
    which.setWhich({});

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe("npm i -g @zed-industries/codex-acp");
  });

  test("ok result when user config provides agent and binary is on PATH", () => {
    config.setConfig({
      agents: {
        codex: { command: "codex-acp", args: ["--verbose"] },
      },
    });
    which.setWhich({ "codex-acp": "/opt/bin/codex-acp" });

    const result = resolveAcpAgent("codex");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.args).toEqual(["--verbose"]);
  });
});

// ---------------------------------------------------------------------------
// listAcpAgents
// ---------------------------------------------------------------------------

describe("listAcpAgents", () => {
  test("returns enabled: false with empty agents when ACP is disabled", () => {
    config.setConfig({ enabled: false });

    const result = listAcpAgents();

    expect(result.enabled).toBe(false);
    expect(result.agents).toEqual([]);
  });

  test("includes both bundled defaults when user config is empty", () => {
    config.setConfig({ agents: {} });

    const result = listAcpAgents();

    expect(result.enabled).toBe(true);
    const ids = result.agents.map((a) => a.id);
    expect(ids).toEqual(["claude", "codex"]);
    for (const entry of result.agents) {
      expect(entry.source).toBe("default");
      expect(entry.available).toBe(true);
      expect(entry.unavailableReason).toBeUndefined();
      expect(entry.setupHint).toBeUndefined();
    }
  });

  test("user override flips source to 'config' for the overridden id", () => {
    config.setConfig({
      agents: {
        claude: {
          command: "my-claude",
          args: [],
          description: "custom",
        },
      },
    });
    which.setWhich({
      "my-claude": "/usr/bin/my-claude",
      "codex-acp": "/usr/bin/codex-acp",
    });

    const result = listAcpAgents();

    const claude = result.agents.find((a) => a.id === "claude");
    const codex = result.agents.find((a) => a.id === "codex");
    expect(claude?.source).toBe("config");
    expect(claude?.command).toBe("my-claude");
    expect(claude?.description).toBe("custom");
    expect(codex?.source).toBe("default");
  });

  test("unavailable agent surfaces install hint derived from DEFAULT_AGENT_NPM_PACKAGES", () => {
    config.setConfig({ agents: {} });
    which.setWhich({ "claude-agent-acp": "/usr/bin/claude-agent-acp" });

    const result = listAcpAgents();

    const codex = result.agents.find((a) => a.id === "codex");
    expect(codex?.available).toBe(false);
    expect(codex?.unavailableReason).toBe("'codex-acp' is not on PATH");
    expect(codex?.setupHint).toBe("npm i -g @zed-industries/codex-acp");
  });

  test("user-only agent appended after defaults in stable order", () => {
    config.setConfig({
      agents: {
        "my-agent": {
          command: "my-binary",
          args: [],
          description: "user-only",
        },
      },
    });
    which.setWhich({
      "claude-agent-acp": "/x",
      "codex-acp": "/x",
      "my-binary": "/x",
    });

    const result = listAcpAgents();

    expect(result.agents.map((a) => a.id)).toEqual([
      "claude",
      "codex",
      "my-agent",
    ]);
    const userOnly = result.agents[2];
    expect(userOnly.source).toBe("config");
    expect(userOnly.description).toBe("user-only");
  });

  test("unavailable user-only agent without registered hint falls back to generic install hint", () => {
    config.setConfig({
      agents: {
        custom: { command: "unknown-binary", args: [] },
      },
    });
    which.setWhich({ "claude-agent-acp": "/x", "codex-acp": "/x" });

    const result = listAcpAgents();

    const custom = result.agents.find((a) => a.id === "custom");
    expect(custom?.available).toBe(false);
    expect(custom?.setupHint).toBe(
      "Install 'unknown-binary' and ensure it is on PATH.",
    );
  });
});

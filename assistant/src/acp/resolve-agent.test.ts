import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AcpAgentConfig } from "../config/acp-schema.js";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

interface MockAcpConfig {
  enabled: boolean;
  maxConcurrentSessions: number;
  agents: Record<string, AcpAgentConfig>;
}

let mockAcpConfig: MockAcpConfig = {
  enabled: true,
  maxConcurrentSessions: 4,
  agents: {},
};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ acp: mockAcpConfig }),
}));

// Swap Bun.which with a stub so tests can deterministically simulate "binary
// on PATH" / "binary missing" without depending on the host environment.
// `mock.module` does not work for globals, so we capture the original and
// restore in afterAll to keep this test file from leaking into others.
const originalWhich = Bun.which;
let whichStub: (command: string) => string | null = () => null;
(Bun as unknown as { which: (cmd: string) => string | null }).which = (cmd) =>
  whichStub(cmd);

afterAll(() => {
  (Bun as unknown as { which: typeof originalWhich }).which = originalWhich;
});

const { resolveAcpAgent, listAcpAgents } = await import("./resolve-agent.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setConfig(partial: Partial<MockAcpConfig>): void {
  mockAcpConfig = {
    enabled: true,
    maxConcurrentSessions: 4,
    agents: {},
    ...partial,
  };
}

function setWhich(map: Record<string, string | null>): void {
  whichStub = (cmd) => map[cmd] ?? null;
}

beforeEach(() => {
  setConfig({});
  // Default: every command on PATH so binary preflight passes unless a test
  // explicitly says otherwise.
  whichStub = (cmd) => `/usr/local/bin/${cmd}`;
});

// ---------------------------------------------------------------------------
// resolveAcpAgent
// ---------------------------------------------------------------------------

describe("resolveAcpAgent", () => {
  test("returns acp_disabled when config.acp.enabled is false", () => {
    setConfig({ enabled: false });

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("acp_disabled");
    if (result.reason !== "acp_disabled") return;
    expect(result.hint).toContain("acp.enabled");
    expect(result.hint).toContain("config.json");
  });

  test("user config wins over default profile", () => {
    setConfig({
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
    expect(result.source).toBe("config");
    expect(result.agent.command).toBe("my-custom-claude");
    expect(result.agent.args).toEqual(["--my-flag"]);
    expect(result.agent.description).toBe("user override");
  });

  test("falls back to default profile when no user entry", () => {
    setConfig({ agents: {} });

    const result = resolveAcpAgent("codex");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("default");
    expect(result.agent.command).toBe("codex-acp");
    expect(result.agent.description).toContain("@zed-industries/codex-acp");
  });

  test("falls back to default profile for claude when no user entry", () => {
    setConfig({ agents: {} });

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("default");
    expect(result.agent.command).toBe("claude-agent-acp");
  });

  test("returns unknown_agent with merged available list when id not found", () => {
    setConfig({
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
    expect(result.hint).toContain("nonexistent");
  });

  test("unknown_agent available list contains both defaults when user config is empty", () => {
    setConfig({ agents: {} });

    const result = resolveAcpAgent("nonexistent");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_agent");
    if (result.reason !== "unknown_agent") return;
    expect(result.available).toContain("claude");
    expect(result.available).toContain("codex");
  });

  test("returns binary_not_found with the registered install hint", () => {
    setConfig({ agents: {} });
    setWhich({}); // no commands on PATH

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe("npm i -g @agentclientprotocol/claude-agent-acp");
    expect(result.agent.command).toBe("claude-agent-acp");
    expect(result.source).toBe("default");
  });

  test("binary_not_found uses generic hint for user-only commands without a registered hint", () => {
    setConfig({
      agents: {
        custom: { command: "unknown-binary", args: [] },
      },
    });
    setWhich({});

    const result = resolveAcpAgent("custom");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe(
      "Install 'unknown-binary' and ensure it is on PATH.",
    );
    expect(result.source).toBe("config");
  });

  test("binary_not_found uses the install hint based on the resolved command, not the agent id", () => {
    // User aliases id "claude" to the codex binary — the install hint should
    // follow the binary, not the id.
    setConfig({
      agents: {
        claude: { command: "codex-acp", args: [] },
      },
    });
    setWhich({});

    const result = resolveAcpAgent("claude");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("binary_not_found");
    if (result.reason !== "binary_not_found") return;
    expect(result.hint).toBe("npm i -g @zed-industries/codex-acp");
  });

  test("ok result when user config provides agent and binary is on PATH", () => {
    setConfig({
      agents: {
        codex: { command: "codex-acp", args: ["--verbose"] },
      },
    });
    setWhich({ "codex-acp": "/opt/bin/codex-acp" });

    const result = resolveAcpAgent("codex");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("config");
    expect(result.agent.args).toEqual(["--verbose"]);
  });
});

// ---------------------------------------------------------------------------
// listAcpAgents
// ---------------------------------------------------------------------------

describe("listAcpAgents", () => {
  test("returns enabled: false with empty agents when ACP is disabled", () => {
    setConfig({ enabled: false });

    const result = listAcpAgents();

    expect(result.enabled).toBe(false);
    expect(result.agents).toEqual([]);
  });

  test("includes both bundled defaults when user config is empty", () => {
    setConfig({ agents: {} });

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
    setConfig({
      agents: {
        claude: {
          command: "my-claude",
          args: [],
          description: "custom",
        },
      },
    });
    setWhich({
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

  test("unavailable agent surfaces install hint from DEFAULT_AGENT_INSTALL_HINTS", () => {
    setConfig({ agents: {} });
    setWhich({ "claude-agent-acp": "/usr/bin/claude-agent-acp" });

    const result = listAcpAgents();

    const codex = result.agents.find((a) => a.id === "codex");
    expect(codex?.available).toBe(false);
    expect(codex?.unavailableReason).toBe("'codex-acp' is not on PATH");
    expect(codex?.setupHint).toBe("npm i -g @zed-industries/codex-acp");
  });

  test("user-only agent appended after defaults in stable order", () => {
    setConfig({
      agents: {
        "my-agent": {
          command: "my-binary",
          args: [],
          description: "user-only",
        },
      },
    });
    setWhich({
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
    setConfig({
      agents: {
        custom: { command: "unknown-binary", args: [] },
      },
    });
    setWhich({ "claude-agent-acp": "/x", "codex-acp": "/x" });

    const result = listAcpAgents();

    const custom = result.agents.find((a) => a.id === "custom");
    expect(custom?.available).toBe(false);
    expect(custom?.setupHint).toBe(
      "Install 'unknown-binary' and ensure it is on PATH.",
    );
  });
});

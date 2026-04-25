import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AcpAgentConfig } from "../../config/acp-schema.js";
import type { ToolContext } from "../types.js";

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

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ acp: mockAcpConfig }),
}));

// Swap Bun.which with a stub so tests can deterministically simulate "binary
// on PATH" / "binary missing" without depending on the host environment.
const originalWhich = Bun.which;
let whichStub: (command: string) => string | null = () => null;
(Bun as unknown as { which: (cmd: string) => string | null }).which = (cmd) =>
  whichStub(cmd);

afterAll(() => {
  (Bun as unknown as { which: typeof originalWhich }).which = originalWhich;
});

const { executeAcpListAgents } = await import("./list-agents.js");

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

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-test",
    trustClass: "guardian",
  };
}

beforeEach(() => {
  setConfig({});
  // Default: every command on PATH so binary preflight passes unless a test
  // explicitly says otherwise.
  whichStub = (cmd) => `/usr/local/bin/${cmd}`;
});

// ---------------------------------------------------------------------------
// executeAcpListAgents
// ---------------------------------------------------------------------------

describe("executeAcpListAgents", () => {
  test("returns disabled hint when ACP is disabled", async () => {
    setConfig({ enabled: false });

    const result = await executeAcpListAgents({}, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content as string);
    expect(parsed).toEqual({
      enabled: false,
      hint: "Set 'acp.enabled': true to use ACP agents.",
    });
  });

  test("enabled, no user config: both defaults present with source 'default' and available based on Bun.which", async () => {
    setConfig({ agents: {} });

    const result = await executeAcpListAgents({}, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.enabled).toBe(true);
    expect(parsed.agents.map((a: { id: string }) => a.id)).toEqual([
      "claude",
      "codex",
    ]);
    for (const entry of parsed.agents) {
      expect(entry.source).toBe("default");
      expect(entry.available).toBe(true);
      expect(entry.unavailableReason).toBeUndefined();
      expect(entry.setupHint).toBeUndefined();
    }
  });

  test("enabled, user overrides claude: claude has source 'config' and the user's command", async () => {
    setConfig({
      agents: {
        claude: {
          command: "my-claude-bin",
          args: [],
          description: "user override",
        },
      },
    });

    const result = await executeAcpListAgents({}, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.enabled).toBe(true);

    const claude = parsed.agents.find((a: { id: string }) => a.id === "claude");
    expect(claude.source).toBe("config");
    expect(claude.command).toBe("my-claude-bin");
    expect(claude.description).toBe("user override");
    expect(claude.available).toBe(true);

    const codex = parsed.agents.find((a: { id: string }) => a.id === "codex");
    expect(codex.source).toBe("default");
  });

  test("unavailable agent surfaces setupHint from DEFAULT_AGENT_INSTALL_HINTS", async () => {
    setConfig({ agents: {} });
    setWhich({ "claude-agent-acp": "/usr/local/bin/claude-agent-acp" });

    const result = await executeAcpListAgents({}, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content as string);

    const codex = parsed.agents.find((a: { id: string }) => a.id === "codex");
    expect(codex.available).toBe(false);
    expect(codex.unavailableReason).toBe("'codex-acp' is not on PATH");
    expect(codex.setupHint).toBe("npm i -g @zed-industries/codex-acp");

    const claude = parsed.agents.find((a: { id: string }) => a.id === "claude");
    expect(claude.available).toBe(true);
    expect(claude.setupHint).toBeUndefined();
  });
});

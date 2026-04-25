import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { installAcpConfigStub } from "../../acp/__tests__/helpers/acp-config-stub.js";
import { installWhichStub } from "../../acp/__tests__/helpers/which-stub.js";
import type { ToolContext } from "../types.js";

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

const { executeAcpListAgents } = await import("./list-agents.js");

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-test",
    trustClass: "guardian",
  };
}

beforeEach(() => {
  config.setConfig({});
  // Default: every command on PATH so binary preflight passes unless a test
  // explicitly says otherwise.
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
});

// ---------------------------------------------------------------------------
// executeAcpListAgents
// ---------------------------------------------------------------------------

describe("executeAcpListAgents", () => {
  test("returns disabled hint when ACP is disabled", async () => {
    config.setConfig({ enabled: false });

    const result = await executeAcpListAgents({}, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.enabled).toBe(false);
    // Pulls from the shared ACP_DISABLED_HINT constant exported by
    // resolve-agent.ts. The exact wording is checked in resolve-agent.test.ts.
    expect(parsed.hint).toContain("acp.enabled");
    expect(parsed.hint).toContain("config.json");
  });

  test("enabled, no user config: both defaults present with source 'default' and available based on Bun.which", async () => {
    config.setConfig({ agents: {} });

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
    config.setConfig({
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

  test("unavailable agent surfaces setupHint derived from DEFAULT_AGENT_NPM_PACKAGES", async () => {
    config.setConfig({ agents: {} });
    which.setWhich({ "claude-agent-acp": "/usr/local/bin/claude-agent-acp" });

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

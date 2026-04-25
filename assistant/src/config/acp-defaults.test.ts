import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ACP_AGENT_PROFILES,
  DEFAULT_AGENT_NPM_PACKAGES,
} from "./acp-defaults.js";

describe("DEFAULT_ACP_AGENT_PROFILES", () => {
  test("ships exactly the expected agent ids", () => {
    expect(Object.keys(DEFAULT_ACP_AGENT_PROFILES).sort()).toEqual([
      "claude",
      "codex",
    ]);
  });

  test("claude profile uses the @agentclientprotocol adapter binary", () => {
    expect(DEFAULT_ACP_AGENT_PROFILES.claude).toEqual({
      command: "claude-agent-acp",
      args: [],
      description: "Claude Code (via @agentclientprotocol/claude-agent-acp)",
    });
  });

  test("codex profile uses the @zed-industries adapter binary", () => {
    expect(DEFAULT_ACP_AGENT_PROFILES.codex).toEqual({
      command: "codex-acp",
      args: [],
      description: "OpenAI Codex CLI (via @zed-industries/codex-acp)",
    });
  });

  test("is frozen at runtime so mutation throws in strict mode", () => {
    expect(Object.isFrozen(DEFAULT_ACP_AGENT_PROFILES)).toBe(true);
    for (const profile of Object.values(DEFAULT_ACP_AGENT_PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true);
    }
  });
});

describe("DEFAULT_AGENT_NPM_PACKAGES", () => {
  test("is keyed by command name with the canonical npm package", () => {
    expect(DEFAULT_AGENT_NPM_PACKAGES).toEqual({
      "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
      "codex-acp": "@zed-industries/codex-acp",
    });
  });

  test("every default profile's command has a matching npm package", () => {
    for (const profile of Object.values(DEFAULT_ACP_AGENT_PROFILES)) {
      expect(DEFAULT_AGENT_NPM_PACKAGES[profile.command]).toBeDefined();
    }
  });

  test("is frozen at runtime so mutation throws in strict mode", () => {
    expect(Object.isFrozen(DEFAULT_AGENT_NPM_PACKAGES)).toBe(true);
  });
});

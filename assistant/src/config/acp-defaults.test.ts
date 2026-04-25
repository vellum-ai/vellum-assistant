import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ACP_AGENT_PROFILES,
  DEFAULT_AGENT_INSTALL_HINTS,
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

describe("DEFAULT_AGENT_INSTALL_HINTS", () => {
  test("is keyed by command name, not agent id", () => {
    expect(Object.keys(DEFAULT_AGENT_INSTALL_HINTS).sort()).toEqual([
      "claude-agent-acp",
      "codex-acp",
    ]);
  });

  test("hints reference the new @agentclientprotocol package for claude", () => {
    expect(DEFAULT_AGENT_INSTALL_HINTS["claude-agent-acp"]).toBe(
      "npm i -g @agentclientprotocol/claude-agent-acp",
    );
  });

  test("hints reference the @zed-industries package for codex", () => {
    expect(DEFAULT_AGENT_INSTALL_HINTS["codex-acp"]).toBe(
      "npm i -g @zed-industries/codex-acp",
    );
  });

  test("every default profile's command has a matching install hint", () => {
    for (const profile of Object.values(DEFAULT_ACP_AGENT_PROFILES)) {
      expect(DEFAULT_AGENT_INSTALL_HINTS[profile.command]).toBeDefined();
    }
  });

  test("is frozen at runtime so mutation throws in strict mode", () => {
    expect(Object.isFrozen(DEFAULT_AGENT_INSTALL_HINTS)).toBe(true);
  });

  test("readonly type rejects mutation at compile time", () => {
    const _assignNewKey: () => void = () => {
      // @ts-expect-error — DEFAULT_AGENT_INSTALL_HINTS has a Readonly index signature
      DEFAULT_AGENT_INSTALL_HINTS["new-binary"] = "npm i -g foo";
    };
    const _assignNewProfile: () => void = () => {
      // @ts-expect-error — DEFAULT_ACP_AGENT_PROFILES has a Readonly index signature
      DEFAULT_ACP_AGENT_PROFILES.newAgent = { command: "x", args: [] };
    };
    // The assertions live in the @ts-expect-error comments above; this test
    // exists to surface a type-check failure if the readonly contract regresses.
    expect(_assignNewKey).toBeFunction();
    expect(_assignNewProfile).toBeFunction();
  });
});

describe("DEFAULT_AGENT_NPM_PACKAGES", () => {
  test("is keyed by command name with the canonical npm package", () => {
    expect(DEFAULT_AGENT_NPM_PACKAGES).toEqual({
      "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
      "codex-acp": "@zed-industries/codex-acp",
    });
  });

  test("is frozen at runtime so mutation throws in strict mode", () => {
    expect(Object.isFrozen(DEFAULT_AGENT_NPM_PACKAGES)).toBe(true);
  });

  test("DEFAULT_AGENT_INSTALL_HINTS is derived from DEFAULT_AGENT_NPM_PACKAGES", () => {
    for (const [command, pkg] of Object.entries(DEFAULT_AGENT_NPM_PACKAGES)) {
      expect(DEFAULT_AGENT_INSTALL_HINTS[command]).toBe(`npm i -g ${pkg}`);
    }
    // No extra keys in install hints that aren't in the npm map.
    expect(Object.keys(DEFAULT_AGENT_INSTALL_HINTS).sort()).toEqual(
      Object.keys(DEFAULT_AGENT_NPM_PACKAGES).sort(),
    );
  });
});

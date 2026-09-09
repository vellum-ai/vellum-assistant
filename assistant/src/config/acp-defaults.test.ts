import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ACP_AGENT_PROFILES,
  DEFAULT_AGENT_NPM_PACKAGES,
  splitPackageSpec,
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

  test("codex profile uses the @agentclientprotocol adapter binary", () => {
    expect(DEFAULT_ACP_AGENT_PROFILES.codex).toEqual({
      command: "codex-acp",
      args: [],
      description: "OpenAI Codex CLI (via @agentclientprotocol/codex-acp)",
    });
  });

  test("is deeply frozen so mutation throws in strict mode", () => {
    expect(Object.isFrozen(DEFAULT_ACP_AGENT_PROFILES)).toBe(true);
    for (const profile of Object.values(DEFAULT_ACP_AGENT_PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true);
      // `args` arrays must also be frozen — `Object.freeze` is shallow, so
      // an unfrozen `args` would let one caller silently corrupt every other
      // read of the shared default via `.push(...)` / `.splice(...)`.
      expect(Object.isFrozen(profile.args)).toBe(true);
    }
  });
});

describe("DEFAULT_AGENT_NPM_PACKAGES", () => {
  test("is keyed by command name with the pinned npm package spec", () => {
    expect(DEFAULT_AGENT_NPM_PACKAGES).toEqual({
      "claude-agent-acp": "@agentclientprotocol/claude-agent-acp@0.75.1",
      "codex-acp": "@agentclientprotocol/codex-acp@1.10.0",
    });
  });

  test("every spec pins an exact version", () => {
    for (const spec of Object.values(DEFAULT_AGENT_NPM_PACKAGES)) {
      const { name, version } = splitPackageSpec(spec);
      expect(name.startsWith("@agentclientprotocol/")).toBe(true);
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
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

describe("splitPackageSpec", () => {
  test("splits a scoped spec without eating the scope's leading @", () => {
    expect(splitPackageSpec("@agentclientprotocol/codex-acp@1.10.0")).toEqual({
      name: "@agentclientprotocol/codex-acp",
      version: "1.10.0",
    });
  });

  test("splits an unscoped spec", () => {
    expect(splitPackageSpec("codex-acp@1.10.0")).toEqual({
      name: "codex-acp",
      version: "1.10.0",
    });
  });

  test("reports no version for a bare name, scoped or not", () => {
    expect(splitPackageSpec("@agentclientprotocol/codex-acp")).toEqual({
      name: "@agentclientprotocol/codex-acp",
    });
    expect(splitPackageSpec("codex-acp")).toEqual({ name: "codex-acp" });
  });
});

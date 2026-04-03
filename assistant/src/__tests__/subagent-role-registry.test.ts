import { describe, expect, test } from "bun:test";

import {
  SUBAGENT_ROLE_REGISTRY,
  type SubagentRole,
} from "../subagent/index.js";

/** All roles defined in the SubagentRole union. */
const ALL_ROLES: SubagentRole[] = [
  "general",
  "researcher",
  "coder",
  "planner",
];

describe("SUBAGENT_ROLE_REGISTRY", () => {
  test("covers all values in the SubagentRole union", () => {
    const registryKeys = Object.keys(SUBAGENT_ROLE_REGISTRY);
    expect(registryKeys.sort()).toEqual([...ALL_ROLES].sort());
    expect(registryKeys).toHaveLength(ALL_ROLES.length);
  });

  test("every role has a non-empty systemPromptPreamble", () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      expect(config.systemPromptPreamble.length).toBeGreaterThan(0);
    }
  });

  test("general has allowedTools: undefined", () => {
    expect(SUBAGENT_ROLE_REGISTRY.general.allowedTools).toBeUndefined();
  });

  test("all non-general roles have allowedTools as a non-empty array", () => {
    for (const role of ALL_ROLES) {
      if (role === "general") continue;
      const config = SUBAGENT_ROLE_REGISTRY[role];
      expect(Array.isArray(config.allowedTools)).toBe(true);
      expect(config.allowedTools!.length).toBeGreaterThan(0);
    }
  });

  test('every role with allowedTools includes "notify_parent"', () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      if (config.allowedTools !== undefined) {
        expect(config.allowedTools).toContain("notify_parent");
      }
    }
  });
});

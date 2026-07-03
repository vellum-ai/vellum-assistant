import { describe, expect, test } from "bun:test";

import {
  mergeSkillIds,
  SUBAGENT_ROLE_REGISTRY,
  type SubagentRole,
} from "../subagent/index.js";

/** All roles defined in the SubagentRole union. */
const ALL_ROLES: SubagentRole[] = [
  "general",
  "researcher",
  "coder",
  "planner",
  "investigator",
  "advisor",
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

  test("all scoped tool-using roles have allowedTools as a non-empty array", () => {
    for (const role of ALL_ROLES) {
      // 'general' has no filter (undefined); 'advisor' is tool-less (empty).
      if (role === "general" || role === "advisor") continue;
      const config = SUBAGENT_ROLE_REGISTRY[role];
      expect(Array.isArray(config.allowedTools)).toBe(true);
      expect(config.allowedTools!.length).toBeGreaterThan(0);
    }
  });

  test("advisor is tool-less with an empty allowedTools array", () => {
    const config = SUBAGENT_ROLE_REGISTRY.advisor;
    expect(config.allowedTools).toEqual([]);
  });

  test("SubagentRole type includes advisor", () => {
    const advisor: SubagentRole = "advisor";
    expect(SUBAGENT_ROLE_REGISTRY[advisor]).toBeDefined();
  });

  test('every role with a non-empty allowlist includes "notify_parent"', () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      // 'advisor' is tool-less (empty allowlist) and intentionally has none.
      if (config.allowedTools !== undefined && config.allowedTools.length > 0) {
        expect(config.allowedTools).toContain("notify_parent");
      }
    }
  });

  test('no role includes "skill_execute" (replaced by core tools)', () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      if (config.allowedTools !== undefined) {
        expect(config.allowedTools).not.toContain("skill_execute");
      }
    }
  });

  test('researcher includes "recall" for local information access', () => {
    const tools = SUBAGENT_ROLE_REGISTRY.researcher.allowedTools!;
    expect(tools).toContain("recall");
  });

  test('coder includes "recall" for local information access', () => {
    expect(SUBAGENT_ROLE_REGISTRY.coder.allowedTools!).toContain("recall");
  });

  test('planner includes "recall" for local information access', () => {
    expect(SUBAGENT_ROLE_REGISTRY.planner.allowedTools!).toContain("recall");
  });

  test("investigator is shell-free and uses code_search for code/log investigation", () => {
    const tools = SUBAGENT_ROLE_REGISTRY.investigator.allowedTools!;
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("host_bash");
    expect(tools).toContain("code_search");
  });

  test("investigator excludes file write tools (read-only investigation)", () => {
    const tools = SUBAGENT_ROLE_REGISTRY.investigator.allowedTools!;
    expect(tools).not.toContain("file_write");
    expect(tools).not.toContain("file_edit");
  });

  test("investigator preamble defines the root-cause report contract", () => {
    const preamble = SUBAGENT_ROLE_REGISTRY.investigator.systemPromptPreamble;
    expect(preamble).toContain("Root cause");
    expect(preamble).toContain("Evidence");
    expect(preamble).toContain("notify_parent");
    expect(preamble).not.toContain("shell access");
    expect(preamble).toContain("code_search");
  });

  test("no role references the old memory_recall tool name", () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      if (config.allowedTools !== undefined) {
        expect(config.allowedTools).not.toContain("memory_recall");
      }
    }
  });

  test("every role has empty skillIds (no skill preactivation)", () => {
    for (const [_role, config] of Object.entries(SUBAGENT_ROLE_REGISTRY)) {
      expect(config.skillIds).toEqual([]);
    }
  });

  test('researcher and planner include "file_list"', () => {
    expect(SUBAGENT_ROLE_REGISTRY.researcher.allowedTools).toContain(
      "file_list",
    );
    expect(SUBAGENT_ROLE_REGISTRY.planner.allowedTools).toContain("file_list");
  });
});

describe("mergeSkillIds", () => {
  test("removes duplicates between role and config skill IDs", () => {
    expect(mergeSkillIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("returns only role skills when config is undefined", () => {
    expect(mergeSkillIds(["subagent"], undefined)).toEqual(["subagent"]);
  });

  test("includes caller-provided extras alongside role skills", () => {
    expect(mergeSkillIds(["subagent"], ["custom-skill"])).toEqual([
      "subagent",
      "custom-skill",
    ]);
  });

  test("returns empty array when both inputs are empty", () => {
    expect(mergeSkillIds([], undefined)).toEqual([]);
  });
});

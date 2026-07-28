import { describe, expect, test } from "bun:test";

import { filterSkillsByEnabledPlugins, type SkillSummary } from "./skills.js";

function makeSkill(
  id: string,
  overrides: Partial<SkillSummary> = {},
): SkillSummary {
  return {
    id,
    name: id,
    displayName: id,
    description: `Skill ${id}`,
    directoryPath: `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,
    source: "managed",
    ...overrides,
  };
}

function makePluginSkill(id: string, pluginId: string): SkillSummary {
  return makeSkill(id, {
    source: "plugin",
    owner: { kind: "plugin", id: pluginId },
  });
}

describe("filterSkillsByEnabledPlugins", () => {
  test("null set is a no-op: returns the same array reference unchanged", () => {
    const skills = [
      makeSkill("bundled-one", { source: "bundled" }),
      makePluginSkill("from-a", "a"),
      makePluginSkill("from-b", "b"),
    ];

    const result = filterSkillsByEnabledPlugins(skills, null);

    expect(result).toBe(skills);
    expect(result.map((s) => s.id)).toEqual([
      "bundled-one",
      "from-a",
      "from-b",
    ]);
  });

  test("drops plugin skills whose owning plugin is outside the set", () => {
    const skills = [
      makeSkill("bundled-one", { source: "bundled" }),
      makePluginSkill("from-a", "a"),
      makePluginSkill("from-b", "b"),
    ];

    const result = filterSkillsByEnabledPlugins(skills, new Set(["a"]));

    expect(result.map((s) => s.id)).toEqual(["bundled-one", "from-a"]);
  });

  test("retains non-plugin skills even when the set is empty", () => {
    const skills = [
      makeSkill("bundled-one", { source: "bundled" }),
      makeSkill("managed-one", { source: "managed" }),
      makeSkill("workspace-one", { source: "workspace" }),
      makePluginSkill("from-a", "a"),
    ];

    const result = filterSkillsByEnabledPlugins(skills, new Set());

    expect(result.map((s) => s.id)).toEqual([
      "bundled-one",
      "managed-one",
      "workspace-one",
    ]);
  });

  test("keeps every plugin skill when all owners are in the set", () => {
    const skills = [
      makePluginSkill("from-a", "a"),
      makePluginSkill("from-b", "b"),
    ];

    const result = filterSkillsByEnabledPlugins(skills, new Set(["a", "b"]));

    expect(result.map((s) => s.id)).toEqual(["from-a", "from-b"]);
  });

  test("does not mutate the input array when filtering", () => {
    const skills = [
      makePluginSkill("from-a", "a"),
      makePluginSkill("from-b", "b"),
    ];

    filterSkillsByEnabledPlugins(skills, new Set(["a"]));

    expect(skills.map((s) => s.id)).toEqual(["from-a", "from-b"]);
  });
});

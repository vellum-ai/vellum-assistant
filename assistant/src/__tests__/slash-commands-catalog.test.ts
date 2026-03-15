import { describe, expect, test } from "bun:test";

import type { ResolvedSkill } from "../config/skill-state.js";
import type { SkillSummary } from "../config/skills.js";
import { buildInvocableSlashCatalog } from "../skills/slash-commands.js";

function makeSkill(
  id: string,
  overrides?: Partial<SkillSummary>,
): SkillSummary {
  return {
    id,
    name: overrides?.name ?? id,
    displayName: overrides?.displayName ?? overrides?.name ?? id,
    description: `Description for ${id}`,
    directoryPath: `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,
    userInvocable: overrides?.userInvocable ?? true,
    disableModelInvocation: false,
    source: "managed",
  };
}

function makeResolved(
  skill: SkillSummary,
  state: ResolvedSkill["state"],
): ResolvedSkill {
  return {
    summary: skill,
    state,
  };
}

describe("buildInvocableSlashCatalog", () => {
  test("excludes disabled skill", () => {
    const skill = makeSkill("my-skill");
    const catalog = [skill];
    const resolved = [makeResolved(skill, "disabled")];

    const result = buildInvocableSlashCatalog(catalog, resolved);
    expect(result.size).toBe(0);
  });

  test("excludes userInvocable: false skill", () => {
    const skill = makeSkill("hidden-skill", { userInvocable: false });
    const catalog = [skill];
    const resolved = [makeResolved(skill, "enabled")];

    const result = buildInvocableSlashCatalog(catalog, resolved);
    expect(result.size).toBe(0);
  });

  test("includes enabled invocable skill", () => {
    const skill = makeSkill("start-the-day", { name: "Start the Day" });
    const catalog = [skill];
    const resolved = [makeResolved(skill, "enabled")];

    const result = buildInvocableSlashCatalog(catalog, resolved);
    expect(result.size).toBe(1);
    const entry = result.get("start-the-day");
    expect(entry).toBeDefined();
    expect(entry!.canonicalId).toBe("start-the-day");
    expect(entry!.name).toBe("Start the Day");
  });

  test("includes available invocable skill", () => {
    const skill = makeSkill("available-skill");
    const catalog = [skill];
    const resolved = [makeResolved(skill, "available")];

    const result = buildInvocableSlashCatalog(catalog, resolved);
    expect(result.size).toBe(1);
  });

  test("excludes skill with no resolved state entry", () => {
    const skill = makeSkill("unresolved-skill");
    const catalog = [skill];
    const resolved: ResolvedSkill[] = [];

    const result = buildInvocableSlashCatalog(catalog, resolved);
    expect(result.size).toBe(0);
  });

  test("case-insensitive lookup key", () => {
    const skill = makeSkill("MySkill");
    const catalog = [skill];
    const resolved = [makeResolved(skill, "enabled")];

    const result = buildInvocableSlashCatalog(catalog, resolved);
    expect(result.get("myskill")).toBeDefined();
    expect(result.get("myskill")!.canonicalId).toBe("MySkill");
  });
});

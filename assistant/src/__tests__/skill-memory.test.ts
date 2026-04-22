import { describe, expect, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import { fromSkillSummary } from "../skills/skill-memory.js";

function makeSkillSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "test-skill",
    name: "test-skill",
    displayName: "Test Skill",
    description: "A skill for testing",
    directoryPath: "/skills/test-skill",
    skillFilePath: "/skills/test-skill/SKILL.md",
    source: "managed",
    ...overrides,
  };
}

// ─── fromSkillSummary ────────────────────────────────────────────────────────

describe("fromSkillSummary", () => {
  test("maps displayName from SkillSummary", () => {
    const entry = makeSkillSummary({ displayName: "Pretty Name" });
    const input = fromSkillSummary(entry);
    expect(input.displayName).toBe("Pretty Name");
  });

  test("maps activationHints from SkillSummary", () => {
    const hints = ["user asks to search", "needs web data"];
    const entry = makeSkillSummary({ activationHints: hints });
    const input = fromSkillSummary(entry);
    expect(input.activationHints).toEqual(hints);
  });

  test("leaves activationHints undefined when not present", () => {
    const entry = makeSkillSummary({ activationHints: undefined });
    const input = fromSkillSummary(entry);
    expect(input.activationHints).toBeUndefined();
  });

  test("maps avoidWhen from SkillSummary", () => {
    const cues = ["offline mode", "user wants local files only"];
    const entry = makeSkillSummary({ avoidWhen: cues });
    const input = fromSkillSummary(entry);
    expect(input.avoidWhen).toEqual(cues);
  });

  test("leaves avoidWhen undefined when not present", () => {
    const entry = makeSkillSummary({ avoidWhen: undefined });
    const input = fromSkillSummary(entry);
    expect(input.avoidWhen).toBeUndefined();
  });

  test("copies id and description directly", () => {
    const entry = makeSkillSummary({
      id: "my-id",
      description: "Does amazing things",
    });
    const input = fromSkillSummary(entry);
    expect(input.id).toBe("my-id");
    expect(input.description).toBe("Does amazing things");
  });
});

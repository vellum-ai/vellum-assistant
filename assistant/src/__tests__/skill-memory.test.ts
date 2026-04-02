import { describe, expect, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import {
  buildCapabilityStatement,
  fromSkillSummary,
  type SkillCapabilityInput,
} from "../skills/skill-memory.js";

function makeSkillSummary(
  overrides: Partial<SkillSummary> = {},
): SkillSummary {
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

// ─── buildCapabilityStatement ────────────────────────────────────────────────

describe("buildCapabilityStatement", () => {
  test("includes display name, id, and description", () => {
    const input: SkillCapabilityInput = {
      id: "test-skill",
      displayName: "My Skill",
      description: "A skill for testing",
    };
    const result = buildCapabilityStatement(input);
    expect(result).toContain('"My Skill"');
    expect(result).toContain("(test-skill)");
    expect(result).toContain("A skill for testing");
  });

  test("includes activation hints when present", () => {
    const input: SkillCapabilityInput = {
      id: "test-skill",
      displayName: "My Skill",
      description: "A skill for testing",
      activationHints: ["user asks to search", "needs web data"],
    };
    const result = buildCapabilityStatement(input);
    expect(result).toContain("Use when:");
    expect(result).toContain("user asks to search");
    expect(result).toContain("needs web data");
  });

  test("includes avoidWhen routing cues when present", () => {
    const input: SkillCapabilityInput = {
      id: "test-skill",
      displayName: "My Skill",
      description: "A skill for testing",
      avoidWhen: ["user wants local files only", "offline mode"],
    };
    const result = buildCapabilityStatement(input);
    expect(result).toContain("Avoid when:");
    expect(result).toContain("user wants local files only");
    expect(result).toContain("offline mode");
  });

  test("includes both activationHints and avoidWhen when present", () => {
    const input: SkillCapabilityInput = {
      id: "test-skill",
      displayName: "My Skill",
      description: "A skill for testing",
      activationHints: ["user asks to search"],
      avoidWhen: ["offline mode"],
    };
    const result = buildCapabilityStatement(input);
    expect(result).toContain("Use when: user asks to search.");
    expect(result).toContain("Avoid when: offline mode.");
  });

  test("works with just name as displayName", () => {
    const input: SkillCapabilityInput = {
      id: "test-skill",
      displayName: "Test Skill",
      description: "A skill for testing",
    };
    const result = buildCapabilityStatement(input);
    expect(result).toContain('"Test Skill"');
    expect(result).toContain("(test-skill)");
    expect(result).toContain("A skill for testing");
  });

  test("truncates long statements to 500 chars", () => {
    const longDesc = "x".repeat(600);
    const input: SkillCapabilityInput = {
      id: "test-skill",
      displayName: "Test Skill",
      description: longDesc,
    };
    const result = buildCapabilityStatement(input);
    expect(result.length).toBe(500);
  });
});

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

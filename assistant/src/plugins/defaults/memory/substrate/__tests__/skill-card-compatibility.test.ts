import { describe, expect, test } from "bun:test";

import {
  SKILL_CARD_SUPPRESSIONS_METADATA_KEY,
  stripSuppressedSkillCards,
  suppressedSkillIdsForConversation,
} from "../skill-card-suppression.js";

describe("skill card suppression", () => {
  test("preserves unrelated cards in legacy unframed v3 blocks", () => {
    const block = [
      "# Skill: windows-automation\nAutomates Windows applications.",
      "# memory/concepts/project.md\nKeep this concept, including its full body.",
      "# Skill: other-skill\nKeep this unrelated skill.",
    ].join("\n\n");

    const filtered = stripSuppressedSkillCards(
      block,
      new Set(["windows-automation"]),
    );

    expect(filtered).toContain("# memory/concepts/project.md");
    expect(filtered).toContain("Keep this concept, including its full body.");
    expect(filtered).not.toContain("# Skill: windows-automation");
    expect(filtered).not.toContain("Automates Windows applications.");
    expect(filtered).toContain("# Skill: other-skill");
    expect(filtered).toContain("Keep this unrelated skill.");
  });

  test("preserves header-shaped text inside legacy concept cards", () => {
    const block = [
      "# memory/concepts/project.md",
      "Concept lead.",
      "# Skill: windows-automation",
      "This heading and trailing text belong to the concept body.",
      "# memory/concepts/next.md\nKeep the adjacent concept.",
    ].join("\n\n");

    expect(
      stripSuppressedSkillCards(block, new Set(["windows-automation"])),
    ).toBe(block);
  });

  test("strips headerless v1 skill entries by their embedded id", () => {
    const block = [
      '- [skill] The "Windows Automation" skill (windows-automation) is available. Automates Windows applications. → use skill_load to activate',
      "- (1d ago) Keep this ordinary memory.",
      '- [skill] The "Other Skill" skill (other-skill) is available. Handles another task. → use skill_load to activate',
    ].join("\n");

    const filtered = stripSuppressedSkillCards(
      block,
      new Set(["windows-automation"]),
    );

    expect(filtered).not.toContain("Windows Automation");
    expect(filtered).toContain("Keep this ordinary memory.");
    expect(filtered).toContain("Other Skill");
  });

  test("reads occurrence suppressions only for the target conversation", () => {
    const metadata = {
      [SKILL_CARD_SUPPRESSIONS_METADATA_KEY]: {
        "conv-a": ["windows-automation"],
        "conv-b": ["other-skill"],
      },
    };

    expect([...suppressedSkillIdsForConversation(metadata, "conv-a")]).toEqual([
      "windows-automation",
    ]);
    expect([...suppressedSkillIdsForConversation(metadata, "conv-b")]).toEqual([
      "other-skill",
    ]);
    expect([...suppressedSkillIdsForConversation(metadata, "conv-c")]).toEqual(
      [],
    );
  });
});

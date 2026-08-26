import { describe, expect, test } from "bun:test";

import { frameCardSection } from "../card-block-sections.js";
import {
  extractFramedCardSlugs,
  SKILL_CARD_SUPPRESSIONS_METADATA_KEY,
  stripSuppressedSkillCards,
  suppressedSkillIdsForConversation,
} from "../skill-card-suppression.js";

describe("skill card suppression", () => {
  test("extracts writer-owned card identities from framed blocks", () => {
    const block = [
      "preamble",
      frameCardSection("# memory/concepts/project.md\nConcept."),
      frameCardSection(
        '# Skill: windows-automation\nThe "Windows Automation" skill (windows-automation) is available.',
      ),
      frameCardSection("# CLI command: status\nShow status."),
    ].join("\n\n");

    expect(extractFramedCardSlugs(block)).toEqual([
      "project",
      "skills/windows-automation",
      "cli-commands/status",
    ]);
  });

  test("preserves unrelated cards in legacy unframed v3 blocks", () => {
    const block = [
      '# Skill: windows-automation\nThe "Windows Automation" skill (windows-automation) is available. Automates Windows applications.',
      "# memory/concepts/project.md\nKeep this concept, including its full body.",
      '# Skill: other-skill\nThe "Other Skill" skill (other-skill) is available. Keep this unrelated skill.',
    ].join("\n\n");

    const filtered = stripSuppressedSkillCards(
      block,
      new Set(["windows-automation"]),
      {
        legacyCardSlugs: [
          "skills/windows-automation",
          "project",
          "skills/other-skill",
        ],
      },
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
      stripSuppressedSkillCards(block, new Set(["windows-automation"]), {
        legacyCardSlugs: ["project", "next"],
      }),
    ).toBe(block);
  });

  test("strips real legacy skills that follow concept cards", () => {
    const block = [
      "# memory/concepts/project.md\nKeep the first concept.",
      '# Skill: windows-automation\nThe "Windows Automation" skill (windows-automation) is available. Automates Windows applications.',
      "# memory/concepts/next.md\nKeep the adjacent concept.",
    ].join("\n\n");

    const filtered = stripSuppressedSkillCards(
      block,
      new Set(["windows-automation"]),
      {
        legacyCardSlugs: ["project", "skills/windows-automation", "next"],
      },
    );

    expect(filtered).toContain("Keep the first concept.");
    expect(filtered).not.toContain("# Skill: windows-automation");
    expect(filtered).not.toContain("Automates Windows applications.");
    expect(filtered).toContain("Keep the adjacent concept.");
  });

  test("withholds ambiguous legacy blocks without occurrence metadata", () => {
    const block = [
      "# memory/concepts/project.md",
      "Concept lead.",
      "# Skill: windows-automation",
      'The "Windows Automation" skill (windows-automation) is available.',
    ].join("\n\n");

    expect(
      stripSuppressedSkillCards(block, new Set(["windows-automation"])),
    ).toBe("");
    expect(stripSuppressedSkillCards(block, new Set())).toBe(block);
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

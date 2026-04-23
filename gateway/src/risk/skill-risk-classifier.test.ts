import { describe, expect, test } from "bun:test";

import type { ResolvedSkillMetadata } from "./skill-risk-classifier.js";
import {
  type SkillClassifierInput,
  SkillLoadRiskClassifier,
  skillLoadRiskClassifier,
} from "./skill-risk-classifier.js";

// -- SkillLoadRiskClassifier --------------------------------------------------

describe("SkillLoadRiskClassifier", () => {
  test("skill_load is always Low risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({ toolName: "skill_load" });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Skill load (default)");
    expect(result.scopeOptions).toEqual([]);
    expect(result.matchType).toBe("registry");
  });

  test("scaffold_managed_skill is always High risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "scaffold_managed_skill",
    });
    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe(
      "Skill scaffold — writes persistent skill source code",
    );
    expect(result.scopeOptions).toEqual([]);
    expect(result.matchType).toBe("registry");
  });

  test("delete_managed_skill is always High risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "delete_managed_skill",
    });
    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe(
      "Skill delete — removes persistent skill source code",
    );
    expect(result.scopeOptions).toEqual([]);
    expect(result.matchType).toBe("registry");
  });

  test("skill_load with skillSelector is still Low risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-custom-skill",
    });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Skill load (default)");
  });

  test("scaffold_managed_skill with skillSelector is still High risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "scaffold_managed_skill",
      skillSelector: "new-skill",
    });
    expect(result.riskLevel).toBe("high");
  });

  test("delete_managed_skill with skillSelector is still High risk", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "delete_managed_skill",
      skillSelector: "old-skill",
    });
    expect(result.riskLevel).toBe("high");
  });
});

// -- Allowlist options --------------------------------------------------------

describe("allowlistOptions", () => {
  test("skill_load without selector produces wildcard option", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({ toolName: "skill_load" });
    expect(result.allowlistOptions).toEqual([
      {
        label: "skill_load:*",
        description: "All skill loads",
        pattern: "skill_load:*",
      },
    ]);
  });

  test("skill_load with selector but no metadata produces selector-based option", async () => {
    // No resolvedMetadata — skill not resolved by the assistant
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "unknown-skill",
    });
    expect(result.allowlistOptions).toEqual([
      {
        label: "unknown-skill",
        description: "This skill",
        pattern: "skill_load:unknown-skill",
      },
    ]);
  });

  test("skill_load with resolved metadata + version hash produces version-pinned option", async () => {
    const metadata: ResolvedSkillMetadata = {
      skillId: "my-skill",
      selector: "my-skill",
      versionHash: "abc123",
      hasInlineExpansions: false,
      isDynamic: false,
    };

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-skill",
      resolvedMetadata: metadata,
    });
    expect(result.allowlistOptions).toEqual([
      {
        label: "my-skill@abc123",
        description: "This exact version",
        pattern: "skill_load:my-skill@abc123",
      },
    ]);
  });

  test("skill_load with dynamic skill produces version-pinned + any-version options", async () => {
    const metadata: ResolvedSkillMetadata = {
      skillId: "dynamic-skill",
      selector: "dynamic-skill",
      versionHash: "def456",
      transitiveHash: "trans789",
      hasInlineExpansions: true,
      isDynamic: true,
    };

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "dynamic-skill",
      resolvedMetadata: metadata,
    });
    expect(result.allowlistOptions).toEqual([
      {
        label: "dynamic-skill@trans789",
        description: "This exact version (pinned)",
        pattern: "skill_load_dynamic:dynamic-skill@trans789",
      },
      {
        label: "dynamic-skill",
        description: "This skill (any version)",
        pattern: "skill_load_dynamic:dynamic-skill",
      },
    ]);
  });

  test("scaffold_managed_skill produces skill-specific + wildcard options", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "scaffold_managed_skill",
      skillSelector: "new-skill",
    });
    expect(result.allowlistOptions).toEqual([
      {
        label: "new-skill",
        description: "This skill only",
        pattern: "scaffold_managed_skill:new-skill",
      },
      {
        label: "scaffold_managed_skill:*",
        description: "All managed skill scaffolds",
        pattern: "scaffold_managed_skill:*",
      },
    ]);
  });

  test("delete_managed_skill produces skill-specific + wildcard options", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "delete_managed_skill",
      skillSelector: "old-skill",
    });
    expect(result.allowlistOptions).toEqual([
      {
        label: "old-skill",
        description: "This skill only",
        pattern: "delete_managed_skill:old-skill",
      },
      {
        label: "delete_managed_skill:*",
        description: "All managed skill deletes",
        pattern: "delete_managed_skill:*",
      },
    ]);
  });

  test("scaffold_managed_skill without selector produces only wildcard", async () => {
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "scaffold_managed_skill",
    });
    expect(result.allowlistOptions).toEqual([
      {
        label: "scaffold_managed_skill:*",
        description: "All managed skill scaffolds",
        pattern: "scaffold_managed_skill:*",
      },
    ]);
  });
});

// -- Singleton export ---------------------------------------------------------

describe("singleton", () => {
  test("skillLoadRiskClassifier is an instance of SkillLoadRiskClassifier", () => {
    expect(skillLoadRiskClassifier).toBeInstanceOf(SkillLoadRiskClassifier);
  });

  test("singleton produces same results as fresh instance", async () => {
    const inputs: SkillClassifierInput[] = [
      { toolName: "skill_load" },
      { toolName: "scaffold_managed_skill" },
      { toolName: "delete_managed_skill" },
    ];

    const fresh = new SkillLoadRiskClassifier();
    for (const input of inputs) {
      const singletonResult = await skillLoadRiskClassifier.classify(input);
      const freshResult = await fresh.classify(input);
      expect(singletonResult).toEqual(freshResult);
    }
  });
});

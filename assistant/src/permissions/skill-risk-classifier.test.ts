import { describe, expect, test } from "bun:test";

import {
  type SkillClassifierInput,
  SkillLoadRiskClassifier,
  skillLoadRiskClassifier,
} from "./skill-risk-classifier.js";

// ── SkillLoadRiskClassifier ──────────────────────────────────────────────────

describe("SkillLoadRiskClassifier", () => {
  const classifier = new SkillLoadRiskClassifier();

  test("skill_load is always Low risk", async () => {
    const result = await classifier.classify({ toolName: "skill_load" });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Skill load (default)");
    expect(result.scopeOptions).toEqual([]);
    expect(result.matchType).toBe("registry");
  });

  test("scaffold_managed_skill is always High risk", async () => {
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
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-custom-skill",
    });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Skill load (default)");
  });

  test("scaffold_managed_skill with skillSelector is still High risk", async () => {
    const result = await classifier.classify({
      toolName: "scaffold_managed_skill",
      skillSelector: "new-skill",
    });
    expect(result.riskLevel).toBe("high");
  });

  test("delete_managed_skill with skillSelector is still High risk", async () => {
    const result = await classifier.classify({
      toolName: "delete_managed_skill",
      skillSelector: "old-skill",
    });
    expect(result.riskLevel).toBe("high");
  });
});

// ── Singleton export ─────────────────────────────────────────────────────────

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

import { describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock skill resolution so we can control version hashes and catalog lookups.
let mockResolvedSkill: {
  id: string;
  directoryPath: string;
} | null = null;
let mockVersionHash: string | undefined;
let mockTransitiveHash: string | undefined;
let mockInlineExpansions: string[] = [];
let mockInlineEnabled = false;

mock.module("../config/skills.js", () => ({
  resolveSkillSelector: (_selector: string) => ({
    skill: mockResolvedSkill,
  }),
  loadSkillCatalog: () =>
    mockResolvedSkill
      ? [
          {
            id: mockResolvedSkill.id,
            directoryPath: mockResolvedSkill.directoryPath,
            inlineCommandExpansions:
              mockInlineExpansions.length > 0
                ? mockInlineExpansions
                : undefined,
          },
        ]
      : [],
}));

mock.module("../skills/version-hash.js", () => ({
  computeSkillVersionHash: () => {
    if (mockVersionHash === undefined) throw new Error("no hash");
    return mockVersionHash;
  },
}));

mock.module("../skills/transitive-version-hash.js", () => ({
  computeTransitiveSkillVersionHash: () => {
    if (mockTransitiveHash === undefined) throw new Error("no hash");
    return mockTransitiveHash;
  },
}));

mock.module("../skills/include-graph.js", () => ({
  indexCatalogById: () => new Map(),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => mockInlineEnabled,
}));

import {
  type SkillClassifierInput,
  SkillLoadRiskClassifier,
  skillLoadRiskClassifier,
} from "./skill-risk-classifier.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function resetMocks(): void {
  mockResolvedSkill = null;
  mockVersionHash = undefined;
  mockTransitiveHash = undefined;
  mockInlineExpansions = [];
  mockInlineEnabled = false;
}

// ── SkillLoadRiskClassifier ──────────────────────────────────────────────────

describe("SkillLoadRiskClassifier", () => {
  test("skill_load is always Low risk", async () => {
    resetMocks();
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({ toolName: "skill_load" });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Skill load (default)");
    expect(result.scopeOptions).toEqual([]);
    expect(result.matchType).toBe("registry");
  });

  test("scaffold_managed_skill is always High risk", async () => {
    resetMocks();
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
    resetMocks();
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
    resetMocks();
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-custom-skill",
    });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Skill load (default)");
  });

  test("scaffold_managed_skill with skillSelector is still High risk", async () => {
    resetMocks();
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "scaffold_managed_skill",
      skillSelector: "new-skill",
    });
    expect(result.riskLevel).toBe("high");
  });

  test("delete_managed_skill with skillSelector is still High risk", async () => {
    resetMocks();
    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "delete_managed_skill",
      skillSelector: "old-skill",
    });
    expect(result.riskLevel).toBe("high");
  });
});

// ── Allowlist options ────────────────────────────────────────────────────────

describe("allowlistOptions", () => {
  test("skill_load without selector produces wildcard option", async () => {
    resetMocks();
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

  test("skill_load with unresolvable selector produces selector-based option", async () => {
    resetMocks();
    // mockResolvedSkill is null — skill not found
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

  test("skill_load with resolved skill + version hash produces version-pinned option", async () => {
    resetMocks();
    mockResolvedSkill = { id: "my-skill", directoryPath: "/skills/my-skill" };
    mockVersionHash = "abc123";

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "my-skill",
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
    resetMocks();
    mockResolvedSkill = {
      id: "dynamic-skill",
      directoryPath: "/skills/dynamic-skill",
    };
    mockVersionHash = "def456";
    mockTransitiveHash = "trans789";
    mockInlineExpansions = ["some-command"];
    mockInlineEnabled = true;

    const classifier = new SkillLoadRiskClassifier();
    const result = await classifier.classify({
      toolName: "skill_load",
      skillSelector: "dynamic-skill",
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
    resetMocks();
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
    resetMocks();
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
    resetMocks();
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

// ── Singleton export ─────────────────────────────────────────────────────────

describe("singleton", () => {
  test("skillLoadRiskClassifier is an instance of SkillLoadRiskClassifier", () => {
    expect(skillLoadRiskClassifier).toBeInstanceOf(SkillLoadRiskClassifier);
  });

  test("singleton produces same results as fresh instance", async () => {
    resetMocks();
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

let TEST_DIR = "";
const seedUpsertSlugs: string[] = [];

const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: {
    enabled: true,
  },
  auditLog: { retentionDays: 0 },
  services: {
    inference: {
      mode: "your-own",
      provider: "anthropic",
      model: "claude-opus-4-6",
    },
    "image-generation": {
      mode: "your-own",
      provider: "gemini",
      model: "gemini-3.1-flash-image-preview",
    },
    "web-search": { mode: "your-own", provider: "inference-provider-native" },
  },
  skills: {
    entries: {},
    allowBundled: [],
  },
};

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: async () => [],
}));

mock.module("../memory/embedding-backend.js", () => ({
  embedWithBackend: async (_config: unknown, inputs: unknown[]) => ({
    provider: "local",
    model: "test-model",
    vectors: inputs.map(() => [0.1, 0.2, 0.3]),
  }),
  generateSparseEmbedding: () => ({ indices: [1], values: [1] }),
}));

mock.module("../memory/v2/qdrant.js", () => ({
  upsertConceptPageEmbedding: async (params: { slug: string }) => {
    seedUpsertSlugs.push(params.slug);
  },
  pruneSlugsWithPrefixExcept: async () => {},
}));

mock.module("../daemon/skill-memory-refresh.js", () => ({
  refreshSkillCapabilityMemories: mock(() => {}),
}));

import { loadSkillCatalog } from "../config/skills.js";
import {
  _resetSkillStoreForTests,
  getSkillCapability,
  seedV2SkillEntries,
} from "../memory/v2/skill-store.js";
import { executeDeleteManagedSkill } from "../tools/skills/delete-managed.js";
import { skillLoadTool } from "../tools/skills/load.js";
import { executeScaffoldManagedSkill } from "../tools/skills/scaffold-managed.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

beforeEach(() => {
  TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  seedUpsertSlugs.length = 0;
  _resetSkillStoreForTests();
});

describe("managed skill lifecycle: scaffold → catalog → prompt → delete", () => {
  test("valid managed skill without SKILLS.md works across catalog, skill_load, and Memory V2 seeding", async () => {
    const skillId = "e2e-custom-skill";
    const skillSlug = `skills/${skillId}`;
    const skillDir = join(TEST_DIR, "skills", skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: "E2E Custom Skill"
description: "Exercises custom managed skill loading."
metadata:
  vellum:
    activation-hints:
      - user asks for custom lifecycle verification
---

Run the custom lifecycle verification procedure.
`,
      "utf-8",
    );

    expect(existsSync(join(TEST_DIR, "skills", "SKILLS.md"))).toBe(false);

    const catalog = loadSkillCatalog();
    const catalogSkill = catalog.find((s) => s.id === skillId);
    expect(catalogSkill).toBeDefined();
    expect(catalogSkill!.source).toBe("managed");
    expect(catalogSkill!.displayName).toBe("E2E Custom Skill");

    const loadResult = await skillLoadTool.execute(
      { skill: skillId },
      makeContext(),
    );
    expect(loadResult.isError).not.toBe(true);
    expect(loadResult.content as string).toContain("Skill: E2E Custom Skill");
    expect(loadResult.content as string).toContain("ID: e2e-custom-skill");
    expect(loadResult.content as string).toContain(
      "Run the custom lifecycle verification procedure.",
    );

    await seedV2SkillEntries();

    expect(seedUpsertSlugs).toContain(skillSlug);
    const capability = getSkillCapability(skillSlug);
    expect(capability).not.toBeNull();
    expect(capability!.id).toBe("e2e-custom-skill");
    expect(capability!.content).toContain('The "E2E Custom Skill" skill');
    expect(capability!.content).toContain(
      "Exercises custom managed skill loading.",
    );
    expect(capability!.content).toContain(
      "Use when: user asks for custom lifecycle verification.",
    );
  }, 15_000);

  test("full lifecycle: create skill, verify in catalog and prompt, then delete", async () => {
    // Step 1: Scaffold a managed skill
    const scaffoldResult = await executeScaffoldManagedSkill(
      {
        skill_id: "lifecycle-test",
        name: "Lifecycle Test",
        description: "Integration test skill.",
        body_markdown: "Run the lifecycle test procedure.",
        emoji: "🧪",
      },
      makeContext(),
    );

    expect(scaffoldResult.isError).not.toBe(true);
    const scaffoldData = JSON.parse(scaffoldResult.content as string);
    expect(scaffoldData.created).toBe(true);
    expect(scaffoldData).not.toHaveProperty("index_updated");

    // Step 2: Verify SKILL.md was written
    const skillDir = join(TEST_DIR, "skills", "lifecycle-test");
    const skillMdPath = join(skillDir, "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);
    const skillContent = readFileSync(skillMdPath, "utf-8");
    expect(skillContent).toContain('name: "Lifecycle Test"');
    expect(skillContent).toContain('description: "Integration test skill."');
    expect(skillContent).toContain("Run the lifecycle test procedure.");

    // Step 3: Verify skill appears in catalog
    const catalog = loadSkillCatalog();
    const found = catalog.find((s) => s.id === "lifecycle-test");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Lifecycle Test");
    expect(found!.description).toBe("Integration test skill.");
    expect(existsSync(join(TEST_DIR, "skills", "SKILLS.md"))).toBe(false);

    // Step 4: Delete the skill
    const deleteResult = await executeDeleteManagedSkill(
      {
        skill_id: "lifecycle-test",
      },
      makeContext(),
    );

    expect(deleteResult.isError).not.toBe(true);
    const deleteData = JSON.parse(deleteResult.content as string);
    expect(deleteData.deleted).toBe(true);
    expect(deleteData).not.toHaveProperty("index_updated");

    // Step 5: Verify skill directory is gone from filesystem
    expect(existsSync(skillDir)).toBe(false);

    // Step 6: Verify skill no longer in catalog
    const catalogAfter = loadSkillCatalog();
    expect(catalogAfter.find((s) => s.id === "lifecycle-test")).toBeUndefined();
    expect(existsSync(join(TEST_DIR, "skills", "SKILLS.md"))).toBe(false);
  });

  test("scaffold with overwrite replaces existing skill", async () => {
    const ctx = makeContext();

    // Create initial skill
    await executeScaffoldManagedSkill(
      {
        skill_id: "overwrite-test",
        name: "V1",
        description: "Version 1.",
        body_markdown: "Original body.",
      },
      ctx,
    );

    // Overwrite with updated content
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "overwrite-test",
        name: "V2",
        description: "Version 2.",
        body_markdown: "Updated body.",
        overwrite: true,
      },
      ctx,
    );

    expect(result.isError).not.toBe(true);

    const skillContent = readFileSync(
      join(TEST_DIR, "skills", "overwrite-test", "SKILL.md"),
      "utf-8",
    );
    expect(skillContent).toContain('name: "V2"');
    expect(skillContent).toContain("Updated body.");
    expect(skillContent).not.toContain("Original body.");

    expect(existsSync(join(TEST_DIR, "skills", "SKILLS.md"))).toBe(false);

    const catalog = loadSkillCatalog();
    const skill = catalog.find((s) => s.id === "overwrite-test");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("V2");
  });

  test("delete non-existent skill returns error", async () => {
    const result = await executeDeleteManagedSkill(
      {
        skill_id: "does-not-exist",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
  });

  test("scaffold → skill_load chain: literal tool execution", async () => {
    const ctx = makeContext();

    // Step 1: Scaffold a skill directly
    const scaffoldResult = await executeScaffoldManagedSkill(
      {
        skill_id: "chain-test",
        name: "Chain Test",
        description: "Created from scaffold.",
        body_markdown:
          "This skill was dynamically created.\n\nRun: `echo chain-test-ok`",
      },
      ctx,
    );

    expect(scaffoldResult.isError).not.toBe(true);
    const scaffoldData = JSON.parse(scaffoldResult.content as string);
    expect(scaffoldData.created).toBe(true);

    // Step 2: Call skill_load tool to load the created skill
    const loadResult = await skillLoadTool.execute(
      { skill: "chain-test" },
      ctx,
    );
    expect(loadResult.isError).not.toBe(true);
    const loadContent = loadResult.content as string;
    expect(loadContent).toContain("Skill: Chain Test");
    expect(loadContent).toContain("ID: chain-test");
    expect(loadContent).toContain("Description: Created from scaffold.");
    expect(loadContent).toContain("dynamically created");
    expect(loadContent).toContain("echo chain-test-ok");

    // Step 3: Clean up
    const deleteResult = await executeDeleteManagedSkill(
      { skill_id: "chain-test" },
      ctx,
    );
    expect(deleteResult.isError).not.toBe(true);

    // Step 4: Verify skill_load returns error for deleted skill
    const loadAfterDelete = await skillLoadTool.execute(
      { skill: "chain-test" },
      ctx,
    );
    expect(loadAfterDelete.isError).toBe(true);
  }, 15_000);
});

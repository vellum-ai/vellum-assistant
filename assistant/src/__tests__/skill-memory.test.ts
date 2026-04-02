import { rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq, like } from "drizzle-orm";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

// Controllable mock for loadSkillCatalog used by seedCatalogSkillMemories
let mockLoadSkillCatalog: () => import("../config/skills.js").SkillSummary[] =
  () => [];

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: (..._args: unknown[]) => mockLoadSkillCatalog(),
}));

// Controllable mock for getCachedCatalogSync used by seedCatalogSkillMemories
let mockGetCachedCatalogSync: () => import("../skills/catalog-install.js").CatalogSkill[] =
  () => [];

mock.module("../skills/catalog-cache.js", () => ({
  getCachedCatalogSync: (..._args: unknown[]) => mockGetCachedCatalogSync(),
  getCatalog: async () => mockGetCachedCatalogSync(),
  invalidateCatalogCache: () => {},
}));

// Controllable mock for isAssistantFeatureFlagEnabled used by resolveSkillStates
let mockIsFeatureFlagEnabled: (key: string) => boolean = () => true;

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string, _config: unknown) =>
    mockIsFeatureFlagEnabled(key),
  getAssistantFeatureFlagDefaults: () => ({}),
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

import type { SkillSummary } from "../config/skills.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { memoryGraphNodes, memoryJobs } from "../memory/schema.js";
import {
  buildCapabilityStatement,
  deleteSkillCapabilityMemory,
  fromSkillSummary,
  seedCatalogSkillMemories,
  type SkillCapabilityInput,
  upsertSkillCapabilityMemory,
} from "../skills/skill-memory.js";
import { ensureDataDir, getDbPath } from "../util/platform.js";

ensureDataDir();
initializeDb();

afterAll(() => {
  resetDb();
});

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM memory_graph_nodes");
  db.run("DELETE FROM memory_jobs");
}

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

// ─── upsertSkillCapabilityMemory ─────────────────────────────────────────────

describe("upsertSkillCapabilityMemory", () => {
  beforeEach(resetTables);

  test("inserts with correct type, content, confidence, significance", () => {
    const input = fromSkillSummary(makeSkillSummary());
    upsertSkillCapabilityMemory("test-skill", input);

    const db = getDb();
    const items = db.select().from(memoryGraphNodes).all();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("procedural");
    expect(items[0].content).toMatch(/^skill:test-skill\n/);
    expect(items[0].confidence).toBe(1.0);
    expect(items[0].significance).toBe(0.7);
    expect(items[0].fidelity).toBe("vivid");
    expect(items[0].scopeId).toBe("default");

    // Should also enqueue an embed_graph_node job
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("embed_graph_node");
  });

  test("is idempotent (same entry only touches lastAccessed)", () => {
    const input = fromSkillSummary(makeSkillSummary());
    upsertSkillCapabilityMemory("test-skill", input);

    const db = getDb();
    const before = db.select().from(memoryGraphNodes).all();
    expect(before).toHaveLength(1);
    const originalLastAccessed = before[0].lastAccessed;

    // Upsert again
    upsertSkillCapabilityMemory("test-skill", input);

    const after = db.select().from(memoryGraphNodes).all();
    expect(after).toHaveLength(1);
    // Same content, so only lastAccessed changes
    expect(after[0].content).toBe(before[0].content);
    expect(after[0].lastAccessed).toBeGreaterThanOrEqual(originalLastAccessed);

    // Should NOT enqueue a second embed job (only 1 from initial insert)
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(1);
  });

  test("updates content when description changes", () => {
    const input = fromSkillSummary(
      makeSkillSummary({ description: "Original description" }),
    );
    upsertSkillCapabilityMemory("test-skill", input);

    const db = getDb();
    const before = db.select().from(memoryGraphNodes).all();
    expect(before).toHaveLength(1);
    expect(before[0].content).toContain("Original description");

    // Change description
    const updatedInput = fromSkillSummary(
      makeSkillSummary({ description: "Updated description" }),
    );
    upsertSkillCapabilityMemory("test-skill", updatedInput);

    const after = db.select().from(memoryGraphNodes).all();
    expect(after).toHaveLength(1);
    expect(after[0].content).toContain("Updated description");
    expect(after[0].content).not.toBe(before[0].content);

    // Should enqueue a second embed job
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(2);
  });

  test("reactivates soft-deleted items", () => {
    const input = fromSkillSummary(makeSkillSummary());
    upsertSkillCapabilityMemory("test-skill", input);

    const db = getDb();
    // Soft-delete the item
    db.update(memoryGraphNodes)
      .set({ fidelity: "gone" })
      .where(like(memoryGraphNodes.content, "skill:test-skill\n%"))
      .run();

    const deleted = db.select().from(memoryGraphNodes).all();
    expect(deleted[0].fidelity).toBe("gone");

    // Clear jobs from initial insert
    db.run("DELETE FROM memory_jobs");

    // Upsert again — should reactivate
    upsertSkillCapabilityMemory("test-skill", input);

    const reactivated = db.select().from(memoryGraphNodes).all();
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0].fidelity).toBe("vivid");

    // Should enqueue embed job for reactivated item
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("embed_graph_node");
  });

  test("does not throw on DB error", () => {
    // Close the DB connection to force errors, then reinitialize
    resetDb();
    // getDb() will create a new connection, but we can force a DB error by
    // dropping the table it reads from. Use a fresh DB without initialization.
    // Instead, verify the try/catch by closing and reopening:
    // resetDb closes the connection; getDb lazily reconnects.
    // We drop the memory_graph_nodes table to force an error on the next query.
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_graph_nodes");

    expect(() => {
      upsertSkillCapabilityMemory(
        "test-skill",
        fromSkillSummary(makeSkillSummary()),
      );
    }).not.toThrow();

    // Restore DB state for subsequent tests.
    // Delete the entire DB so initializeDb recreates it from scratch — just
    // resetting the connection leaves stale migration checkpoints that skip
    // checkpoint-guarded ALTER TABLE migrations (e.g. source_type column).
    resetDb();
    const dbPath = getDbPath();
    for (const ext of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${ext}`, { force: true });
    }
    initializeDb();
  });
});

// ─── deleteSkillCapabilityMemory ─────────────────────────────────────────────

describe("deleteSkillCapabilityMemory", () => {
  beforeEach(resetTables);

  test("soft-deletes matching item", () => {
    const input = fromSkillSummary(makeSkillSummary());
    upsertSkillCapabilityMemory("test-skill", input);

    const db = getDb();
    const before = db.select().from(memoryGraphNodes).all();
    expect(before).toHaveLength(1);
    expect(before[0].fidelity).toBe("vivid");

    deleteSkillCapabilityMemory("test-skill");

    const after = db.select().from(memoryGraphNodes).all();
    expect(after).toHaveLength(1);
    expect(after[0].fidelity).toBe("gone");
  });

  test("is no-op for missing item", () => {
    // Should not throw when no matching item exists
    expect(() => {
      deleteSkillCapabilityMemory("nonexistent-skill");
    }).not.toThrow();

    const db = getDb();
    const items = db.select().from(memoryGraphNodes).all();
    expect(items).toHaveLength(0);
  });

  test("does not throw on DB error", () => {
    // Close and reopen DB, then drop the table to force a query error
    resetDb();
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_graph_nodes");

    expect(() => {
      deleteSkillCapabilityMemory("test-skill");
    }).not.toThrow();

    // Restore DB state for subsequent tests (see upsert "does not throw" test
    // for rationale on why we delete the DB file).
    resetDb();
    const dbPath = getDbPath();
    for (const ext of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${ext}`, { force: true });
    }
    initializeDb();
  });
});

// ─── seedCatalogSkillMemories ─────────────────────────────────────────────

describe("seedCatalogSkillMemories", () => {
  beforeEach(() => {
    resetTables();
    // Reset mocks to defaults
    mockLoadSkillCatalog = () => [];
    mockIsFeatureFlagEnabled = () => true;
    // Default: non-empty cache so pruning is allowed
    mockGetCachedCatalogSync = () => [
      { id: "_sentinel", name: "_sentinel", description: "" },
    ];
  });

  test("upserts capability memories for all enabled skills", () => {
    const skills: SkillSummary[] = [
      makeSkillSummary({
        id: "skill-a",
        displayName: "Skill A",
        description: "Does A",
      }),
      makeSkillSummary({
        id: "skill-b",
        displayName: "Skill B",
        description: "Does B",
      }),
      makeSkillSummary({
        id: "skill-c",
        displayName: "Skill C",
        description: "Does C",
      }),
    ];
    mockLoadSkillCatalog = () => skills;

    seedCatalogSkillMemories();

    const db = getDb();
    const items = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(items).toHaveLength(3);

    const contentPrefixes = items.map((i) => i.content.split("\n")[0]).sort();
    expect(contentPrefixes).toEqual([
      "skill:skill-a",
      "skill:skill-b",
      "skill:skill-c",
    ]);

    // All should be vivid
    for (const item of items) {
      expect(item.fidelity).toBe("vivid");
    }
  });

  test("includes bundled skills in seeded memories", () => {
    const skills: SkillSummary[] = [
      makeSkillSummary({
        id: "managed-skill",
        displayName: "Managed",
        description: "A managed skill",
        source: "managed",
      }),
      makeSkillSummary({
        id: "bundled-skill",
        displayName: "Bundled",
        description: "A bundled skill",
        source: "bundled",
        bundled: true,
      }),
    ];
    mockLoadSkillCatalog = () => skills;

    seedCatalogSkillMemories();

    const db = getDb();
    const items = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(items).toHaveLength(2);

    const contentPrefixes = items.map((i) => i.content.split("\n")[0]).sort();
    expect(contentPrefixes).toEqual(["skill:bundled-skill", "skill:managed-skill"]);

    for (const item of items) {
      expect(item.fidelity).toBe("vivid");
    }
  });

  test("excludes bundled skills filtered by allowBundled config", () => {
    const skills: SkillSummary[] = [
      makeSkillSummary({
        id: "allowed-bundled",
        displayName: "Allowed Bundled",
        description: "This bundled skill is allowed",
        source: "bundled",
        bundled: true,
      }),
      makeSkillSummary({
        id: "blocked-bundled",
        displayName: "Blocked Bundled",
        description: "This bundled skill is not in allowBundled",
        source: "bundled",
        bundled: true,
      }),
      makeSkillSummary({
        id: "managed-skill",
        displayName: "Managed",
        description: "A managed skill",
        source: "managed",
      }),
    ];
    mockLoadSkillCatalog = () => skills;

    // Override config to set allowBundled to only allow one bundled skill
    const configWithAllowBundled = {
      ...TEST_CONFIG,
      skills: {
        ...TEST_CONFIG.skills,
        allowBundled: ["allowed-bundled"],
      },
    };
    mock.module("../config/loader.js", () => ({
      loadConfig: () => configWithAllowBundled,
      getConfig: () => configWithAllowBundled,
      loadRawConfig: () => ({}),
      saveRawConfig: () => {},
      invalidateConfigCache: () => {},
    }));

    seedCatalogSkillMemories();

    const db = getDb();
    const items = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();

    // Only allowed-bundled and managed-skill should be seeded
    expect(items).toHaveLength(2);
    const contentPrefixes = items.map((i) => i.content.split("\n")[0]).sort();
    expect(contentPrefixes).toEqual(["skill:allowed-bundled", "skill:managed-skill"]);

    // Restore default config mock
    mock.module("../config/loader.js", () => ({
      loadConfig: () => TEST_CONFIG,
      getConfig: () => TEST_CONFIG,
      loadRawConfig: () => ({}),
      saveRawConfig: () => {},
      invalidateConfigCache: () => {},
    }));
  });

  test("prunes stale capabilities for skills no longer enabled", () => {
    // First seed with three skills
    const initialSkills: SkillSummary[] = [
      makeSkillSummary({
        id: "skill-a",
        displayName: "Skill A",
        description: "Does A",
      }),
      makeSkillSummary({
        id: "skill-b",
        displayName: "Skill B",
        description: "Does B",
      }),
      makeSkillSummary({
        id: "skill-c",
        displayName: "Skill C",
        description: "Does C",
      }),
    ];
    mockLoadSkillCatalog = () => initialSkills;
    seedCatalogSkillMemories();

    const db = getDb();
    const beforeItems = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(beforeItems).toHaveLength(3);
    expect(beforeItems.every((i) => i.fidelity === "vivid")).toBe(true);

    // Now seed with only skill-a — skill-b and skill-c should be pruned
    mockLoadSkillCatalog = () => [
      makeSkillSummary({
        id: "skill-a",
        displayName: "Skill A",
        description: "Does A",
      }),
    ];
    seedCatalogSkillMemories();

    const afterItems = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(afterItems).toHaveLength(3); // still 3 rows, but 2 are soft-deleted

    const active = afterItems.filter((i) => i.fidelity === "vivid");
    const deleted = afterItems.filter((i) => i.fidelity === "gone");

    expect(active).toHaveLength(1);
    expect(active[0].content).toMatch(/^skill:skill-a\n/);

    expect(deleted).toHaveLength(2);
    const deletedPrefixes = deleted.map((i) => i.content.split("\n")[0]).sort();
    expect(deletedPrefixes).toEqual(["skill:skill-b", "skill:skill-c"]);
  });

  test("handles empty catalog without errors", () => {
    // Pre-populate a skill so we can verify it gets pruned
    upsertSkillCapabilityMemory(
      "existing-skill",
      fromSkillSummary(makeSkillSummary({ id: "existing-skill" })),
    );

    const db = getDb();
    const beforeItems = db.select().from(memoryGraphNodes).all();
    expect(beforeItems).toHaveLength(1);
    expect(beforeItems[0].fidelity).toBe("vivid");

    // Seed with empty catalog
    mockLoadSkillCatalog = () => [];
    seedCatalogSkillMemories();

    // The existing skill should be pruned (soft-deleted)
    const afterItems = db.select().from(memoryGraphNodes).all();
    expect(afterItems).toHaveLength(1);
    expect(afterItems[0].fidelity).toBe("gone");
  });

  test("does not prune when catalog cache is empty", () => {
    // Pre-populate a skill
    upsertSkillCapabilityMemory(
      "existing-skill",
      fromSkillSummary(makeSkillSummary({ id: "existing-skill" })),
    );

    const db = getDb();
    const beforeItems = db.select().from(memoryGraphNodes).all();
    expect(beforeItems).toHaveLength(1);
    expect(beforeItems[0].fidelity).toBe("vivid");

    // Seed with empty catalog AND empty cache — pruning guard should skip
    mockLoadSkillCatalog = () => [];
    mockGetCachedCatalogSync = () => [];
    seedCatalogSkillMemories();

    // The existing skill should NOT be pruned because the cache is empty
    const afterItems = db.select().from(memoryGraphNodes).all();
    expect(afterItems).toHaveLength(1);
    expect(afterItems[0].fidelity).toBe("vivid");
  });

  test("does not prune non-skill capability memories", () => {
    // Pre-insert a non-skill capability memory directly into the DB
    const db = getDb();
    const now = Date.now();
    db.insert(memoryGraphNodes)
      .values({
        id: "cli-doctor-item",
        type: "procedural",
        content: "cli:doctor\nThe doctor command diagnoses issues.",
        fidelity: "vivid",
        confidence: 1.0,
        significance: 0.7,
        sourceType: "inferred",
        scopeId: "default",
        created: now,
        lastAccessed: now,
        lastConsolidated: now,
        emotionalCharge: '{"valence":0,"intensity":0.1,"decayCurve":"linear","decayRate":0.05,"originalIntensity":0.1}',
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now,
        sourceConversations: "[]",
        narrativeRole: null,
        partOfStory: null,
      })
      .run();

    // Seed with empty catalog — skill pruner runs but should skip cli:* items
    mockLoadSkillCatalog = () => [];
    seedCatalogSkillMemories();

    const item = db
      .select()
      .from(memoryGraphNodes)
      .where(like(memoryGraphNodes.content, "cli:doctor\n%"))
      .get();
    expect(item).toBeDefined();
    expect(item!.fidelity).toBe("vivid");
  });

  test("does not throw when loadSkillCatalog throws", () => {
    mockLoadSkillCatalog = () => {
      throw new Error("Catalog load failure");
    };

    // Best-effort: should not propagate the error
    expect(() => seedCatalogSkillMemories()).not.toThrow();
  });

  test("skips skills whose feature flag is disabled", () => {
    const skills: SkillSummary[] = [
      makeSkillSummary({
        id: "unflagged-skill",
        displayName: "Unflagged",
        description: "No flag",
      }),
      makeSkillSummary({
        id: "flagged-skill",
        displayName: "Flagged",
        description: "Has flag",
        featureFlag: "my_gated_feature",
      }),
    ];
    mockLoadSkillCatalog = () => skills;

    // Disable the feature flag for the flagged skill
    mockIsFeatureFlagEnabled = (key: string) => key !== "my_gated_feature";

    seedCatalogSkillMemories();

    const db = getDb();
    const items = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();

    // Only the unflagged skill should have a capability row
    expect(items).toHaveLength(1);
    expect(items[0].content).toMatch(/^skill:unflagged-skill\n/);
    expect(items[0].fidelity).toBe("vivid");
  });

  test("prunes pre-existing capability for a skill whose flag becomes disabled", () => {
    // First seed with both skills, all flags enabled
    const skills: SkillSummary[] = [
      makeSkillSummary({
        id: "unflagged-skill",
        displayName: "Unflagged",
        description: "No flag",
      }),
      makeSkillSummary({
        id: "flagged-skill",
        displayName: "Flagged",
        description: "Has flag",
        featureFlag: "my_gated_feature",
      }),
    ];
    mockLoadSkillCatalog = () => skills;
    mockIsFeatureFlagEnabled = () => true;
    seedCatalogSkillMemories();

    const db = getDb();
    const beforeItems = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(beforeItems).toHaveLength(2);
    expect(beforeItems.every((i) => i.fidelity === "vivid")).toBe(true);

    // Now disable the flag — the flagged skill should be pruned
    mockIsFeatureFlagEnabled = (key: string) => key !== "my_gated_feature";
    seedCatalogSkillMemories();

    const afterItems = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(afterItems).toHaveLength(2); // still 2 rows, but one soft-deleted

    const active = afterItems.filter((i) => i.fidelity === "vivid");
    const deleted = afterItems.filter((i) => i.fidelity === "gone");

    expect(active).toHaveLength(1);
    expect(active[0].content).toMatch(/^skill:unflagged-skill\n/);

    expect(deleted).toHaveLength(1);
    expect(deleted[0].content).toMatch(/^skill:flagged-skill\n/);
  });

  test("does not throw on DB error during pruning", () => {
    mockLoadSkillCatalog = () => [
      makeSkillSummary({
        id: "skill-a",
        displayName: "Skill A",
        description: "Does A",
      }),
    ];

    // Drop memory_graph_nodes to force a DB error during the prune phase
    resetDb();
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_graph_nodes");

    expect(() => seedCatalogSkillMemories()).not.toThrow();

    // Restore DB state for subsequent tests (see upsert "does not throw" test
    // for rationale on why we delete the DB file).
    resetDb();
    const dbPath = getDbPath();
    for (const ext of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${ext}`, { force: true });
    }
    initializeDb();
  });
});

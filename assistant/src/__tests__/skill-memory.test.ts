import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

const testDir = mkdtempSync(join(tmpdir(), "skill-memory-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getWorkspaceSkillsDir: () => join(testDir, "skills"),
  getWorkspaceConfigPath: () => join(testDir, "config.json"),
  readPlatformToken: () => undefined,
}));

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

// Controllable mock for resolveCatalog used by seedCatalogSkillMemories
let mockResolveCatalog: () => Promise<
  import("../skills/catalog-install.js").CatalogSkill[]
> = async () => [];

mock.module("../skills/catalog-install.js", () => ({
  resolveCatalog: (..._args: unknown[]) => mockResolveCatalog(),
}));

// Controllable mock for isAssistantFeatureFlagEnabled used by seedCatalogSkillMemories
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

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { memoryItems, memoryJobs } from "../memory/schema.js";
import type { CatalogSkill } from "../skills/catalog-install.js";
import {
  buildCapabilityStatement,
  deleteSkillCapabilityMemory,
  seedCatalogSkillMemories,
  upsertSkillCapabilityMemory,
} from "../skills/skill-memory.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best effort cleanup
  }
});

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM memory_item_sources");
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM memory_items");
  db.run("DELETE FROM memory_jobs");
}

function makeSkill(overrides: Partial<CatalogSkill> = {}): CatalogSkill {
  return {
    id: "test-skill",
    name: "Test Skill",
    description: "A skill for testing",
    ...overrides,
  };
}

// ─── buildCapabilityStatement ────────────────────────────────────────────────

describe("buildCapabilityStatement", () => {
  test("includes display name, id, and description", () => {
    const entry = makeSkill({
      metadata: { vellum: { "display-name": "My Skill" } },
    });
    const result = buildCapabilityStatement(entry);
    expect(result).toContain('"My Skill"');
    expect(result).toContain("(test-skill)");
    expect(result).toContain("A skill for testing");
  });

  test("includes activation hints when present", () => {
    const entry = makeSkill({
      metadata: {
        vellum: {
          "display-name": "My Skill",
          "activation-hints": ["user asks to search", "needs web data"],
        },
      },
    });
    const result = buildCapabilityStatement(entry);
    expect(result).toContain("Use when:");
    expect(result).toContain("user asks to search");
    expect(result).toContain("needs web data");
  });

  test("works without metadata (falls back to name)", () => {
    const entry = makeSkill({ metadata: undefined });
    const result = buildCapabilityStatement(entry);
    expect(result).toContain('"Test Skill"');
    expect(result).toContain("(test-skill)");
    expect(result).toContain("A skill for testing");
  });

  test("truncates long statements to 500 chars", () => {
    const longDesc = "x".repeat(600);
    const entry = makeSkill({ description: longDesc });
    const result = buildCapabilityStatement(entry);
    expect(result.length).toBe(500);
  });
});

// ─── upsertSkillCapabilityMemory ─────────────────────────────────────────────

describe("upsertSkillCapabilityMemory", () => {
  beforeEach(resetTables);

  test("inserts with correct kind, subject, confidence, importance", () => {
    const entry = makeSkill();
    upsertSkillCapabilityMemory("test-skill", entry);

    const db = getDb();
    const items = db.select().from(memoryItems).all();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("capability");
    expect(items[0].subject).toBe("skill:test-skill");
    expect(items[0].confidence).toBe(1.0);
    expect(items[0].importance).toBe(0.7);
    expect(items[0].status).toBe("active");
    expect(items[0].scopeId).toBe("default");

    // Should also enqueue an embed_item job
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("embed_item");
  });

  test("is idempotent (same entry only touches lastSeenAt)", () => {
    const entry = makeSkill();
    upsertSkillCapabilityMemory("test-skill", entry);

    const db = getDb();
    const before = db.select().from(memoryItems).all();
    expect(before).toHaveLength(1);
    const originalLastSeen = before[0].lastSeenAt;

    // Upsert again
    upsertSkillCapabilityMemory("test-skill", entry);

    const after = db.select().from(memoryItems).all();
    expect(after).toHaveLength(1);
    // Fingerprint should be the same, so only lastSeenAt changes
    expect(after[0].fingerprint).toBe(before[0].fingerprint);
    expect(after[0].lastSeenAt).toBeGreaterThanOrEqual(originalLastSeen);

    // Should NOT enqueue a second embed job (only 1 from initial insert)
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(1);
  });

  test("updates statement when description changes", () => {
    const entry = makeSkill({ description: "Original description" });
    upsertSkillCapabilityMemory("test-skill", entry);

    const db = getDb();
    const before = db.select().from(memoryItems).all();
    expect(before).toHaveLength(1);
    expect(before[0].statement).toContain("Original description");

    // Change description
    const updatedEntry = makeSkill({ description: "Updated description" });
    upsertSkillCapabilityMemory("test-skill", updatedEntry);

    const after = db.select().from(memoryItems).all();
    expect(after).toHaveLength(1);
    expect(after[0].statement).toContain("Updated description");
    expect(after[0].fingerprint).not.toBe(before[0].fingerprint);

    // Should enqueue a second embed job
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(2);
  });

  test("reactivates soft-deleted items", () => {
    const entry = makeSkill();
    upsertSkillCapabilityMemory("test-skill", entry);

    const db = getDb();
    // Soft-delete the item
    db.update(memoryItems)
      .set({ status: "deleted" })
      .where(eq(memoryItems.subject, "skill:test-skill"))
      .run();

    const deleted = db.select().from(memoryItems).all();
    expect(deleted[0].status).toBe("deleted");

    // Clear jobs from initial insert
    db.run("DELETE FROM memory_jobs");

    // Upsert again — should reactivate
    upsertSkillCapabilityMemory("test-skill", entry);

    const reactivated = db.select().from(memoryItems).all();
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0].status).toBe("active");

    // Should enqueue embed job for reactivated item
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("embed_item");
  });

  test("does not throw on DB error", () => {
    // Close the DB connection to force errors, then reinitialize
    resetDb();
    // getDb() will create a new connection, but we can force a DB error by
    // dropping the table it reads from. Use a fresh DB without initialization.
    // Instead, verify the try/catch by closing and reopening:
    // resetDb closes the connection; getDb lazily reconnects.
    // We drop the memory_items table to force an error on the next query.
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_items");

    expect(() => {
      upsertSkillCapabilityMemory("test-skill", makeSkill());
    }).not.toThrow();

    // Restore DB state for subsequent tests
    resetDb();
    initializeDb();
  });
});

// ─── deleteSkillCapabilityMemory ─────────────────────────────────────────────

describe("deleteSkillCapabilityMemory", () => {
  beforeEach(resetTables);

  test("soft-deletes matching item", () => {
    const entry = makeSkill();
    upsertSkillCapabilityMemory("test-skill", entry);

    const db = getDb();
    const before = db.select().from(memoryItems).all();
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("active");

    deleteSkillCapabilityMemory("test-skill");

    const after = db.select().from(memoryItems).all();
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("deleted");
  });

  test("is no-op for missing item", () => {
    // Should not throw when no matching item exists
    expect(() => {
      deleteSkillCapabilityMemory("nonexistent-skill");
    }).not.toThrow();

    const db = getDb();
    const items = db.select().from(memoryItems).all();
    expect(items).toHaveLength(0);
  });

  test("does not throw on DB error", () => {
    // Close and reopen DB, then drop the table to force a query error
    resetDb();
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_items");

    expect(() => {
      deleteSkillCapabilityMemory("test-skill");
    }).not.toThrow();

    // Restore DB state for subsequent tests
    resetDb();
    initializeDb();
  });
});

// ─── seedCatalogSkillMemories ─────────────────────────────────────────────

describe("seedCatalogSkillMemories", () => {
  beforeEach(() => {
    resetTables();
    // Reset mocks to defaults
    mockResolveCatalog = async () => [];
    mockIsFeatureFlagEnabled = () => true;
  });

  test("upserts capability memories for all catalog entries", async () => {
    const skills: CatalogSkill[] = [
      makeSkill({ id: "skill-a", name: "Skill A", description: "Does A" }),
      makeSkill({ id: "skill-b", name: "Skill B", description: "Does B" }),
      makeSkill({ id: "skill-c", name: "Skill C", description: "Does C" }),
    ];
    mockResolveCatalog = async () => skills;

    await seedCatalogSkillMemories();

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();
    expect(items).toHaveLength(3);

    const subjects = items.map((i) => i.subject).sort();
    expect(subjects).toEqual([
      "skill:skill-a",
      "skill:skill-b",
      "skill:skill-c",
    ]);

    // All should be active
    for (const item of items) {
      expect(item.status).toBe("active");
    }
  });

  test("prunes stale capabilities for skills no longer in catalog", async () => {
    // First seed with three skills
    const initialSkills: CatalogSkill[] = [
      makeSkill({ id: "skill-a", name: "Skill A", description: "Does A" }),
      makeSkill({ id: "skill-b", name: "Skill B", description: "Does B" }),
      makeSkill({ id: "skill-c", name: "Skill C", description: "Does C" }),
    ];
    mockResolveCatalog = async () => initialSkills;
    await seedCatalogSkillMemories();

    const db = getDb();
    const beforeItems = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();
    expect(beforeItems).toHaveLength(3);
    expect(beforeItems.every((i) => i.status === "active")).toBe(true);

    // Now seed with only skill-a — skill-b and skill-c should be pruned
    mockResolveCatalog = async () => [
      makeSkill({ id: "skill-a", name: "Skill A", description: "Does A" }),
    ];
    await seedCatalogSkillMemories();

    const afterItems = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();
    expect(afterItems).toHaveLength(3); // still 3 rows, but 2 are soft-deleted

    const active = afterItems.filter((i) => i.status === "active");
    const deleted = afterItems.filter((i) => i.status === "deleted");

    expect(active).toHaveLength(1);
    expect(active[0].subject).toBe("skill:skill-a");

    expect(deleted).toHaveLength(2);
    const deletedSubjects = deleted.map((i) => i.subject).sort();
    expect(deletedSubjects).toEqual(["skill:skill-b", "skill:skill-c"]);
  });

  test("handles empty catalog without errors", async () => {
    // Pre-populate a skill so we can verify it gets pruned
    upsertSkillCapabilityMemory(
      "existing-skill",
      makeSkill({ id: "existing-skill" }),
    );

    const db = getDb();
    const beforeItems = db.select().from(memoryItems).all();
    expect(beforeItems).toHaveLength(1);
    expect(beforeItems[0].status).toBe("active");

    // Seed with empty catalog
    mockResolveCatalog = async () => [];
    await seedCatalogSkillMemories();

    // The existing skill should be pruned (soft-deleted)
    const afterItems = db.select().from(memoryItems).all();
    expect(afterItems).toHaveLength(1);
    expect(afterItems[0].status).toBe("deleted");
  });

  test("does not throw when resolveCatalog rejects", async () => {
    mockResolveCatalog = async () => {
      throw new Error("Network failure");
    };

    // Best-effort: should not propagate the error
    await expect(seedCatalogSkillMemories()).resolves.toBeUndefined();
  });

  test("skips skills whose feature flag is disabled", async () => {
    const skills: CatalogSkill[] = [
      makeSkill({
        id: "unflagged-skill",
        name: "Unflagged",
        description: "No flag",
      }),
      makeSkill({
        id: "flagged-skill",
        name: "Flagged",
        description: "Has flag",
        metadata: { vellum: { "feature-flag": "my_gated_feature" } },
      }),
    ];
    mockResolveCatalog = async () => skills;

    // Disable the feature flag for the flagged skill
    mockIsFeatureFlagEnabled = (key: string) =>
      key !== "feature_flags.my_gated_feature.enabled";

    await seedCatalogSkillMemories();

    const db = getDb();
    const items = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();

    // Only the unflagged skill should have a capability row
    expect(items).toHaveLength(1);
    expect(items[0].subject).toBe("skill:unflagged-skill");
    expect(items[0].status).toBe("active");
  });

  test("prunes pre-existing capability for a skill whose flag becomes disabled", async () => {
    // First seed with both skills, all flags enabled
    const skills: CatalogSkill[] = [
      makeSkill({
        id: "unflagged-skill",
        name: "Unflagged",
        description: "No flag",
      }),
      makeSkill({
        id: "flagged-skill",
        name: "Flagged",
        description: "Has flag",
        metadata: { vellum: { "feature-flag": "my_gated_feature" } },
      }),
    ];
    mockResolveCatalog = async () => skills;
    mockIsFeatureFlagEnabled = () => true;
    await seedCatalogSkillMemories();

    const db = getDb();
    const beforeItems = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();
    expect(beforeItems).toHaveLength(2);
    expect(beforeItems.every((i) => i.status === "active")).toBe(true);

    // Now disable the flag — the flagged skill should be pruned
    mockIsFeatureFlagEnabled = (key: string) =>
      key !== "feature_flags.my_gated_feature.enabled";
    await seedCatalogSkillMemories();

    const afterItems = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();
    expect(afterItems).toHaveLength(2); // still 2 rows, but one soft-deleted

    const active = afterItems.filter((i) => i.status === "active");
    const deleted = afterItems.filter((i) => i.status === "deleted");

    expect(active).toHaveLength(1);
    expect(active[0].subject).toBe("skill:unflagged-skill");

    expect(deleted).toHaveLength(1);
    expect(deleted[0].subject).toBe("skill:flagged-skill");
  });

  test("does not throw on DB error during pruning", async () => {
    mockResolveCatalog = async () => [
      makeSkill({ id: "skill-a", name: "Skill A", description: "Does A" }),
    ];

    // Drop memory_items to force a DB error during the prune phase
    resetDb();
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_items");

    await expect(seedCatalogSkillMemories()).resolves.toBeUndefined();

    // Restore DB state for subsequent tests
    resetDb();
    initializeDb();
  });
});

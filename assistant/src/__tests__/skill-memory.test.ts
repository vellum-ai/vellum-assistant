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

    // Small delay to ensure timestamps differ
    const now = Date.now() + 100;
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

import { rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";
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

// Controllable mock for buildCliProgram
let mockCommands: { name: string; description: string }[] = [];

function makeMockProgram(): Command {
  const program = new Command();
  for (const cmd of mockCommands) {
    program.command(cmd.name).description(cmd.description);
  }
  return program;
}

mock.module("../cli/program.js", () => ({
  buildCliProgram: () => makeMockProgram(),
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

import {
  buildCliCapabilityStatement,
  seedCliCommandMemories,
  upsertCliCapabilityMemory,
} from "../cli/cli-memory.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { memoryGraphNodes, memoryJobs } from "../memory/schema.js";
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

// ─── buildCliCapabilityStatement ────────────────────────────────────────────

describe("buildCliCapabilityStatement", () => {
  test("includes 'assistant' prefix, name, and description", () => {
    const result = buildCliCapabilityStatement("doctor", "Run diagnostic checks");
    expect(result).toContain('"assistant doctor"');
    expect(result).toContain("Run diagnostic checks");
  });

  test("truncates long statements to 500 chars", () => {
    const longDesc = "x".repeat(600);
    const result = buildCliCapabilityStatement("test", longDesc);
    expect(result.length).toBe(500);
  });
});

// ─── upsertCliCapabilityMemory ──────────────────────────────────────────────

describe("upsertCliCapabilityMemory", () => {
  beforeEach(resetTables);

  test("inserts with correct type, content, confidence, significance", () => {
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

    const db = getDb();
    const items = db.select().from(memoryGraphNodes).all();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("procedural");
    expect(items[0].content).toMatch(/^cli:doctor\n/);
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
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

    const db = getDb();
    const before = db.select().from(memoryGraphNodes).all();
    expect(before).toHaveLength(1);
    const originalLastAccessed = before[0].lastAccessed;

    // Upsert again
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

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
    upsertCliCapabilityMemory("doctor", "Original description");

    const db = getDb();
    const before = db.select().from(memoryGraphNodes).all();
    expect(before).toHaveLength(1);
    expect(before[0].content).toContain("Original description");

    // Change description
    upsertCliCapabilityMemory("doctor", "Updated description");

    const after = db.select().from(memoryGraphNodes).all();
    expect(after).toHaveLength(1);
    expect(after[0].content).toContain("Updated description");
    expect(after[0].content).not.toBe(before[0].content);

    // Should enqueue a second embed job
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(2);
  });

  test("reactivates soft-deleted items", () => {
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

    const db = getDb();
    // Soft-delete the item
    db.update(memoryGraphNodes)
      .set({ fidelity: "gone" })
      .where(like(memoryGraphNodes.content, "cli:doctor\n%"))
      .run();

    const deleted = db.select().from(memoryGraphNodes).all();
    expect(deleted[0].fidelity).toBe("gone");

    // Clear jobs from initial insert
    db.run("DELETE FROM memory_jobs");

    // Upsert again — should reactivate
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

    const reactivated = db.select().from(memoryGraphNodes).all();
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0].fidelity).toBe("vivid");

    // Should enqueue embed job for reactivated item
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("embed_graph_node");
  });

  test("does not throw on DB error", () => {
    resetDb();
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_graph_nodes");

    expect(() => {
      upsertCliCapabilityMemory("doctor", "Run diagnostic checks");
    }).not.toThrow();

    // Restore DB state for subsequent tests.
    resetDb();
    const dbPath = getDbPath();
    for (const ext of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${ext}`, { force: true });
    }
    initializeDb();
  });
});

// ─── seedCliCommandMemories ─────────────────────────────────────────────────

describe("seedCliCommandMemories", () => {
  beforeEach(() => {
    resetTables();
    // Reset mock commands
    mockCommands = [];
  });

  test("upserts capability memories for all commands", () => {
    mockCommands = [
      { name: "doctor", description: "Run diagnostic checks" },
      { name: "config", description: "Manage configuration" },
      { name: "keys", description: "Manage API keys" },
    ];

    seedCliCommandMemories();

    const db = getDb();
    const items = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(items).toHaveLength(3);

    const contentPrefixes = items.map((i) => i.content.split("\n")[0]).sort();
    expect(contentPrefixes).toEqual([
      "cli:config",
      "cli:doctor",
      "cli:keys",
    ]);

    // All should be vivid
    for (const item of items) {
      expect(item.fidelity).toBe("vivid");
    }
  });

  test("prunes stale capabilities for commands no longer registered", () => {
    // First seed with three commands
    mockCommands = [
      { name: "doctor", description: "Run diagnostic checks" },
      { name: "config", description: "Manage configuration" },
      { name: "keys", description: "Manage API keys" },
    ];
    seedCliCommandMemories();

    const db = getDb();
    const beforeItems = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(beforeItems).toHaveLength(3);
    expect(beforeItems.every((i) => i.fidelity === "vivid")).toBe(true);

    // Now seed with only doctor — config and keys should be pruned
    mockCommands = [
      { name: "doctor", description: "Run diagnostic checks" },
    ];
    seedCliCommandMemories();

    const afterItems = db
      .select()
      .from(memoryGraphNodes)
      .where(eq(memoryGraphNodes.type, "procedural"))
      .all();
    expect(afterItems).toHaveLength(3); // still 3 rows, but 2 are soft-deleted

    const active = afterItems.filter((i) => i.fidelity === "vivid");
    const deleted = afterItems.filter((i) => i.fidelity === "gone");

    expect(active).toHaveLength(1);
    expect(active[0].content).toMatch(/^cli:doctor\n/);

    expect(deleted).toHaveLength(2);
    const deletedPrefixes = deleted.map((i) => i.content.split("\n")[0]).sort();
    expect(deletedPrefixes).toEqual(["cli:config", "cli:keys"]);
  });

  test("handles empty command list without errors", () => {
    // Pre-populate a CLI command so we can verify it gets pruned
    upsertCliCapabilityMemory("old-command", "An old command");

    const db = getDb();
    const beforeItems = db.select().from(memoryGraphNodes).all();
    expect(beforeItems).toHaveLength(1);
    expect(beforeItems[0].fidelity).toBe("vivid");

    // Seed with empty commands
    mockCommands = [];
    seedCliCommandMemories();

    // The existing command should be pruned (soft-deleted)
    const afterItems = db.select().from(memoryGraphNodes).all();
    expect(afterItems).toHaveLength(1);
    expect(afterItems[0].fidelity).toBe("gone");
  });

  test("does not prune non-cli capability memories", () => {
    // Pre-insert a skill capability memory directly into the DB
    const db = getDb();
    const now = Date.now();
    db.insert(memoryGraphNodes)
      .values({
        id: "skill-test-item",
        type: "procedural",
        content: "skill:test-skill\nThe test skill does things.",
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

    // Seed with empty commands — CLI pruner runs but should skip skill:* items
    mockCommands = [];
    seedCliCommandMemories();

    const item = db
      .select()
      .from(memoryGraphNodes)
      .where(like(memoryGraphNodes.content, "skill:test-skill\n%"))
      .get();
    expect(item).toBeDefined();
    expect(item!.fidelity).toBe("vivid");
  });

  test("does not throw on error", () => {
    mockCommands = [
      { name: "doctor", description: "Run diagnostic checks" },
    ];

    // Drop memory_graph_nodes to force a DB error during the prune phase
    resetDb();
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_graph_nodes");

    expect(() => {
      seedCliCommandMemories();
    }).not.toThrow();

    // Restore DB state for subsequent tests.
    resetDb();
    const dbPath = getDbPath();
    for (const ext of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${ext}`, { force: true });
    }
    initializeDb();
  });
});

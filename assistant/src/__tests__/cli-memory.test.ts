import { rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";
import { eq } from "drizzle-orm";

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

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { memoryItems, memoryJobs } from "../memory/schema.js";
import {
  buildCliCapabilityStatement,
  seedCliCommandMemories,
  upsertCliCapabilityMemory,
} from "../cli/cli-memory.js";
import { ensureDataDir, getDbPath } from "../util/platform.js";

ensureDataDir();
initializeDb();

afterAll(() => {
  resetDb();
});

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM memory_item_sources");
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM memory_items");
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

  test("inserts with correct kind, subject, confidence, importance", () => {
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

    const db = getDb();
    const items = db.select().from(memoryItems).all();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("capability");
    expect(items[0].subject).toBe("cli:doctor");
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
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

    const db = getDb();
    const before = db.select().from(memoryItems).all();
    expect(before).toHaveLength(1);
    const originalLastSeen = before[0].lastSeenAt;

    // Upsert again
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

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
    upsertCliCapabilityMemory("doctor", "Original description");

    const db = getDb();
    const before = db.select().from(memoryItems).all();
    expect(before).toHaveLength(1);
    expect(before[0].statement).toContain("Original description");

    // Change description
    upsertCliCapabilityMemory("doctor", "Updated description");

    const after = db.select().from(memoryItems).all();
    expect(after).toHaveLength(1);
    expect(after[0].statement).toContain("Updated description");
    expect(after[0].fingerprint).not.toBe(before[0].fingerprint);

    // Should enqueue a second embed job
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(2);
  });

  test("reactivates soft-deleted items", () => {
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

    const db = getDb();
    // Soft-delete the item
    db.update(memoryItems)
      .set({ status: "deleted" })
      .where(eq(memoryItems.subject, "cli:doctor"))
      .run();

    const deleted = db.select().from(memoryItems).all();
    expect(deleted[0].status).toBe("deleted");

    // Clear jobs from initial insert
    db.run("DELETE FROM memory_jobs");

    // Upsert again — should reactivate
    upsertCliCapabilityMemory("doctor", "Run diagnostic checks");

    const reactivated = db.select().from(memoryItems).all();
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0].status).toBe("active");

    // Should enqueue embed job for reactivated item
    const jobs = db.select().from(memoryJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("embed_item");
  });

  test("does not throw on DB error", () => {
    resetDb();
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_items");

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
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();
    expect(items).toHaveLength(3);

    const subjects = items.map((i) => i.subject).sort();
    expect(subjects).toEqual([
      "cli:config",
      "cli:doctor",
      "cli:keys",
    ]);

    // All should be active
    for (const item of items) {
      expect(item.status).toBe("active");
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
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();
    expect(beforeItems).toHaveLength(3);
    expect(beforeItems.every((i) => i.status === "active")).toBe(true);

    // Now seed with only doctor — config and keys should be pruned
    mockCommands = [
      { name: "doctor", description: "Run diagnostic checks" },
    ];
    seedCliCommandMemories();

    const afterItems = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.kind, "capability"))
      .all();
    expect(afterItems).toHaveLength(3); // still 3 rows, but 2 are soft-deleted

    const active = afterItems.filter((i) => i.status === "active");
    const deleted = afterItems.filter((i) => i.status === "deleted");

    expect(active).toHaveLength(1);
    expect(active[0].subject).toBe("cli:doctor");

    expect(deleted).toHaveLength(2);
    const deletedSubjects = deleted.map((i) => i.subject).sort();
    expect(deletedSubjects).toEqual(["cli:config", "cli:keys"]);
  });

  test("handles empty command list without errors", () => {
    // Pre-populate a CLI command so we can verify it gets pruned
    upsertCliCapabilityMemory("old-command", "An old command");

    const db = getDb();
    const beforeItems = db.select().from(memoryItems).all();
    expect(beforeItems).toHaveLength(1);
    expect(beforeItems[0].status).toBe("active");

    // Seed with empty commands
    mockCommands = [];
    seedCliCommandMemories();

    // The existing command should be pruned (soft-deleted)
    const afterItems = db.select().from(memoryItems).all();
    expect(afterItems).toHaveLength(1);
    expect(afterItems[0].status).toBe("deleted");
  });

  test("does not prune non-cli capability memories", () => {
    // Pre-insert a skill capability memory directly into the DB
    const db = getDb();
    const now = Date.now();
    db.insert(memoryItems)
      .values({
        id: "skill-test-item",
        kind: "capability",
        subject: "skill:test-skill",
        statement: "The test skill does things.",
        status: "active",
        confidence: 1.0,
        importance: 0.7,
        fingerprint: "skill-test-fp",
        sourceType: "extraction",
        scopeId: "default",
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();

    // Seed with empty commands — CLI pruner runs but should skip skill:* items
    mockCommands = [];
    seedCliCommandMemories();

    const item = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.subject, "skill:test-skill"))
      .get();
    expect(item).toBeDefined();
    expect(item!.status).toBe("active");
  });

  test("does not throw on error", () => {
    mockCommands = [
      { name: "doctor", description: "Run diagnostic checks" },
    ];

    // Drop memory_items to force a DB error during the prune phase
    resetDb();
    const db = getDb();
    db.run("DROP TABLE IF EXISTS memory_items");

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

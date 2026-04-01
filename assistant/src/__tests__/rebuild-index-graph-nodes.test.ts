/**
 * Verifies that rebuildIndexJob enqueues embed jobs for graph nodes and
 * semantic triggers alongside segments, summaries, and media.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track enqueued jobs
const enqueuedJobs: Array<{ type: string; payload: Record<string, unknown> }> =
  [];

mock.module("../memory/jobs-store.js", () => ({
  enqueueMemoryJob: (type: string, payload: Record<string, unknown>) => {
    enqueuedJobs.push({ type, payload });
  },
}));

// Stub config — multimodal disabled so we only test the graph path
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    memory: { enabled: true },
  }),
}));

mock.module("../memory/embedding-backend.js", () => ({
  selectedBackendSupportsMultimodal: async () => false,
}));

// ── In-memory SQLite ─────────────────────────────────────────────────

import Database from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../memory/schema.js";

let db: ReturnType<typeof drizzle>;

function createTestDb() {
  const sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });

  // Create minimal tables needed by rebuildIndexJob
  sqlite.exec(`
    CREATE TABLE memory_embeddings (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_blob BLOB,
      vector_json TEXT,
      content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE memory_summaries (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE memory_segments (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );

    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );

    CREATE TABLE memory_graph_nodes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      created INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      last_consolidated INTEGER NOT NULL,
      emotional_charge TEXT NOT NULL,
      fidelity TEXT NOT NULL DEFAULT 'vivid',
      confidence REAL NOT NULL,
      significance REAL NOT NULL,
      stability REAL NOT NULL DEFAULT 14,
      reinforcement_count INTEGER NOT NULL DEFAULT 0,
      last_reinforced INTEGER NOT NULL,
      source_conversations TEXT NOT NULL DEFAULT '[]',
      source_type TEXT NOT NULL DEFAULT 'inferred',
      narrative_role TEXT,
      part_of_story TEXT,
      scope_id TEXT NOT NULL DEFAULT 'default'
    );

    CREATE TABLE memory_graph_triggers (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      type TEXT NOT NULL,
      schedule TEXT,
      condition TEXT,
      condition_embedding BLOB,
      threshold REAL,
      event_date INTEGER,
      ramp_days INTEGER,
      follow_up_days INTEGER,
      recurring INTEGER NOT NULL DEFAULT 0,
      consumed INTEGER NOT NULL DEFAULT 0,
      cooldown_ms INTEGER,
      last_fired INTEGER
    );
  `);

  return { sqlite, db };
}

mock.module("../memory/db.js", () => ({
  getDb: () => db,
}));

// ── Tests ────────────────────────────────────────────────────────────

import { rebuildIndexJob } from "../memory/job-handlers/index-maintenance.js";

describe("rebuildIndexJob", () => {
  beforeEach(() => {
    enqueuedJobs.length = 0;
    createTestDb();
  });

  test("enqueues embed_graph_node jobs for non-gone graph nodes", async () => {
    const now = Date.now();
    const charge = JSON.stringify({
      valence: 0,
      intensity: 0.1,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.1,
    });

    // Insert two vivid nodes and one gone node
    db.insert(schema.memoryGraphNodes)
      .values([
        {
          id: "node-1",
          content: "User likes hiking",
          type: "semantic",
          created: now,
          lastAccessed: now,
          lastConsolidated: now,
          emotionalCharge: charge,
          fidelity: "vivid",
          confidence: 0.9,
          significance: 0.8,
          stability: 14,
          reinforcementCount: 0,
          lastReinforced: now,
          scopeId: "default",
        },
        {
          id: "node-2",
          content: "User works remotely",
          type: "semantic",
          created: now,
          lastAccessed: now,
          lastConsolidated: now,
          emotionalCharge: charge,
          fidelity: "clear",
          confidence: 0.85,
          significance: 0.7,
          stability: 14,
          reinforcementCount: 0,
          lastReinforced: now,
          scopeId: "default",
        },
        {
          id: "node-gone",
          content: "Decayed memory",
          type: "semantic",
          created: now,
          lastAccessed: now,
          lastConsolidated: now,
          emotionalCharge: charge,
          fidelity: "gone",
          confidence: 0.1,
          significance: 0.1,
          stability: 1,
          reinforcementCount: 0,
          lastReinforced: now,
          scopeId: "default",
        },
      ])
      .run();

    await rebuildIndexJob();

    const graphJobs = enqueuedJobs.filter((j) => j.type === "embed_graph_node");
    expect(graphJobs).toHaveLength(2);
    expect(graphJobs.map((j) => j.payload.nodeId).sort()).toEqual([
      "node-1",
      "node-2",
    ]);
  });

  test("enqueues graph_trigger_embed jobs for triggers with conditions", async () => {
    const now = Date.now();
    const charge = JSON.stringify({
      valence: 0,
      intensity: 0.1,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.1,
    });

    // Need a node for the trigger FK
    db.insert(schema.memoryGraphNodes)
      .values({
        id: "node-t",
        content: "Trigger parent",
        type: "semantic",
        created: now,
        lastAccessed: now,
        lastConsolidated: now,
        emotionalCharge: charge,
        fidelity: "vivid",
        confidence: 0.9,
        significance: 0.8,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now,
        scopeId: "default",
      })
      .run();

    db.insert(schema.memoryGraphTriggers)
      .values([
        {
          id: "trig-1",
          nodeId: "node-t",
          type: "semantic",
          condition: "when user mentions hiking",
        },
        {
          id: "trig-2",
          nodeId: "node-t",
          type: "temporal",
          schedule: "0 9 * * *",
          condition: null,
        },
      ])
      .run();

    await rebuildIndexJob();

    const triggerJobs = enqueuedJobs.filter(
      (j) => j.type === "graph_trigger_embed",
    );
    expect(triggerJobs).toHaveLength(1);
    expect(triggerJobs[0].payload.triggerId).toBe("trig-1");
  });
});

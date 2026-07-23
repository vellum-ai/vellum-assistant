/**
 * Tests for migration 340: sweeping orphaned `graph_node` vector state left by
 * hard-deletes of memory graph nodes (e.g. migration 323's non-default-scope
 * purge).
 *
 * Runs against real workspace databases (`initializeDb()`) because the sweep
 * reads `memory_embeddings` / `memory_graph_nodes` from the main DB while
 * enqueuing `delete_qdrant_vectors` jobs on the dedicated memory DB.
 * `initializeDb()` already ran the step once (a no-op on the empty seed), so
 * each test seeds the tables directly and calls the exported function.
 */
import { beforeEach, describe, expect, test } from "bun:test";

const { getDb, getMemorySqlite, getSqliteFrom } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateSweepOrphanedGraphNodeVectors } =
  await import("./340-sweep-orphaned-graph-node-vectors.js");

await initializeDb();

function mainRaw() {
  return getSqliteFrom(getDb());
}

/** Insert a memory_graph_nodes row (fidelity `gone` models a soft delete). */
function seedNode(id: string, fidelity = "vivid"): void {
  mainRaw()
    .query(
      `INSERT INTO memory_graph_nodes (
        id, content, type, created, last_accessed, last_consolidated,
        emotional_charge, fidelity, confidence, significance, stability,
        reinforcement_count, last_reinforced, source_conversations,
        source_type, scope_id
      ) VALUES (?, ?, 'semantic', 0, 0, 0,
        '{"kind":"neutral","intensity":0}', ?, 0.9, 0.8, 14, 0, 0, '[]',
        'inferred', 'default')`,
    )
    .run(id, `content ${id}`, fidelity);
}

function seedEmbedding(
  id: string,
  targetType: string,
  targetId: string,
  provider = "p",
  model = "m",
): void {
  mainRaw()
    .query(
      `INSERT INTO memory_embeddings (
        id, target_type, target_id, provider, model, dimensions,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 3, 0, 0)`,
    )
    .run(id, targetType, targetId, provider, model);
}

function embeddingIds(): string[] {
  return (
    mainRaw()
      .query(`SELECT id FROM memory_embeddings ORDER BY id`)
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

/** Distinct targetIds of pending delete_qdrant_vectors jobs, sorted. */
function qdrantDeletionTargets(): string[] {
  return (
    getMemorySqlite()!
      .query(
        `SELECT json_extract(payload, '$.targetId') AS t
         FROM memory_jobs
         WHERE type = 'delete_qdrant_vectors' AND status = 'pending'
         ORDER BY t`,
      )
      .all() as Array<{ t: string }>
  ).map((row) => row.t);
}

function jobIds(): string[] {
  return (
    getMemorySqlite()!
      .query(
        `SELECT id FROM memory_jobs
         WHERE type = 'delete_qdrant_vectors' ORDER BY id`,
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

beforeEach(() => {
  const raw = mainRaw();
  // A later migration moved the graph cluster to the memory DB, dropping
  // memory_graph_nodes from main. This migration reads that table on the main
  // connection (it ran before the move), so recreate its minimal shape here to
  // reproduce the pre-move main DB the sweep was written against.
  raw.run(/*sql*/ `CREATE TABLE IF NOT EXISTS memory_graph_nodes (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT NOT NULL,
    created INTEGER NOT NULL, last_accessed INTEGER NOT NULL,
    last_consolidated INTEGER NOT NULL, emotional_charge TEXT NOT NULL,
    fidelity TEXT NOT NULL DEFAULT 'vivid', confidence REAL NOT NULL,
    significance REAL NOT NULL, stability REAL NOT NULL DEFAULT 14,
    reinforcement_count INTEGER NOT NULL DEFAULT 0,
    last_reinforced INTEGER NOT NULL,
    source_conversations TEXT NOT NULL DEFAULT '[]',
    source_type TEXT NOT NULL DEFAULT 'inferred',
    scope_id TEXT NOT NULL DEFAULT 'default'
  )`);
  raw.run("DELETE FROM memory_embeddings");
  raw.run("DELETE FROM memory_graph_nodes");
  getMemorySqlite()!.run("DELETE FROM memory_jobs");
});

describe("migration 340: sweep orphaned graph-node vectors", () => {
  test("sweeps orphan embeddings and enqueues their Qdrant deletion, preserving live, soft-deleted, and non-graph_node rows", () => {
    // Live node + its embedding — backing row present, not an orphan.
    seedNode("live", "vivid");
    seedEmbedding("emb-live", "graph_node", "live");
    // Soft-deleted node keeps its SQL row, so its embedding is not an orphan.
    seedNode("soft", "gone");
    seedEmbedding("emb-soft", "graph_node", "soft");
    // Two embeddings for one hard-deleted node (distinct provider/model) plus a
    // second hard-deleted node — these are the orphans.
    seedEmbedding("emb-orphan-a1", "graph_node", "orphan-a");
    seedEmbedding("emb-orphan-a2", "graph_node", "orphan-a", "p2", "m2");
    seedEmbedding("emb-orphan-b", "graph_node", "orphan-b");
    // Wrong target_type: a summary embedding whose target is absent from
    // memory_graph_nodes must not be swept by a graph-node sweep.
    seedEmbedding("emb-summary", "summary", "orphan-a");

    migrateSweepOrphanedGraphNodeVectors(getDb());

    // Orphan graph_node embeddings gone; everything else retained.
    expect(embeddingIds()).toEqual(["emb-live", "emb-soft", "emb-summary"]);
    // One job per distinct orphan target (orphan-a deduped across its two rows).
    expect(qdrantDeletionTargets()).toEqual(["orphan-a", "orphan-b"]);
    expect(jobIds()).toEqual([
      "migration-340-sweep-orphan-graph-node-vector:orphan-a",
      "migration-340-sweep-orphan-graph-node-vector:orphan-b",
    ]);
  });

  test("is idempotent", () => {
    seedEmbedding("emb-orphan", "graph_node", "orphan-a");

    migrateSweepOrphanedGraphNodeVectors(getDb());
    const afterFirstEmbeddings = embeddingIds();
    const afterFirstJobs = jobIds();
    migrateSweepOrphanedGraphNodeVectors(getDb());

    expect(embeddingIds()).toEqual(afterFirstEmbeddings);
    expect(jobIds()).toEqual(afterFirstJobs);
    expect(jobIds()).toEqual([
      "migration-340-sweep-orphan-graph-node-vector:orphan-a",
    ]);
  });

  test("no orphans → no jobs enqueued and no rows deleted", () => {
    seedNode("live", "vivid");
    seedEmbedding("emb-live", "graph_node", "live");

    migrateSweepOrphanedGraphNodeVectors(getDb());

    expect(embeddingIds()).toEqual(["emb-live"]);
    expect(qdrantDeletionTargets()).toEqual([]);
  });
});

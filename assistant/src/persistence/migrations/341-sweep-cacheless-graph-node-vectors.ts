import { type DrizzleDb, getMemorySqlite } from "../db-connection.js";

/** Deterministic id so re-runs INSERT OR IGNORE the same row (idempotent). */
const SWEEP_JOB_ID = "migration-341-sweep-cacheless-graph-node-vectors";

/**
 * Enqueue a deferred sweep of `graph_node` Qdrant points that have neither a
 * backing `memory_graph_nodes` row nor a `memory_embeddings` cache row.
 *
 * Migration 340 finds orphaned graph-node vectors through `memory_embeddings`
 * cache rows, but `embedAndUpsert` treats that cache write as best-effort: a
 * cache-write failure logs and still upserts the Qdrant point, leaving a
 * `graph_node` point with no cache row. Those cacheless points are invisible to
 * 340's cache-driven sweep, so once migration 323 hard-deletes their backing
 * nodes they keep occupying `searchGraphNodes` top-K slots indefinitely.
 *
 * Finding them requires enumerating the collection directly from Qdrant, which
 * is not initialized at migration time — the memory plugin brings it up after DB
 * init. So this migration only enqueues a durable
 * `sweep_orphaned_graph_node_points` job on the memory database, mirroring how
 * migration 340 and the live delete path defer Qdrant work to the memory worker.
 * The worker — running once Qdrant is up, and held pending under memory v2 where
 * the v1 collection is intentionally absent — scrolls every `graph_node` point
 * and deletes those whose backing node row is gone (see
 * `sweepOrphanedGraphNodePoints`).
 *
 * Registered after migration 340, so it catches exactly the cacheless orphans
 * 340 cannot see. Idempotent: the job id is deterministic and INSERT OR IGNOREd,
 * and the sweep handler is itself idempotent (a second run finds no orphans).
 * Throws when the memory database is unavailable so the runner defers and
 * retries on a later boot rather than silently skipping the sweep. The main
 * `_database` is unused — the job queue lives on the memory database.
 */
export function migrateSweepCachelessGraphNodeVectors(
  _database: DrizzleDb,
): void {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable — deferring cacheless graph-node vector sweep",
    );
  }

  memoryRaw
    .query(
      /*sql*/ `INSERT OR IGNORE INTO memory_jobs
         (id, type, payload, status, attempts, run_after, created_at, updated_at)
       VALUES (?, 'sweep_orphaned_graph_node_points', '{}', 'pending', 0, 0, 0, 0)`,
    )
    .run(SWEEP_JOB_ID);
}

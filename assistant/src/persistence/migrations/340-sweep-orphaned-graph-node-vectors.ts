import {
  type DrizzleDb,
  getMemorySqlite,
  getSqliteFrom,
} from "../db-connection.js";
import { ensureMemoryJobsSchema } from "./298-move-memory-jobs-to-memory-db.js";

/**
 * Purge orphaned `graph_node` vector state left behind when a memory graph
 * node's SQL row is hard-deleted.
 *
 * `searchGraphNodes` queries Qdrant with no scope filter and hydrates the hits
 * from `memory_graph_nodes`; a vector whose backing node row is gone consumes a
 * fixed top-K slot and is then silently dropped during hydration, starving
 * default-scope recall. A bare `DELETE FROM memory_graph_nodes` (migration 323's
 * non-default-scope purge) removes the SQL row but leaves the node's Qdrant
 * `graph_node` point and its cached `memory_embeddings` row behind as exactly
 * such orphans.
 *
 * Every `graph_node` Qdrant point is written alongside a `memory_embeddings`
 * row (see `embedAndUpsert`), so an embedding row whose `target_id` no longer
 * exists in `memory_graph_nodes` uniquely identifies an orphan. For each, this
 * enqueues a `delete_qdrant_vectors` job on the memory database — the same
 * primitive the live delete path and migration 229 use — so the worker drops
 * the Qdrant point through its circuit breaker, then deletes the stale cache
 * row. The normal delete path soft-deletes (`fidelity = 'gone'`, row retained),
 * so live-deleted nodes keep their row and are not swept.
 *
 * Registered after migration 323, so on a not-yet-migrated database it sweeps
 * the rows 323 deletes in the same boot; on an already-migrated database (323
 * checkpointed) it sweeps the orphans 323 left on an earlier boot.
 *
 * Idempotent: deterministic job ids are INSERT OR IGNOREd, and once the orphan
 * embedding rows are deleted a re-run finds nothing. Throws when the memory
 * database is unavailable so the runner defers and retries on a later boot,
 * rather than deleting cache rows without enqueuing the matching Qdrant
 * deletions.
 */
export function migrateSweepOrphanedGraphNodeVectors(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const ORPHAN_PREDICATE = /*sql*/ `target_type = 'graph_node'
      AND target_id NOT IN (SELECT id FROM memory_graph_nodes)`;

  let orphanIds: string[];
  try {
    orphanIds = (
      raw
        .query(
          /*sql*/ `SELECT DISTINCT target_id FROM memory_embeddings WHERE ${ORPHAN_PREDICATE}`,
        )
        .all() as Array<{ target_id: string }>
    ).map((row) => row.target_id);
  } catch {
    // memory_embeddings or memory_graph_nodes absent — nothing to sweep.
    return;
  }

  if (orphanIds.length === 0) {
    return;
  }

  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable — deferring orphaned graph-node vector sweep",
    );
  }

  // Self-heal a memory database missing the relocated `memory_jobs` table
  // (e.g. a vbundle import carries the main DB's migration bookkeeping but not
  // `assistant-memory.db`, so relocation 298 never re-runs). Idempotent
  // (`IF NOT EXISTS`) — a no-op when the table already exists.
  ensureMemoryJobsSchema(memoryRaw);

  // Enqueue the Qdrant point deletions before dropping the cache rows: a crash
  // in between re-reads the same orphans next boot (nothing checkpointed) and
  // the deterministic ids INSERT OR IGNORE, so no work is lost or duplicated.
  const enqueue = memoryRaw.query(/*sql*/ `INSERT OR IGNORE INTO memory_jobs
       (id, type, payload, status, attempts, run_after, created_at, updated_at)
     VALUES (?, 'delete_qdrant_vectors', ?, 'pending', 0, 0, 0, 0)`);
  const enqueueAll = memoryRaw.transaction((ids: string[]) => {
    for (const id of ids) {
      enqueue.run(
        `migration-340-sweep-orphan-graph-node-vector:${id}`,
        JSON.stringify({ targetType: "graph_node", targetId: id }),
      );
    }
  });
  enqueueAll(orphanIds);

  raw.run(/*sql*/ `DELETE FROM memory_embeddings WHERE ${ORPHAN_PREDICATE}`);
}

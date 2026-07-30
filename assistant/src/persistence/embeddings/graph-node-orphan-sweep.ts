import { getMemoryDb } from "../db-connection.js";
import { memoryGraphNodes } from "../schema/index.js";
import { withQdrantBreaker } from "./qdrant-circuit-breaker.js";

/** Qdrant point-payload `target_type` for memory graph nodes. */
const GRAPH_NODE_TARGET_TYPE = "graph_node";

/**
 * The subset of the Qdrant client the orphan sweep needs, narrowed to an
 * interface so the sweep can be unit-tested with a fake client.
 */
export interface GraphNodeSweepClient {
  scrollByTargetType(
    targetType: string,
  ): Promise<Array<{ id: string; payload: Record<string, unknown> }>>;
  deleteByTarget(targetType: string, targetId: string): Promise<void>;
}

export interface GraphNodeSweepResult {
  /** Distinct `graph_node` target ids currently indexed in Qdrant. */
  scanned: number;
  /** Orphan target ids whose Qdrant points were deleted. */
  deleted: number;
}

/**
 * Delete `graph_node` Qdrant points whose backing `memory_graph_nodes` row no
 * longer exists.
 *
 * `embedAndUpsert` treats the `memory_embeddings` cache write as best-effort: on
 * a cache-write failure it logs and still upserts the Qdrant point, so a node
 * can end up with a `graph_node` point but no cache row. Migration 340 discovers
 * orphans only through cache rows, so those cacheless points survive its sweep;
 * once migration 323 hard-deletes their backing nodes they keep consuming
 * `searchGraphNodes` top-K slots (the query hydrates hits from
 * `memory_graph_nodes` and silently drops rows that are gone).
 *
 * This enumerates the authoritative set of indexed `graph_node` points straight
 * from Qdrant — the only place cacheless points are recorded — and deletes any
 * whose `target_id` has no row in `memory_graph_nodes`. Membership is
 * existence-based, matching migration 340: a soft-deleted node keeps its row
 * (`fidelity = 'gone'`) and therefore its point.
 *
 * Idempotent: a second run finds no orphans. Deletion is by Qdrant payload
 * (`target_type` + `target_id`) via `deleteByTarget`, so it removes cacheless
 * points a cache lookup could never surface. Both the initial scroll and each
 * delete go through the Qdrant circuit breaker: an already-open circuit surfaces
 * as `QdrantCircuitOpenError` so the caller (the memory worker) defers the sweep
 * instead of spending its bounded retries, and a transient failure propagates
 * for retry on a later cycle.
 */
export async function sweepOrphanedGraphNodePoints(
  qdrant: GraphNodeSweepClient,
): Promise<GraphNodeSweepResult> {
  const points = await withQdrantBreaker(() =>
    qdrant.scrollByTargetType(GRAPH_NODE_TARGET_TYPE),
  );

  const indexedTargetIds = new Set<string>();
  for (const { payload } of points) {
    const targetId = payload.target_id;
    if (typeof targetId === "string" && targetId.length > 0) {
      indexedTargetIds.add(targetId);
    }
  }
  if (indexedTargetIds.size === 0) {
    return { scanned: 0, deleted: 0 };
  }

  // A node row of any fidelity (including soft-deleted `gone`) keeps its point;
  // only a fully absent row marks an orphan. Load the id column once and diff in
  // memory rather than issuing one membership query per indexed point. The graph
  // lives on the memory connection; if it cannot be opened, bail without deleting
  // — an empty membership set would treat every point as an orphan.
  const memoryDb = getMemoryDb();
  if (!memoryDb) {
    return { scanned: indexedTargetIds.size, deleted: 0 };
  }
  const liveNodeIds = new Set(
    memoryDb
      .select({ id: memoryGraphNodes.id })
      .from(memoryGraphNodes)
      .all()
      .map((row) => row.id),
  );

  let deleted = 0;
  for (const targetId of indexedTargetIds) {
    if (liveNodeIds.has(targetId)) {
      continue;
    }
    await withQdrantBreaker(() =>
      qdrant.deleteByTarget(GRAPH_NODE_TARGET_TYPE, targetId),
    );
    deleted++;
  }

  return { scanned: indexedTargetIds.size, deleted };
}

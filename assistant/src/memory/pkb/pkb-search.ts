// ---------------------------------------------------------------------------
// PKB — Qdrant hybrid search for indexed PKB markdown files
// ---------------------------------------------------------------------------

import { getLogger } from "../../util/logger.js";
import {
  isQdrantBreakerOpen,
  withQdrantBreaker,
} from "../qdrant-circuit-breaker.js";
import {
  getQdrantClient,
  type QdrantSearchResult,
  type QdrantSparseVector,
} from "../qdrant-client.js";
import { PKB_TARGET_TYPE, type PkbSearchResult } from "./types.js";

const log = getLogger("pkb-search");

/**
 * Semantic search across indexed PKB markdown files in Qdrant.
 *
 * Always runs a dense-only cosine query so callers have a cosine-scaled
 * score they can threshold against. When a non-empty sparse vector is
 * provided, runs a parallel hybrid (dense + sparse with RRF fusion) query
 * and attaches its RRF score to each result as `hybridScore`. Consumers
 * filter by `denseScore` (absolute cosine quality bar) and rank by
 * `hybridScore ?? denseScore` (sparse-aware ordering when available).
 *
 * PKB files are chunked at index time, so a single path can match on
 * multiple chunks. Scores collapse to the highest per path, per query.
 * The two queries are unioned by path — a path present in only one
 * response still surfaces, with the missing score left `undefined` on
 * its result.
 */
export async function searchPkbFiles(
  queryVector: number[],
  sparseVector: QdrantSparseVector | undefined,
  limit: number,
  scopeIds?: string[],
): Promise<PkbSearchResult[]> {
  if (isQdrantBreakerOpen()) {
    log.warn("Qdrant circuit breaker open, skipping PKB search");
    return [];
  }

  const client = getQdrantClient();

  // Request more chunk-level hits than `limit` because multiple chunks
  // from the same file collapse to a single result.
  const prefetchLimit = Math.max(limit * 3, limit);

  const baseMust: Record<string, unknown>[] = [
    { key: "target_type", match: { value: PKB_TARGET_TYPE } },
    ...(scopeIds && scopeIds.length > 0
      ? [{ key: "memory_scope_id", match: { any: scopeIds } }]
      : []),
  ];
  const filter = {
    must: baseMust,
    must_not: [{ key: "_meta", match: { value: true } }],
  };

  const densePromise = withQdrantBreaker(() =>
    client.search(queryVector, prefetchLimit, filter),
  );

  const useHybrid = !!(sparseVector && sparseVector.indices.length > 0);
  const hybridPromise: Promise<QdrantSearchResult[]> = useHybrid
    ? withQdrantBreaker(() =>
        client.hybridSearch({
          denseVector: queryVector,
          sparseVector: sparseVector!,
          filter,
          limit: prefetchLimit,
          prefetchLimit: prefetchLimit * 3,
        }),
      )
    : Promise.resolve([]);

  const [denseResults, hybridResults] = await Promise.all([
    densePromise,
    hybridPromise,
  ]);

  const denseByPath = collapseByPath(denseResults);
  const hybridByPath = useHybrid ? collapseByPath(hybridResults) : new Map();

  const allPaths = new Set<string>([
    ...denseByPath.keys(),
    ...hybridByPath.keys(),
  ]);

  const merged: PkbSearchResult[] = [];
  for (const path of allPaths) {
    const denseScore = denseByPath.get(path);
    const hybridScore = hybridByPath.get(path);
    // A path that only shows up in the hybrid query (past the dense prefetch
    // limit) has no cosine score to gate on. Carry denseScore = 0 so callers
    // see it but can filter it out with their threshold.
    merged.push({
      path,
      denseScore: denseScore ?? 0,
      ...(useHybrid && hybridScore !== undefined ? { hybridScore } : {}),
    });
  }

  // Ranking: items that appear in the hybrid query are ordered amongst
  // themselves by hybridScore (RRF fusion's sparse-aware ordering), and
  // placed ahead of items that only appeared in the dense query. Dense-only
  // items are ordered by denseScore. Scales differ across the two groups so
  // we must not compare a hybridScore to a denseScore directly.
  merged.sort((a, b) => {
    const aHasHybrid = a.hybridScore !== undefined;
    const bHasHybrid = b.hybridScore !== undefined;
    if (aHasHybrid && !bHasHybrid) return -1;
    if (!aHasHybrid && bHasHybrid) return 1;
    if (aHasHybrid && bHasHybrid) return b.hybridScore! - a.hybridScore!;
    return b.denseScore - a.denseScore;
  });

  return merged.slice(0, limit);
}

/** Collapse chunk-level Qdrant hits to one score per payload.path (max). */
function collapseByPath(results: QdrantSearchResult[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const r of results) {
    const payload = r.payload as unknown as { path?: unknown };
    const path = typeof payload.path === "string" ? payload.path : undefined;
    if (!path) continue;
    const existing = best.get(path);
    if (existing === undefined || r.score > existing) {
      best.set(path, r.score);
    }
  }
  return best;
}

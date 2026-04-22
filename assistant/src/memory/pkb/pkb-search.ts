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
 * Only paths with a dense cosine score are returned (hybrid-only matches
 * are dropped because their implicit `denseScore = 0` can never satisfy a
 * caller's threshold, and keeping them would evict dense-qualifying hits
 * from the pre-slice top-`limit` window).
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

  // Silence any hybrid rejection so a short-circuit on dense failure below
  // does not surface it as an unhandledRejection. We still `await` the
  // original promise in the non-short-circuit path to observe its outcome.
  hybridPromise.catch(() => {});

  // Dense is the required signal — only paths with a dense cosine score are
  // merged, so a dense rejection guarantees `[]` regardless of hybrid. Return
  // immediately rather than blocking on hybrid latency.
  let denseResults: QdrantSearchResult[];
  try {
    denseResults = await densePromise;
  } catch (err) {
    log.warn({ err }, "Dense PKB search failed; returning empty results");
    return [];
  }

  let hybridResults: QdrantSearchResult[] = [];
  if (useHybrid) {
    try {
      hybridResults = await hybridPromise;
    } catch (err) {
      log.warn(
        { err },
        "Hybrid PKB search failed; falling back to dense-only results",
      );
    }
  }

  const denseByPath = collapseByPath(denseResults);
  const hybridByPath = useHybrid ? collapseByPath(hybridResults) : new Map();

  // Only surface paths that have a dense cosine score. Hybrid-only hits
  // (paths that appeared in the hybrid query but fell outside the dense
  // prefetch) would have `denseScore = 0`, which is guaranteed to fail any
  // caller's cosine threshold — and because they'd sort ahead of dense
  // matches (hybrid-first ranking), they'd evict dense-qualifying hits from
  // the top-`limit` window before callers ever get a chance to gate on
  // denseScore. Dropping them keeps gating meaningful with the pre-slice.
  const merged: PkbSearchResult[] = [];
  for (const [path, denseScore] of denseByPath) {
    const hybridScore = hybridByPath.get(path);
    merged.push({
      path,
      denseScore,
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

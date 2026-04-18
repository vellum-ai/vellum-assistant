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
 * Hybrid semantic search across indexed PKB markdown files in Qdrant.
 *
 * Mirrors `searchGraphNodes` — dense + sparse with RRF fusion when a
 * non-empty sparse vector is provided, dense-only fallback otherwise —
 * but filters to `target_type: "pkb_file"`.
 *
 * PKB files are chunked at index time, so a single path can match on
 * multiple chunks. Results are grouped by `payload.path`, keeping the
 * highest score per path, then sorted by score descending and capped
 * at `limit`.
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

  let results: QdrantSearchResult[];

  if (sparseVector && sparseVector.indices.length > 0) {
    const must: Record<string, unknown>[] = [
      { key: "target_type", match: { value: PKB_TARGET_TYPE } },
      ...(scopeIds && scopeIds.length > 0
        ? [{ key: "memory_scope_id", match: { any: scopeIds } }]
        : []),
    ];
    const filter = {
      must,
      must_not: [{ key: "_meta", match: { value: true } }],
    };

    results = await withQdrantBreaker(() =>
      client.hybridSearch({
        denseVector: queryVector,
        sparseVector,
        filter,
        limit: prefetchLimit,
        prefetchLimit: prefetchLimit * 3,
      }),
    );
  } else {
    const denseMusts: Record<string, unknown>[] = [
      { key: "target_type", match: { value: PKB_TARGET_TYPE } },
    ];

    if (scopeIds && scopeIds.length > 0) {
      denseMusts.push({
        key: "memory_scope_id",
        match: { any: scopeIds },
      });
    }

    const filter: Record<string, unknown> = { must: denseMusts };

    results = await withQdrantBreaker(async () => {
      return client.search(queryVector, prefetchLimit, filter);
    });
  }

  // Collapse chunk-level hits to one result per path, keeping the best score.
  const bestByPath = new Map<string, PkbSearchResult>();
  for (const r of results) {
    const payload = r.payload as unknown as { path?: unknown };
    const path = typeof payload.path === "string" ? payload.path : undefined;
    if (!path) continue;

    const existing = bestByPath.get(path);
    if (!existing || r.score > existing.score) {
      bestByPath.set(path, { path, score: r.score });
    }
  }

  return [...bestByPath.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

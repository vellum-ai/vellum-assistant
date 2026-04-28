// ---------------------------------------------------------------------------
// Memory v2 — Qdrant collection for concept pages
// ---------------------------------------------------------------------------
//
// Owns a dedicated Qdrant collection, keyed by concept-page slug, that holds
// dense + sparse embeddings of every page under `memory/concepts/`. The
// collection is separate from the v1 `memory` collection so v2 retrieval can
// roll out (and roll back) without disturbing the v1 graph + PKB hot path.
//
// Mirrors the dense + sparse named-vectors layout used by `VellumQdrantClient`
// in `qdrant-client.ts` (the v1 PKB collection setup pattern). Connection
// settings — URL, vector size, on-disk storage — flow through the same env →
// config precedence as v1 via `resolveQdrantUrl` and `config.memory.qdrant.*`,
// so users get a consistent Qdrant target without separate v2 knobs.
//
// Per-channel queries: `hybridQueryConceptPages` runs separate dense and
// sparse queries (no Qdrant-side RRF). Callers do their own weighted-sum
// fusion using `dense_weight` / `sparse_weight` from `config.memory.v2`,
// which RRF fusion would discard.

import { QdrantClient as QdrantRestClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import type { SparseEmbedding } from "../embedding-types.js";
import { resolveQdrantUrl } from "../qdrant-client.js";

const log = getLogger("memory-v2-qdrant");

/** Name of the dedicated Qdrant collection holding concept-page embeddings. */
export const MEMORY_V2_COLLECTION = "memory_v2_concept_pages";

/**
 * Stable UUIDv5 namespace used to derive a deterministic Qdrant point ID from
 * a slug. The namespace is an arbitrary fixed UUID; what matters is that the
 * same slug always maps to the same point ID so upserts replace in place
 * instead of accumulating duplicates.
 */
const SLUG_NAMESPACE = "8b9c5d4f-0e1a-4f3b-9c2d-7e8f1a2b3c4d";

export interface ConceptPagePayload {
  slug: string;
  updated_at: number;
}

/** Per-channel score for a single concept-page hit returned by hybrid query. */
export interface ConceptPageQueryResult {
  slug: string;
  /**
   * Dense cosine similarity, when the slug appeared in the dense top-`limit`.
   * `undefined` if the slug only appeared in the sparse channel.
   */
  denseScore?: number;
  /**
   * Sparse score, when the slug appeared in the sparse top-`limit`.
   * `undefined` if the slug only appeared in the dense channel. Lives on a
   * different scale than `denseScore` — callers must normalize before fusing.
   */
  sparseScore?: number;
}

let _client: QdrantRestClient | null = null;
let _collectionReady = false;

/** Lazily create a Qdrant REST client bound to the resolved URL. */
function getClient(): QdrantRestClient {
  if (_client) return _client;
  const config = getConfig();
  _client = new QdrantRestClient({
    url: resolveQdrantUrl(config),
    checkCompatibility: false,
  });
  return _client;
}

/**
 * Create the v2 concept-page collection if it does not already exist.
 * Idempotent: a no-op when the collection is already present.
 *
 * Vector layout mirrors `VellumQdrantClient.ensureCollection` — named dense
 * (cosine, configurable size + on-disk) and sparse vectors. The vector size
 * and on-disk flag inherit from `config.memory.qdrant` so v2 stays aligned
 * with the user's existing embedding backend without separate knobs.
 */
export async function ensureConceptPageCollection(): Promise<void> {
  if (_collectionReady) return;

  const client = getClient();
  const config = getConfig();
  const vectorSize = config.memory.qdrant.vectorSize;
  const onDisk = config.memory.qdrant.onDisk;

  try {
    const exists = await client.collectionExists(MEMORY_V2_COLLECTION);
    if (exists.exists) {
      _collectionReady = true;
      return;
    }
  } catch (err) {
    // Treat "not found"-shaped errors as "needs creation" and fall through.
    if (!isCollectionMissing(err)) throw err;
  }

  log.info(
    { collection: MEMORY_V2_COLLECTION, vectorSize },
    "Creating Qdrant collection for memory v2 concept pages",
  );

  try {
    await client.createCollection(MEMORY_V2_COLLECTION, {
      vectors: {
        dense: {
          size: vectorSize,
          distance: "Cosine",
          on_disk: onDisk,
        },
      },
      sparse_vectors: {
        sparse: {}, // Qdrant auto-infers sparse vector params
      },
      hnsw_config: {
        on_disk: onDisk,
        m: 16,
        ef_construct: 100,
      },
      on_disk_payload: onDisk,
    });
  } catch (err) {
    // 409 = a concurrent caller created the collection — that's fine.
    if (
      err instanceof Error &&
      "status" in err &&
      (err as { status: number }).status === 409
    ) {
      _collectionReady = true;
      return;
    }
    throw err;
  }

  // Slug is the only payload field we filter on; index it once at create-time
  // so upserts and slug-restricted queries don't pay a per-call indexing cost.
  await client.createPayloadIndex(MEMORY_V2_COLLECTION, {
    field_name: "slug",
    field_schema: "keyword",
  });

  _collectionReady = true;
}

/**
 * Upsert a concept page's dense + sparse embedding. The point ID is derived
 * deterministically from the slug so subsequent calls for the same slug
 * replace the prior point in place rather than accumulating duplicates.
 */
export async function upsertConceptPageEmbedding(params: {
  slug: string;
  dense: number[];
  sparse: SparseEmbedding;
  updatedAt: number;
}): Promise<void> {
  await ensureConceptPageCollection();

  const { slug, dense, sparse, updatedAt } = params;
  const client = getClient();
  const pointId = pointIdForSlug(slug);

  const upsertOnce = () =>
    client.upsert(MEMORY_V2_COLLECTION, {
      wait: true,
      points: [
        {
          id: pointId,
          vector: { dense, sparse },
          payload: { slug, updated_at: updatedAt },
        },
      ],
    });

  try {
    await upsertOnce();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureConceptPageCollection();
      await upsertOnce();
      return;
    }
    throw err;
  }
}

/** Remove the embedding for a slug. Idempotent: no-op when the slug is absent. */
export async function deleteConceptPageEmbedding(slug: string): Promise<void> {
  await ensureConceptPageCollection();

  const client = getClient();
  const doDelete = () =>
    client.delete(MEMORY_V2_COLLECTION, {
      wait: true,
      points: [pointIdForSlug(slug)],
    });

  try {
    await doDelete();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureConceptPageCollection();
      await doDelete();
      return;
    }
    throw err;
  }
}

/**
 * Run separate dense and sparse queries against the concept-page collection
 * and return per-channel scores per slug. Callers fuse these — typically via
 * a normalized weighted-sum — because RRF would discard the score magnitudes
 * the activation formula needs.
 *
 * Each channel returns up to `limit` hits. A slug is included in the result
 * if it appears in either channel; the missing channel's score is left
 * `undefined` so callers can detect single-channel matches.
 *
 * `restrictToSlugs`, when provided, filters the search server-side to only
 * those slugs (Qdrant `slug IN [...]` filter). Used by `simBatch` when the
 * candidate set is already known so we don't waste hits on unrelated pages.
 * An empty list short-circuits to no results — the caller is asking for
 * "nothing", not "everything".
 */
export async function hybridQueryConceptPages(
  dense: number[],
  sparse: SparseEmbedding,
  limit: number,
  restrictToSlugs?: readonly string[],
): Promise<ConceptPageQueryResult[]> {
  if (restrictToSlugs && restrictToSlugs.length === 0) {
    // An empty restriction means "no candidates"; skip the round-trip.
    return [];
  }

  await ensureConceptPageCollection();

  const client = getClient();
  const filter = restrictToSlugs
    ? { must: [{ key: "slug", match: { any: [...restrictToSlugs] } }] }
    : undefined;

  const denseQuery = () =>
    client.query(MEMORY_V2_COLLECTION, {
      query: dense,
      using: "dense",
      limit,
      with_payload: true,
      filter,
    });
  const sparseQuery = () =>
    client.query(MEMORY_V2_COLLECTION, {
      query: sparse,
      using: "sparse",
      limit,
      with_payload: true,
      filter,
    });

  // Run both queries concurrently — they hit independent named vectors.
  const runQueries = async () => Promise.all([denseQuery(), sparseQuery()]);

  let denseResults;
  let sparseResults;
  try {
    [denseResults, sparseResults] = await runQueries();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureConceptPageCollection();
      [denseResults, sparseResults] = await runQueries();
    } else {
      throw err;
    }
  }

  // Merge by slug. Missing-side scores stay undefined so the fuser can tell
  // "no match in this channel" apart from "match with score 0".
  const merged = new Map<string, ConceptPageQueryResult>();
  for (const point of denseResults.points ?? []) {
    const slug = (point.payload as { slug?: unknown } | null)?.slug;
    if (typeof slug !== "string") continue;
    merged.set(slug, { slug, denseScore: point.score ?? 0 });
  }
  for (const point of sparseResults.points ?? []) {
    const slug = (point.payload as { slug?: unknown } | null)?.slug;
    if (typeof slug !== "string") continue;
    const existing = merged.get(slug);
    if (existing) {
      existing.sparseScore = point.score ?? 0;
    } else {
      merged.set(slug, { slug, sparseScore: point.score ?? 0 });
    }
  }

  return Array.from(merged.values());
}

/**
 * Detect "collection not found" errors so callers can reset readiness and
 * retry after an external deletion (e.g. workspace reset).
 */
function isCollectionMissing(err: unknown): boolean {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    (err as { status: number }).status === 404
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Not found") ||
    msg.includes("doesn't exist") ||
    msg.includes("not found")
  );
}

/**
 * Derive the deterministic Qdrant point ID for a slug. Qdrant requires
 * UUID/integer IDs; UUIDv5 keeps the mapping stable across processes so
 * upserts replace in place.
 */
function pointIdForSlug(slug: string): string {
  return uuidv5(slug, SLUG_NAMESPACE);
}

/** @internal Test-only: reset module-level singletons. */
export function _resetMemoryV2QdrantForTests(): void {
  _client = null;
  _collectionReady = false;
}

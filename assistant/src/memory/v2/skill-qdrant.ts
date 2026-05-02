// ---------------------------------------------------------------------------
// Memory v2 — Qdrant collection for skill autoinjection
// ---------------------------------------------------------------------------
//
// Owns a dedicated Qdrant collection, keyed by skill `id`, that holds dense +
// sparse embeddings of every enabled skill's `buildSkillContent` snippet. The
// collection is separate from `memory_v2_concept_pages` because skills are
// stateless (no `everInjected` dedup, no on-disk concept pages, no edges) and
// re-presented every turn — keeping them in their own collection means skill
// pruning and reseeding never touches concept-page state.
//
// Mirrors the dense + sparse named-vectors layout used by
// `ensureConceptPageCollection` in `qdrant.ts`. Connection settings — URL,
// vector size, on-disk storage — flow through the same env → config
// precedence as v1 via `resolveQdrantUrl` and `config.memory.qdrant.*`.
//
// Per-channel queries: `hybridQuerySkills` runs separate dense and sparse
// queries (no Qdrant-side RRF). Callers do their own weighted-sum fusion using
// `dense_weight` / `sparse_weight` from `config.memory.v2`, which RRF fusion
// would discard.

import { QdrantClient as QdrantRestClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import type { SparseEmbedding } from "../embedding-types.js";
import { resolveQdrantUrl } from "../qdrant-client.js";

const log = getLogger("memory-v2-skill-qdrant");

/** Name of the dedicated Qdrant collection holding skill embeddings. */
export const MEMORY_V2_SKILLS_COLLECTION = "memory_v2_skills";

/**
 * Stable UUIDv5 namespace used to derive a deterministic Qdrant point ID from
 * a skill id. The namespace is an arbitrary fixed UUID; what matters is that
 * the same id always maps to the same point ID so upserts replace in place
 * instead of accumulating duplicates. Distinct from `qdrant.ts`'s
 * `SLUG_NAMESPACE` so a skill id that happens to collide with a concept-page
 * slug still maps to a different point ID across the two collections.
 */
export const SKILL_NAMESPACE = "f1903e7f-1b9d-4c15-ac46-3540b8b0a9f6";

/**
 * Per-channel score for a single skill hit returned by hybrid query.
 * Module-private — `sim.ts` consumes the fields by duck-typing rather than
 * naming the type, so there is no benefit to exporting it.
 */
interface SkillQueryResult {
  id: string;
  /**
   * Dense cosine similarity, when the id appeared in the dense top-`limit`.
   * `undefined` if the id only appeared in the sparse channel.
   */
  denseScore?: number;
  /**
   * Sparse score, when the id appeared in the sparse top-`limit`.
   * `undefined` if the id only appeared in the dense channel. Lives on a
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
 * Create the v2 skills collection if it does not already exist.
 * Idempotent: a no-op when the collection is already present.
 *
 * Vector layout mirrors `ensureConceptPageCollection` — named dense (cosine,
 * configurable size + on-disk) and sparse vectors. The vector size and
 * on-disk flag inherit from `config.memory.qdrant` so v2 stays aligned with
 * the user's existing embedding backend without separate knobs.
 */
export async function ensureSkillCollection(): Promise<void> {
  if (_collectionReady) return;

  const client = getClient();
  const config = getConfig();
  const vectorSize = config.memory.qdrant.vectorSize;
  const onDisk = config.memory.qdrant.onDisk;

  try {
    const exists = await client.collectionExists(MEMORY_V2_SKILLS_COLLECTION);
    if (exists.exists) {
      _collectionReady = true;
      return;
    }
  } catch (err) {
    // Treat "not found"-shaped errors as "needs creation" and fall through.
    if (!isCollectionMissing(err)) throw err;
  }

  log.info(
    { collection: MEMORY_V2_SKILLS_COLLECTION, vectorSize },
    "Creating Qdrant collection for memory v2 skills",
  );

  try {
    await client.createCollection(MEMORY_V2_SKILLS_COLLECTION, {
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

  // Eagerly index `id` so future per-id filters (e.g. inspecting a single
  // skill's stored payload) don't pay a one-time indexing cost. Mirrors the
  // up-front `slug` index in `ensureConceptPageCollection`.
  await client.createPayloadIndex(MEMORY_V2_SKILLS_COLLECTION, {
    field_name: "id",
    field_schema: "keyword",
  });

  _collectionReady = true;
}

/**
 * Upsert a skill's dense + sparse embedding. The point ID is derived
 * deterministically from the skill id so subsequent calls for the same id
 * replace the prior point in place rather than accumulating duplicates.
 */
export async function upsertSkillEmbedding(params: {
  id: string;
  content: string;
  dense: number[];
  sparse: SparseEmbedding;
  updatedAt: number;
}): Promise<void> {
  await ensureSkillCollection();

  const { id, content, dense, sparse, updatedAt } = params;
  const client = getClient();
  const pointId = pointIdForId(id);

  const upsertOnce = () =>
    client.upsert(MEMORY_V2_SKILLS_COLLECTION, {
      wait: true,
      points: [
        {
          id: pointId,
          vector: { dense, sparse },
          payload: {
            id,
            content,
            updated_at: updatedAt,
          },
        },
      ],
    });

  try {
    await upsertOnce();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureSkillCollection();
      await upsertOnce();
      return;
    }
    throw err;
  }
}

/**
 * Remove every skill point whose `payload.id` is not in `activeIds`. Used by
 * `seedV2SkillEntries` to drop stale points after a skill is uninstalled or
 * disabled. Idempotent: when the live points already equal `activeIds`,
 * the function performs a single scroll and no deletes.
 *
 * Implementation: paginate the collection with the Qdrant `scroll` API
 * (payload-only, no vectors) and delete by point ID for any payload whose
 * `id` is missing from the active set.
 */
export async function pruneSkillsExcept(
  activeIds: readonly string[],
): Promise<void> {
  await ensureSkillCollection();

  const client = getClient();
  const activeSet = new Set(activeIds);

  const doPrune = async (): Promise<void> => {
    const stalePointIds: Array<string | number> = [];
    let offset: string | number | undefined = undefined;
    // Guard against a pathological pagination loop.
    const maxIterations = 10_000;
    const batchSize = 256;
    for (let i = 0; i < maxIterations; i++) {
      const result = await client.scroll(MEMORY_V2_SKILLS_COLLECTION, {
        limit: batchSize,
        with_payload: true,
        with_vector: false,
        ...(offset !== undefined ? { offset } : {}),
      });
      for (const point of result.points) {
        const payloadId = (point.payload as { id?: unknown } | null)?.id;
        if (typeof payloadId !== "string") continue;
        if (!activeSet.has(payloadId)) {
          stalePointIds.push(point.id);
        }
      }
      const next = result.next_page_offset;
      if (next == null) break;
      offset = typeof next === "string" ? next : (next as number);
    }

    if (stalePointIds.length === 0) return;

    await client.delete(MEMORY_V2_SKILLS_COLLECTION, {
      wait: true,
      points: stalePointIds,
    });
  };

  try {
    await doPrune();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureSkillCollection();
      await doPrune();
      return;
    }
    throw err;
  }
}

/**
 * Run separate dense and sparse queries against the skills collection and
 * return per-channel scores per skill id. Callers fuse these — typically via
 * a normalized weighted-sum — because RRF would discard the score magnitudes
 * the activation formula needs.
 *
 * Each channel returns up to `limit` hits. A skill is included in the result
 * if it appears in either channel; the missing channel's score is left
 * `undefined` so callers can detect single-channel matches.
 *
 * `restrictToIds`, when provided, filters the search server-side to only
 * those ids (Qdrant `id IN [...]` filter). Used by `simSkillBatch` when the
 * candidate set is already known so the activation scorer gets scores for
 * exactly those ids rather than Qdrant's global top-`limit`. An empty list
 * short-circuits to no results — the caller is asking for "nothing", not
 * "everything". Undefined queries the full collection (used by
 * `selectSkillCandidates` to discover candidates from the global top-K).
 */
export async function hybridQuerySkills(
  dense: number[],
  sparse: SparseEmbedding,
  limit: number,
  restrictToIds?: readonly string[],
  options?: { skipSparse?: boolean },
): Promise<SkillQueryResult[]> {
  if (restrictToIds && restrictToIds.length === 0) {
    // An empty restriction means "no candidates"; skip the round-trip.
    return [];
  }

  await ensureSkillCollection();

  const client = getClient();
  const filter = restrictToIds
    ? { must: [{ key: "id", match: { any: [...restrictToIds] } }] }
    : undefined;

  // Same opt-in short-circuit as `hybridQueryConceptPages`: skip the sparse
  // round-trip entirely so we sidestep the Qdrant 1.13.x sparse-index OOM
  // crash when operators flip sparse off via `sparse_weight: 0`.
  const skipSparse = options?.skipSparse ?? false;

  const denseQuery = () =>
    client.query(MEMORY_V2_SKILLS_COLLECTION, {
      query: dense,
      using: "dense",
      limit,
      with_payload: true,
      filter,
    });
  const sparseQuery = () =>
    client.query(MEMORY_V2_SKILLS_COLLECTION, {
      query: sparse,
      using: "sparse",
      limit,
      with_payload: true,
      filter,
    });

  // Run both queries concurrently — they hit independent named vectors.
  const emptyResult = {
    points: [] as Array<{ payload?: unknown; score?: number }>,
  };
  const runQueries = async () =>
    Promise.all([denseQuery(), skipSparse ? emptyResult : sparseQuery()]);

  let denseResults;
  let sparseResults;
  try {
    [denseResults, sparseResults] = await runQueries();
  } catch (err) {
    if (isCollectionMissing(err)) {
      _collectionReady = false;
      await ensureSkillCollection();
      [denseResults, sparseResults] = await runQueries();
    } else {
      throw err;
    }
  }

  // Merge by id. Missing-side scores stay undefined so the fuser can tell
  // "no match in this channel" apart from "match with score 0".
  const merged = new Map<string, SkillQueryResult>();
  for (const point of denseResults.points ?? []) {
    const id = (point.payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string") continue;
    merged.set(id, { id, denseScore: point.score ?? 0 });
  }
  for (const point of sparseResults.points ?? []) {
    const id = (point.payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string") continue;
    const existing = merged.get(id);
    if (existing) {
      existing.sparseScore = point.score ?? 0;
    } else {
      merged.set(id, { id, sparseScore: point.score ?? 0 });
    }
  }

  return Array.from(merged.values());
}

/**
 * Detect "collection not found" errors so callers can reset readiness and
 * retry after an external deletion (e.g. workspace reset). Re-implemented
 * locally rather than imported from `qdrant.ts` to keep this module
 * self-contained — the helper is small and the duplication is cleaner than
 * exporting an internal detail across files.
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
 * Derive the deterministic Qdrant point ID for a skill id. Qdrant requires
 * UUID/integer IDs; UUIDv5 keeps the mapping stable across processes so
 * upserts replace in place.
 */
function pointIdForId(id: string): string {
  return uuidv5(id, SKILL_NAMESPACE);
}

/** @internal Test-only: reset module-level singletons. */
export function _resetMemoryV2SkillQdrantForTests(): void {
  _client = null;
  _collectionReady = false;
}

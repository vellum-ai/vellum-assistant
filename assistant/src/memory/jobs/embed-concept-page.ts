// ---------------------------------------------------------------------------
// Memory v2 — `embed_concept_page` job handler
// ---------------------------------------------------------------------------
//
// Reads a concept page from `memory/concepts/<slug>.md`, computes its dense +
// sparse embeddings via the shared embedding backend, and upserts the pair
// into the dedicated v2 Qdrant collection. When the page has been deleted out
// from under us, the prior embedding is removed instead so the retrieval
// surface stays in sync with disk.
//
// Modeled on `embed-pkb-file.ts` for the embedding flow + cache key handling:
// dense vectors are looked up in the existing `memory_embeddings` SQLite cache
// keyed on `(targetType="concept_page", targetId=<slug>, provider, model,
// contentHash)` so unchanged pages skip the backend call. Unlike the PKB
// handler, the v2 path bypasses `embedAndUpsert` because that helper is hard-
// coupled to the v1 Qdrant collection — v2 uses its own collection via
// `upsertConceptPageEmbedding`.

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { applyCorrectionIfCalibrated } from "../anisotropy.js";
import { getDb } from "../db-connection.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
  getMemoryBackendStatus,
} from "../embedding-backend.js";
import { embeddingInputContentHash } from "../embedding-types.js";
import { asString, blobToVector, vectorToBlob } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { memoryEmbeddings } from "../schema.js";
import { readPage } from "../v2/page-store.js";
import {
  deleteConceptPageEmbedding,
  upsertConceptPageEmbedding,
} from "../v2/qdrant.js";
import {
  generateBm25DocEmbedding,
  getConceptPageCorpusStats,
} from "../v2/sparse-bm25.js";

const log = getLogger("memory-v2-embed-concept-page");

/** target_type marker stored on rows of `memory_embeddings` for v2 pages. */
const CONCEPT_PAGE_TARGET_TYPE = "concept_page";

/**
 * Input shape for the `embed_concept_page` background job.
 */
export interface EmbedConceptPageJobInput {
  /** Slug of the concept page to (re)embed (filename minus `.md`). */
  slug: string;
}

/**
 * Job handler: read the concept page at `memory/concepts/<slug>.md`, embed
 * (dense + sparse), and upsert into the v2 Qdrant collection.
 *
 * Delete semantics: when the page no longer exists on disk (consolidation
 * removed it, or the user deleted it manually), the handler removes the
 * matching embedding instead of leaving a stale point behind. This makes the
 * job a one-stop "sync this slug from disk to Qdrant" call and lets callers
 * enqueue the same job type for both updates and deletions without branching.
 */
export async function embedConceptPageJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const slug = asString(job.payload.slug);
  if (!slug) return;

  const workspaceDir = getWorkspaceDir();
  const page = await readPage(workspaceDir, slug);

  if (!page) {
    // Page was deleted out from under us — clean up the prior embedding so
    // retrieval no longer surfaces a slug whose disk-side prose is gone.
    await deleteConceptPageEmbedding(slug);
    return;
  }

  // Embed the prose body. Frontmatter is metadata the model never produces —
  // leaving it out keeps the embedding stable across pure edges-rebuild
  // backfills (which only rewrite frontmatter, not body) and matches the
  // design doc decision that "body is prose, embedded for sim()".
  const text = page.body;

  const status = await getMemoryBackendStatus(config);
  if (!status.provider) {
    throw new BackendUnavailableError(
      `Embedding backend unavailable (${status.reason ?? "no provider"})`,
    );
  }

  const contentHash = embeddingInputContentHash({ type: "text", text });
  const expectedDim = config.memory.qdrant.vectorSize;
  let provider = status.provider;
  let model = status.model!;

  // Cache lookup: same (targetType, targetId, provider, model) row gets
  // reused across runs as long as `contentHash` matches. The dim mismatch
  // check guards against a config change (vectorSize bumped) since the last
  // write — in that case we treat the row as stale and re-embed.
  const db = getDb();
  let cachedRow = db
    .select({
      vectorBlob: memoryEmbeddings.vectorBlob,
      vectorJson: memoryEmbeddings.vectorJson,
      dimensions: memoryEmbeddings.dimensions,
      contentHash: memoryEmbeddings.contentHash,
    })
    .from(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.targetType, CONCEPT_PAGE_TARGET_TYPE),
        eq(memoryEmbeddings.targetId, slug),
        eq(memoryEmbeddings.provider, provider),
        eq(memoryEmbeddings.model, model),
      ),
    )
    .get();
  if (cachedRow && cachedRow.dimensions !== expectedDim) cachedRow = undefined;
  if (cachedRow && cachedRow.contentHash !== contentHash) cachedRow = undefined;

  let dense: number[];
  let cacheHit = false;
  if (cachedRow) {
    dense = cachedRow.vectorBlob
      ? blobToVector(cachedRow.vectorBlob as Buffer)
      : (JSON.parse(cachedRow.vectorJson!) as number[]);
    cacheHit = true;
  } else {
    const embedded = await embedWithBackend(config, [{ type: "text", text }]);
    const vector = embedded.vectors[0];
    if (!vector) return;
    dense = vector;
    provider = embedded.provider;
    model = embedded.model;
  }

  // Sparse is cheap (in-process tokenization) and changes any time the body
  // changes, so we always recompute it rather than caching alongside dense.
  // BM25 weights live on the doc side; queries embed binary occurrence in
  // sim.ts. When corpus stats aren't built yet (cold daemon, walking the
  // corpus for the first time), fall back to the legacy TF-only encoding —
  // the next reembed pass overwrites the page once stats are available.
  const corpusStats = getConceptPageCorpusStats();
  const sparse = corpusStats
    ? generateBm25DocEmbedding(text, corpusStats, {
        k1: config.memory.v2.bm25_k1,
        b: config.memory.v2.bm25_b,
      })
    : generateSparseEmbedding(text);

  const now = Date.now();
  // Persist freshly embedded vectors for cross-restart reuse. On cache hit
  // the existing row already has identical content + hash, so the write
  // would be a no-op — skip it. Best-effort: write failure is not fatal,
  // we still want the Qdrant upsert below to fire.
  if (!cacheHit) {
    try {
      const blobValue = vectorToBlob(dense);
      db.insert(memoryEmbeddings)
        .values({
          id: randomUUID(),
          targetType: CONCEPT_PAGE_TARGET_TYPE,
          targetId: slug,
          provider,
          model,
          dimensions: dense.length,
          vectorBlob: blobValue,
          vectorJson: null,
          contentHash,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            memoryEmbeddings.targetType,
            memoryEmbeddings.targetId,
            memoryEmbeddings.provider,
            memoryEmbeddings.model,
          ],
          set: {
            vectorBlob: blobValue,
            vectorJson: null,
            dimensions: dense.length,
            contentHash,
            updatedAt: now,
          },
        })
        .run();
    } catch (err) {
      log.warn(
        { err, slug },
        "Failed to write concept-page embedding cache row",
      );
    }
  }

  // Apply anisotropy correction at the boundary between the (raw) cached
  // dense vector and the Qdrant collection. Storing raw in SQLite and
  // corrected in Qdrant means a recalibration just needs a reembed pass —
  // the cache survives and the (cheap) correction math reruns over each
  // cached vector. Pass-through when no calibration is fit yet.
  const correctedDense = await applyCorrectionIfCalibrated(
    dense,
    provider,
    model,
  );

  await upsertConceptPageEmbedding({
    slug,
    dense: correctedDense,
    sparse,
    updatedAt: now,
  });
}

/**
 * Enqueue an `embed_concept_page` job (async, fire-and-forget). Modeled on
 * `enqueuePkbIndexJob` — callers that want a slug re-embedded after a write
 * (or evicted after a delete) hand off to this helper instead of running the
 * embedding inline.
 */
export function enqueueEmbedConceptPageJob(
  input: EmbedConceptPageJobInput,
): string {
  return enqueueMemoryJob("embed_concept_page", { slug: input.slug });
}

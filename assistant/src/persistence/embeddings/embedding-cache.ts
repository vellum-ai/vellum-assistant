// ---------------------------------------------------------------------------
// Shared dense-embedding cache over the `memory_embeddings` SQLite table
// ---------------------------------------------------------------------------
//
// A read/write pair that caches one dense vector keyed on
// `(targetType, targetId, provider, model)` alongside the content hash it was
// embedded from, so callers can skip the embedding-backend round-trip when an
// input's text is unchanged. The `embed_concept_page` job pioneered this
// pattern for whole-page bodies; this module factors out the generic mechanics
// — dim-match gating, legacy-null-hash handling, blob encode/decode, and the
// upsert on the unique key — so other embedders (e.g. the v3 section dense
// store) reuse one implementation instead of duplicating it.

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getLogger } from "../../util/logger.js";
import type { getDb } from "../db-connection.js";
import { blobToVector, vectorToBlob } from "../job-utils.js";
import { memoryEmbeddings } from "../schema.js";

const log = getLogger("memory-embedding-cache");

type MemoryDb = ReturnType<typeof getDb>;

/** Lookup key for {@link readEmbeddingCache}. */
export interface EmbeddingCacheKey {
  targetType: string;
  targetId: string;
  provider: string;
  model: string;
  /** Configured embedding dimension; a row at a different size is a miss. */
  expectedDim: number;
}

/** A cached dense vector plus the content hash it was embedded from. */
export interface EmbeddingCacheEntry {
  dense: number[];
  contentHash: string;
}

/**
 * Look up a cached dense vector keyed on `(targetType, targetId, provider,
 * model)`. Returns the row only when the persisted dimensions match
 * `expectedDim` — a stale row from a previous `vectorSize` is treated as a miss
 * so the caller re-embeds. A row with a null `contentHash` (legacy/corrupt) is
 * likewise a miss rather than a key the caller could misalign against.
 */
export function readEmbeddingCache(
  db: MemoryDb,
  key: EmbeddingCacheKey,
): EmbeddingCacheEntry | null {
  const row = db
    .select({
      vectorBlob: memoryEmbeddings.vectorBlob,
      vectorJson: memoryEmbeddings.vectorJson,
      dimensions: memoryEmbeddings.dimensions,
      contentHash: memoryEmbeddings.contentHash,
    })
    .from(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.targetType, key.targetType),
        eq(memoryEmbeddings.targetId, key.targetId),
        eq(memoryEmbeddings.provider, key.provider),
        eq(memoryEmbeddings.model, key.model),
      ),
    )
    .get();
  if (!row || row.dimensions !== key.expectedDim) return null;
  if (row.contentHash === null) return null;
  const dense = row.vectorBlob
    ? blobToVector(row.vectorBlob as Buffer)
    : (JSON.parse(row.vectorJson!) as number[]);
  return { dense, contentHash: row.contentHash };
}

/** Parameters for {@link writeEmbeddingCache}. */
export interface EmbeddingCacheWrite {
  targetType: string;
  targetId: string;
  dense: number[];
  contentHash: string;
  provider: string;
  model: string;
  now: number;
}

/**
 * Persist a freshly embedded dense vector, upserting on the
 * `(targetType, targetId, provider, model)` unique key. Best-effort: a write
 * failure is logged and swallowed so the caller's downstream write still runs.
 */
export function writeEmbeddingCache(
  db: MemoryDb,
  params: EmbeddingCacheWrite,
): void {
  const { targetType, targetId, dense, contentHash, provider, model, now } =
    params;
  try {
    const blobValue = vectorToBlob(dense);
    db.insert(memoryEmbeddings)
      .values({
        id: randomUUID(),
        targetType,
        targetId,
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
      { err, targetType, targetId },
      "Failed to write embedding cache row",
    );
  }
}

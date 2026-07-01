// ---------------------------------------------------------------------------
// Memory v3 — section-grain dense Qdrant collection
// ---------------------------------------------------------------------------
//
// Owns a dedicated Qdrant collection holding one dense embedding per page
// *section* (the lead block plus each `## `-delimited heading section, chunked
// to fit the embedding window — see `sections.ts`). This is the dense lane for
// the section-grain retrieval design: where the v2 `memory_v2_concept_pages`
// collection embeds whole pages, this one embeds sub-page sections so a query
// can match the single relevant block of a long article.
//
// Reuses the v2 Qdrant URL/config (`resolveQdrantUrl` + `config.memory.qdrant.*`)
// and the shared embedding backend (`embedWithBackend`) rather than standing up
// new infrastructure. The collection carries a single dense named vector sized
// to the configured embedding backend (`config.memory.qdrant.vectorSize`) — no
// sparse channel, since the section dense lane is dense-only.
//
// This module owns the write side (collection lifecycle + upserts) and the
// shared Qdrant client; the read side (`dense.ts`) reuses that client to query
// this collection.

import { createHash } from "node:crypto";

import { QdrantClient as QdrantRestClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";

import type { AssistantConfig } from "../../../../config/types.js";
import { deleteMemoryCheckpoint } from "../../../../persistence/checkpoints.js";
import { getDb } from "../../../../persistence/db-connection.js";
import {
  geminiCacheExtras,
  getMemoryBackendStatus,
} from "../../../../persistence/embeddings/embedding-backend.js";
import {
  readEmbeddingCache,
  writeEmbeddingCache,
} from "../../../../persistence/embeddings/embedding-cache.js";
import { embeddingInputContentHash } from "../../../../persistence/embeddings/embedding-types.js";
import { getLogger } from "../../../../util/logger.js";
import { embedWithBackend, resolveQdrantUrl } from "../embeddings.js";
import type { Section } from "./types.js";

const log = getLogger("memory-v3-section-dense-store");

/** Name of the dedicated Qdrant collection holding section-grain embeddings. */
export const SECTION_COLLECTION = "memory_v3_sections";

/**
 * Durable checkpoint key holding the epoch-ms high-water of the last successful
 * section re-embed pass; read and advanced by the maintain job, which re-embeds
 * only pages whose mtime is past the mark. When the key is absent the maintainer
 * re-embeds EVERY page (seeding the otherwise-empty collection on first run), so
 * {@link ensureSectionCollection} clears it whenever it (re)creates an empty
 * collection to force a full rebuild. Defined here, beside the collection it
 * guards, so the store can clear it without importing the maintainer (which
 * depends on this module). Distinct from the tree-era `enriched_through_ms` and
 * from `memory_v3_maintain_last_run` (the enqueue-cadence checkpoint).
 */
export const MAINTAIN_EMBED_HIGH_WATER_KEY =
  "memory_v3_maintain:sections_embedded_through_ms";

/**
 * Stable UUIDv5 namespace used to derive a deterministic Qdrant point ID from a
 * section's `(article, ordinal)` pair. The namespace itself is an arbitrary
 * fixed UUID; what matters is that the same section always maps to the same
 * point ID so re-upserts replace the prior point in place instead of
 * accumulating duplicates.
 */
const SECTION_NAMESPACE = "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

let _client: QdrantRestClient | null = null;
let _collectionReady = false;

/**
 * Lazily create the shared Qdrant REST client bound to the resolved URL.
 * Shared by both section-dense lanes (this store and the dense read lane in
 * `dense.ts`) so they reuse one client instance and one reset hook.
 */
export function getSectionDenseClient(): QdrantRestClient {
  if (_client) return _client;
  _client = new QdrantRestClient({
    url: resolveQdrantUrl(),
    checkCompatibility: false,
  });
  return _client;
}

/**
 * Derive the deterministic Qdrant point ID for a section. Qdrant requires
 * UUID/integer IDs; UUIDv5 over `${article}#${ordinal}` keeps the mapping
 * stable across processes so upserts replace in place.
 */
function pointIdForSection(article: string, ordinal: number): string {
  return uuidv5(`${article}#${ordinal}`, SECTION_NAMESPACE);
}

/**
 * Create the section-grain collection if it does not already exist, with a
 * single dense vector sized to the configured embedding backend. Idempotent:
 * an already-ready collection is a no-op, and a concurrent 409-on-create is
 * treated as success.
 */
export async function ensureSectionCollection(
  config: AssistantConfig,
): Promise<void> {
  if (_collectionReady) return;

  const client = getSectionDenseClient();
  const vectorSize = config.memory.qdrant.vectorSize;
  const onDisk = config.memory.qdrant.onDisk;

  const exists = await client.collectionExists(SECTION_COLLECTION);
  let needsCreate = !exists.exists;

  // An existing collection sized to a different embedding dimension (e.g. a
  // 384-dim collection serving a 3072-dim embedder) carries the right vector
  // at the wrong size, so every upsert fails with HTTP 400 until it is rebuilt.
  // Recreate on drift: unlike the v2 concept-page collection (which holds the
  // only copy of segment/item embeddings and so is migrated by the probe-gated
  // startup reconcile), `memory_v3_sections` is entirely page-derived and is
  // repopulated by the probe-gated maintain/backfill pass, so recreating it
  // here loses no durable data. The startup reconcile reads only the v2
  // collection's dimension, so a v3-only drift would otherwise never be
  // repaired. On a probe failure, assume compatible rather than risk a
  // destructive recreate.
  if (exists.exists) {
    try {
      const info = await client.getCollection(SECTION_COLLECTION);
      const vectors = info.config?.params?.vectors;
      const size =
        vectors && typeof vectors === "object" && "size" in vectors
          ? (vectors as { size?: unknown }).size
          : undefined;
      if (typeof size === "number" && size !== vectorSize) {
        log.warn(
          { collection: SECTION_COLLECTION, expected: vectorSize, found: size },
          "Memory v3 section collection dimension drift — deleting and recreating; sections are page-derived and repopulated by the next maintain/backfill",
        );
        await client.deleteCollection(SECTION_COLLECTION);
        needsCreate = true;
      }
    } catch (err) {
      log.warn(
        { err, collection: SECTION_COLLECTION },
        "Failed to probe v3 section collection schema; assuming compatible",
      );
    }
  }

  if (needsCreate) {
    log.info(
      { collection: SECTION_COLLECTION, vectorSize },
      "Creating Qdrant collection for memory v3 sections",
    );
    try {
      await client.createCollection(SECTION_COLLECTION, {
        vectors: {
          size: vectorSize,
          distance: "Cosine",
          on_disk: onDisk,
        },
        hnsw_config: {
          on_disk: onDisk,
          m: 16,
          ef_construct: 100,
        },
        optimizers_config: {
          default_segment_number: 2,
        },
        on_disk_payload: onDisk,
      });
    } catch (err) {
      // 409 = a concurrent caller created the collection — fall through to
      // ensure the payload index below rather than returning early.
      const status =
        err instanceof Error && "status" in err
          ? (err as { status: number }).status
          : undefined;
      if (status !== 409) throw err;
    }

    // A freshly (re)created collection is empty, so the section dense store
    // must be rebuilt from the whole page corpus, not just pages edited since
    // the last pass. Clearing the embed high-water sends the next maintain pass
    // down its absent-key path (re-embed every page); leaving it set would strand
    // every page older than the checkpoint, invisible to the dense lane until it
    // is next edited.
    deleteMemoryCheckpoint(MAINTAIN_EMBED_HIGH_WATER_KEY);
  }

  // Always ensure the `article` payload index — on EVERY path (fresh create,
  // concurrent 409, and a pre-existing collection whose index creation was
  // interrupted by an earlier crash). `deleteSectionsForArticle`/pruning filter
  // on `article`, and strict-mode Qdrant rejects filters on unindexed fields, so
  // a missing index would make them fail until manual repair. createPayloadIndex
  // is idempotent, so re-running it against an existing index is a no-op.
  await client.createPayloadIndex(SECTION_COLLECTION, {
    field_name: "article",
    field_schema: "keyword",
  });

  _collectionReady = true;
}

/**
 * Destructively delete and recreate the section-grain collection at the
 * configured `config.memory.qdrant.vectorSize`. Owned by the probe-gated
 * startup reconcile, the only path permitted to make the destroy-before-confirm
 * decision for a dimension migration (the lazy `ensureSectionCollection` path
 * explicitly defers dimension drift). Resets the in-process readiness latch and
 * delegates creation to `ensureSectionCollection` so the vector layout and
 * payload index flow through the single creation code path. Idempotent against
 * an absent collection.
 */
export async function recreateSectionCollection(
  config: AssistantConfig,
): Promise<void> {
  const client = getSectionDenseClient();
  const exists = await client.collectionExists(SECTION_COLLECTION);
  if (exists.exists) {
    await client.deleteCollection(SECTION_COLLECTION);
  }
  _collectionReady = false;
  await ensureSectionCollection(config);
}

/**
 * `target_type` marker on `memory_embeddings` rows that cache section vectors.
 * Distinct from the v2 `concept_page` rows so the two caches never collide on a
 * shared `(targetType, targetId, provider, model)` key.
 */
const V3_SECTION_TARGET_TYPE = "v3_section";

/** Human-readable cache id for a section: `<article>#<ordinal>`. */
function sectionCacheId(article: string, ordinal: number): string {
  return `${article}#${ordinal}`;
}

/**
 * Content hash a section's cached vector is keyed by. Folds the provider's
 * embedding-option extras (Gemini task type / output dimensions) into the base
 * text hash, so changing an option that alters the vector for identical text is
 * a cache miss that re-embeds. With no extras the bare text hash is returned
 * unchanged, keeping existing rows valid for non-Gemini and default-Gemini
 * configs.
 */
function sectionContentHash(text: string, extras: string[]): string {
  const base = embeddingInputContentHash({ type: "text", text });
  if (extras.length === 0) return base;
  return createHash("sha256")
    .update(`${base}\0${extras.join("\0")}`)
    .digest("hex");
}

/**
 * Embed each section's `text` and upsert one point per section, keyed by a
 * deterministic `(article, ordinal)`-derived ID. Stable IDs mean re-upserting
 * the same sections overwrites in place rather than accumulating duplicates,
 * so the operation is idempotent. Payload carries `{ article, ordinal, title }`
 * for downstream filtering and rendering.
 *
 * Unchanged sections are served from the `memory_embeddings` cache rather than
 * re-embedded — see {@link embedSectionsCached} — so a maintain pass that
 * re-selects an already-embedded page makes no backend round-trip for it.
 *
 * An empty `sections` array is a no-op (no embedding round-trip).
 */
export async function upsertSections(
  config: AssistantConfig,
  sections: Section[],
): Promise<void> {
  if (sections.length === 0) return;

  await ensureSectionCollection(config);

  const vectors = await embedSectionsCached(config, sections);

  const points = sections.flatMap((section, i) => {
    const vector = vectors[i];
    if (!vector) return [];
    return [
      {
        id: pointIdForSection(section.article, section.ordinal),
        vector,
        payload: {
          article: section.article,
          ordinal: section.ordinal,
          title: section.title,
        },
      },
    ];
  });

  if (points.length === 0) return;

  await getSectionDenseClient().upsert(SECTION_COLLECTION, {
    wait: true,
    points,
  });
}

/**
 * Resolve a dense vector per section, reusing cached vectors for sections whose
 * `text` is unchanged and embedding only the misses in a single batched backend
 * call. Returns one entry per input section, index-aligned; a position is left
 * `undefined` only when a fresh embed produced no vector for it.
 *
 * The cache lives in the shared `memory_embeddings` table keyed on
 * `(targetType="v3_section", targetId="<article>#<ordinal>", provider, model)`.
 * It survives the `deleteSectionsForArticle` callers run before upserting (that
 * delete clears only Qdrant points), so an unchanged section rebuilds its point
 * from the cache without a backend round-trip. Vectors are stored and upserted
 * raw — the section dense lane applies no anisotropy correction, so the cached
 * vector equals the upserted one.
 */
async function embedSectionsCached(
  config: AssistantConfig,
  sections: Section[],
): Promise<Array<number[] | undefined>> {
  const expectedDim = config.memory.qdrant.vectorSize;

  // Cache identity: read rows under the currently-selected provider/model. When
  // no provider resolves (backend down/disabled) skip the cache and let the
  // batched embed below surface the failure exactly as the uncached path did.
  const status = await getMemoryBackendStatus(config);
  const db = getDb();

  // Only Gemini's options change the vector for identical text, so fold the
  // extras into the cache identity only when Gemini is the resolved provider;
  // other backends keep the bare text hash. See {@link sectionContentHash}.
  const extras = status.provider === "gemini" ? geminiCacheExtras(config) : [];
  const hashes = sections.map((s) => sectionContentHash(s.text, extras));

  const result: Array<number[] | undefined> = new Array(sections.length);
  const missIndices: number[] = [];
  if (status.provider && status.model) {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      const cached = readEmbeddingCache(db, {
        targetType: V3_SECTION_TARGET_TYPE,
        targetId: sectionCacheId(section.article, section.ordinal),
        provider: status.provider,
        model: status.model,
        expectedDim,
      });
      if (cached && cached.contentHash === hashes[i]) {
        result[i] = cached.dense;
      } else {
        missIndices.push(i);
      }
    }
  } else {
    for (let i = 0; i < sections.length; i++) missIndices.push(i);
  }

  if (missIndices.length === 0) return result;

  // Embed the misses in one batched call (the dominant cost).
  let embedded = await embedWithBackend(
    missIndices.map((i) => sections[i]!.text),
  );
  let writeProvider = embedded.provider;
  let writeModel = embedded.model;
  let effectiveIndices = missIndices;

  // A provider/model rotation between the cache read and the embed would mix two
  // embedding spaces in one collection: cached hits carry the old identity, the
  // fresh misses the new. Re-embed every section under the new identity so the
  // whole batch (and the cache rows it writes) shares one space.
  const hadHits = missIndices.length < sections.length;
  const rotated =
    hadHits &&
    (embedded.provider !== status.provider || embedded.model !== status.model);
  if (rotated) {
    effectiveIndices = sections.map((_, i) => i);
    embedded = await embedWithBackend(sections.map((s) => s.text));
    writeProvider = embedded.provider;
    writeModel = embedded.model;
  }

  const now = Date.now();
  for (let j = 0; j < effectiveIndices.length; j++) {
    const i = effectiveIndices[j]!;
    const vector = embedded.vectors[j];
    if (!vector) continue;
    result[i] = vector;
    const section = sections[i]!;
    writeEmbeddingCache(db, {
      targetType: V3_SECTION_TARGET_TYPE,
      targetId: sectionCacheId(section.article, section.ordinal),
      dense: vector,
      contentHash: hashes[i]!,
      provider: writeProvider,
      model: writeModel,
      now,
    });
  }

  return result;
}

/**
 * Delete every section point belonging to an article. Used by incremental
 * rebuilds (in a later PR) to clear an article's stale sections before
 * re-upserting its current ones. Idempotent: deleting an absent article's
 * sections is a no-op server-side.
 */
export async function deleteSectionsForArticle(
  config: AssistantConfig,
  article: string,
): Promise<void> {
  await ensureSectionCollection(config);

  await getSectionDenseClient().delete(SECTION_COLLECTION, {
    wait: true,
    filter: { must: [{ key: "article", match: { value: article } }] },
  });
}

/**
 * Return every distinct `article` slug that currently has at least one section
 * point in the collection. Scrolls the whole collection (payload only, no
 * vectors) in bounded batches and collects the distinct `article` values.
 *
 * Used by the maintain job's prune stage to find articles whose points linger
 * after the page was deleted from the index — the change-delta selector never
 * names a slug that is gone, so a deleted page's stale points are only
 * observable by reading the collection back. An empty/absent collection yields
 * an empty list.
 */
export async function listSectionArticles(
  config: AssistantConfig,
): Promise<string[]> {
  await ensureSectionCollection(config);

  const client = getSectionDenseClient();
  const articles = new Set<string>();
  let offset: string | number | undefined = undefined;
  const maxIterations = 10_000;
  const batchSize = 256;
  for (let i = 0; i < maxIterations; i++) {
    const result = await client.scroll(SECTION_COLLECTION, {
      limit: batchSize,
      with_payload: true,
      with_vector: false,
      ...(offset !== undefined ? { offset } : {}),
    });
    for (const point of result.points) {
      const article = (point.payload as { article?: unknown } | null)?.article;
      if (typeof article === "string") articles.add(article);
    }
    const next = result.next_page_offset;
    if (next == null) break;
    offset = typeof next === "string" ? next : (next as number);
  }

  return [...articles];
}

/** @internal Test-only: reset module-level singletons. */
export function _resetSectionDenseStoreForTests(): void {
  _client = null;
  _collectionReady = false;
}

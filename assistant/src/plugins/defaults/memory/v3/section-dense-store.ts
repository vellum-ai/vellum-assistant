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

import { QdrantClient as QdrantRestClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";

import type { AssistantConfig } from "../../../../config/types.js";
import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../../persistence/checkpoints.js";
import {
  durableEmbeddingCacheExtras,
  getMemoryBackendStatus,
} from "../../../../persistence/embeddings/embedding-backend.js";
import {
  readEmbeddingCache,
  writeEmbeddingCache,
} from "../../../../persistence/embeddings/embedding-cache.js";
import { embeddingContentHashWithExtras } from "../../../../persistence/embeddings/embedding-types.js";
import { embedWithBackend, resolveQdrantUrl } from "../embeddings.js";
import { getLogger } from "../logging.js";
import { memoryDbOrNull } from "../memory-db.js";
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
 * Checkpoint key of the section chunker version the stored vectors were built
 * with, and the current version. Point ids derive from `(article, ordinal)`
 * and the dense lane resolves hits by ordinal against the in-memory index, so
 * a chunker change that moves chunk text or ordinals (version 2: the body
 * budget that keeps the head line on every chunk) leaves a collection built
 * by the previous chunker pointing at the wrong sections until every page is
 * re-embedded. {@link ensureSectionChunkerVersion} forces that rebuild once
 * per version change through the same high-water reset a recreated
 * collection uses.
 */
export const SECTION_CHUNKER_VERSION_KEY =
  "memory_v3_maintain:section_chunker_version";
export const SECTION_CHUNKER_VERSION = 2;

/**
 * Checkpoint key marking a rebuild that a chunker version change forced and
 * that no clean full re-embed pass has completed since: written by
 * {@link ensureSectionChunkerVersion} before it resets the high-water, so an
 * interruption between the two writes leaves the marker in place and the
 * next check finishes the transition, and cleared by
 * {@link commitSectionEmbedHighWater}. While it is set the stored points were
 * built by the previous chunker, so their ordinals can name the wrong section
 * of the current index and the dense lane serves no hits
 * ({@link sectionDenseReadsHeld}); the maintain pass it names re-embeds every
 * page and every capability row the store holds before its commit clears the
 * marker. Persisted rather than held in process state so a restart between
 * the reset and the rebuild keeps holding reads.
 */
export const SECTION_REBUILD_PENDING_KEY =
  "memory_v3_maintain:section_rebuild_pending";

/**
 * Compare the recorded chunker version with the current one before an embed
 * pass, and report whether the section store awaits a chunker rebuild. On a
 * mismatch against a store holding vectors built by another chunker (see
 * {@link sectionStoreHoldsStaleVectors}): mark the rebuild pending, then
 * clear the embed high-water (so the next maintain pass re-embeds every page
 * and prunes stale points through its usual paths), record the current
 * version, and log once. The marker is written first because it is the only
 * signal that survives the high-water reset: a crash or failed write between
 * the two leaves the hold in place and the next check finishes the
 * transition, where the reverse order would leave a store that reads as a
 * fresh install with stale points still in it. On a mismatch against an empty
 * store (a fresh install) only the version is recorded. On a match nothing is
 * written. Returns whether a rebuild is pending after the check: one this
 * call forced, or one an earlier check marked that no clean pass has
 * committed since. Called at dense lane init, by the maintain job, and by the
 * one-time backfill, whichever runs first, so the version is on record before
 * any pass commits a high-water, and retried from the dense read path while
 * a lane init's check has not completed ({@link settleSectionDenseReadHold}).
 */
export async function ensureSectionChunkerVersion(): Promise<boolean> {
  const recorded = getMemoryCheckpoint(SECTION_CHUNKER_VERSION_KEY);
  if (recorded === String(SECTION_CHUNKER_VERSION)) {
    return getMemoryCheckpoint(SECTION_REBUILD_PENDING_KEY) !== null;
  }
  const stale = await sectionStoreHoldsStaleVectors();
  if (stale) {
    setMemoryCheckpoint(SECTION_REBUILD_PENDING_KEY, "1");
    deleteMemoryCheckpoint(MAINTAIN_EMBED_HIGH_WATER_KEY);
    log.info(
      { recorded, current: SECTION_CHUNKER_VERSION },
      "memory-v3 section chunker version changed: the next maintain pass rebuilds the section dense store from every page",
    );
  }
  setMemoryCheckpoint(
    SECTION_CHUNKER_VERSION_KEY,
    String(SECTION_CHUNKER_VERSION),
  );
  return stale;
}

/**
 * Whether a store whose recorded chunker version is absent or differs from
 * the current one holds vectors built by another chunker. True when an embed
 * high-water is on record (a pass committed vectors), when a rebuild is
 * already pending (an earlier transition was interrupted before the version
 * was recorded), or, with neither on record, when the collection holds any
 * point (an install whose passes never committed cleanly). An empty
 * collection is a fresh install with nothing to rebuild. The collection probe
 * throws when Qdrant is unreachable, so the check completes only once the
 * store can be read.
 */
async function sectionStoreHoldsStaleVectors(): Promise<boolean> {
  if (getMemoryCheckpoint(MAINTAIN_EMBED_HIGH_WATER_KEY) !== null) {
    return true;
  }
  if (getMemoryCheckpoint(SECTION_REBUILD_PENDING_KEY) !== null) {
    return true;
  }
  const result = await getSectionDenseClient().scroll(SECTION_COLLECTION, {
    limit: 1,
    with_payload: false,
    with_vector: false,
  });
  return result.points.length > 0;
}

/**
 * Why this process holds dense reads: `rebuild` while the durable marker
 * says the store awaits a chunker rebuild; `indeterminate` while the version
 * check has not completed (its last run threw: a collection probe against an
 * unreachable Qdrant, a checkpoint the ledger could not serve), so whether
 * the stored ordinals are safe is unknown; `open` when nothing holds them.
 */
type SectionDenseReadHold = "open" | "rebuild" | "indeterminate";

let _hold: SectionDenseReadHold = "open";

/** Epoch ms of the version check whose failure last left the hold
 *  indeterminate; the retry waits {@link SECTION_VERSION_CHECK_RETRY_MS}
 *  from it. */
let _checkFailedAt = 0;

/** The retried check in flight, shared by the dense reads that overlap it. */
let _retry: Promise<boolean> | null = null;

/** Registered at lane init: kicks the rebuild pass when a check first
 *  reports a rebuild pending in this process. */
let _onRebuildPending: (() => void) | undefined;

/**
 * How long after a failed version check the dense read path waits before
 * retrying it, so an outage draws one collection probe a minute rather than
 * one per read.
 */
const SECTION_VERSION_CHECK_RETRY_MS = 60_000;

/**
 * Hold dense reads while the section store awaits its chunker rebuild, or
 * while whether it does cannot be determined. Run at dense lane init, before
 * the lanes are handed out: compares the chunker version on record
 * ({@link ensureSectionChunkerVersion}, which marks the rebuild pending and
 * resets the high-water on a mismatch, and reports a marker an earlier check
 * left), so a restart between a reset and the rebuild resumes the hold. A
 * check that reports a rebuild pending holds reads until the rebuild's
 * commit and calls `onRebuildPending`, the caller's cue to kick the rebuild
 * pass. A check that throws holds reads as indeterminate: nothing on record
 * proves the stored ordinals safe (the failed probe may be the one that
 * would have found them stale), so the dense read path retries the check
 * ({@link settleSectionDenseReadHold}) until one completes, and a retried
 * check that reports the rebuild calls `onRebuildPending` the same way.
 * Returns whether this call started a hold; a hold already in place, or none
 * needed, returns false.
 */
export async function holdSectionDenseReadsUntilRebuilt(
  onRebuildPending?: () => void,
): Promise<boolean> {
  if (_hold !== "open") {
    return false;
  }
  _onRebuildPending = onRebuildPending;
  return applySectionChunkerVersionCheck();
}

/**
 * Run the version check and move the hold to what it reports: `rebuild`
 * (kicking the rebuild pass) when one is pending, `indeterminate` when the
 * check throws, `open` when nothing is pending. Returns whether reads are
 * held afterwards.
 */
async function applySectionChunkerVersionCheck(): Promise<boolean> {
  let pending: boolean;
  try {
    pending = await ensureSectionChunkerVersion();
  } catch (err) {
    _hold = "indeterminate";
    _checkFailedAt = Date.now();
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        retryAfterMs: SECTION_VERSION_CHECK_RETRY_MS,
      },
      "memory-v3 section chunker version check failed; dense reads held until a retried check completes",
    );
    return true;
  }
  if (!pending) {
    releaseSectionDenseReadHold();
    return false;
  }
  _hold = "rebuild";
  log.warn(
    { current: SECTION_CHUNKER_VERSION },
    "memory-v3 section store awaits its chunker rebuild: the dense lane serves no hits until the rebuild pass completes",
  );
  _onRebuildPending?.();
  return true;
}

/**
 * Whether the dense lane must serve no hits, the fast path of every dense
 * read. A hold for a rebuild on record re-reads the durable marker, so the
 * read that finds it cleared (the rebuild completed in another process)
 * releases the hold, and a marker that cannot be read keeps holding. An
 * indeterminate hold stays until a retried check completes
 * ({@link settleSectionDenseReadHold}), never on the marker's absence, which
 * is exactly what the failed check left unproven.
 */
export function sectionDenseReadsHeld(): boolean {
  if (_hold === "open") {
    return false;
  }
  if (_hold === "indeterminate") {
    return true;
  }
  try {
    if (getMemoryCheckpoint(SECTION_REBUILD_PENDING_KEY) !== null) {
      return true;
    }
  } catch {
    return true;
  }
  releaseSectionDenseReadHold();
  return false;
}

/**
 * The slow path behind {@link sectionDenseReadsHeld}, for a dense read that
 * found reads held: an indeterminate hold whose retry cooldown has elapsed
 * runs the version check again (one check at a time, shared by the reads
 * that overlap it), and the check that completes moves the hold to the
 * rebuild it reports or releases it. Resolves to whether reads are still
 * held.
 */
export async function settleSectionDenseReadHold(): Promise<boolean> {
  if (_hold !== "indeterminate") {
    return sectionDenseReadsHeld();
  }
  if (Date.now() - _checkFailedAt < SECTION_VERSION_CHECK_RETRY_MS) {
    return true;
  }
  if (!_retry) {
    _retry = applySectionChunkerVersionCheck().finally(() => {
      _retry = null;
    });
  }
  return _retry;
}

function releaseSectionDenseReadHold(): void {
  if (_hold === "open") {
    return;
  }
  const released = _hold;
  _hold = "open";
  log.info(
    released === "rebuild"
      ? "memory-v3 section store rebuilt for the current chunker: dense reads resume"
      : "memory-v3 section chunker version check completed with no rebuild pending: dense reads resume",
  );
}

/**
 * Record the epoch-ms high-water of a re-embed pass that completed with zero
 * failures, the point from which the maintain job and the backfill advance
 * the mark. A pass that started with the mark absent, which is what a forced
 * chunker rebuild leaves behind, re-embedded every page (and, with the
 * rebuild marked pending, every capability row the store held), so the same
 * commit clears the pending marker and releases this process's read hold.
 */
export function commitSectionEmbedHighWater(highWaterMs: number): void {
  setMemoryCheckpoint(MAINTAIN_EMBED_HIGH_WATER_KEY, String(highWaterMs));
  deleteMemoryCheckpoint(SECTION_REBUILD_PENDING_KEY);
  releaseSectionDenseReadHold();
}

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
  if (_client) {
    return _client;
  }
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
  if (_collectionReady) {
    return;
  }

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
      if (status !== 409) {
        throw err;
      }
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
  if (sections.length === 0) {
    return;
  }

  await ensureSectionCollection(config);

  const vectors = await embedSectionsCached(config, sections);

  const points = sections.flatMap((section, i) => {
    const vector = vectors[i];
    if (!vector) {
      return [];
    }
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

  if (points.length === 0) {
    return;
  }

  await getSectionDenseClient().upsert(SECTION_COLLECTION, {
    wait: true,
    points,
  });
}

/**
 * Sections per backend call when warming the cache: the vectors of one call
 * are held in memory until its cache rows are written, so this bounds that
 * footprint (a few megabytes at 3,072 dimensions) while a call still spans
 * many pages.
 */
export const WARM_SECTIONS_PER_CALL = 200;

/**
 * Warm the `memory_embeddings` cache for `sections` across pages, in backend
 * calls of at most {@link WARM_SECTIONS_PER_CALL} sections (every miss in a
 * call embeds in one batched request), so the per-page `upsertSections` calls
 * that follow serve from the cache and make no backend round trip. Without
 * the warm-up a corpus rebuild pays one backend call per page. The vectors
 * are not returned: the cache rows are the product, keyed exactly as the
 * per-page path keys them, and each call's vectors are released once its rows
 * are written. An empty `sections` array is a no-op.
 */
export async function warmSectionEmbeddings(
  config: AssistantConfig,
  sections: Section[],
): Promise<void> {
  for (let i = 0; i < sections.length; i += WARM_SECTIONS_PER_CALL) {
    await embedSectionsCached(
      config,
      sections.slice(i, i + WARM_SECTIONS_PER_CALL),
    );
  }
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
  const mem = memoryDbOrNull("embedSectionsCached");

  // Fold provider extras that change the vector for identical text (Gemini
  // task type / dimensions, custom endpoint URL / dimensions) into the
  // durable cache identity. Other backends keep the bare text hash.
  const extras = durableEmbeddingCacheExtras(config, status.provider);
  const hashes = sections.map((s) =>
    embeddingContentHashWithExtras({ type: "text", text: s.text }, extras),
  );

  const result: Array<number[] | undefined> = new Array(sections.length);
  const missIndices: number[] = [];
  if (mem && status.provider && status.model) {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      const cached = readEmbeddingCache(mem, {
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
    for (let i = 0; i < sections.length; i++) {
      missIndices.push(i);
    }
  }

  if (missIndices.length === 0) {
    return result;
  }

  // Embed the misses in one batched call (the dominant cost).
  let embedded = await embedWithBackend(
    config,
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
    embedded = await embedWithBackend(
      config,
      sections.map((s) => s.text),
    );
    writeProvider = embedded.provider;
    writeModel = embedded.model;
  }

  const now = Date.now();
  for (let j = 0; j < effectiveIndices.length; j++) {
    const i = effectiveIndices[j]!;
    const vector = embedded.vectors[j];
    if (!vector) {
      continue;
    }
    result[i] = vector;
    const section = sections[i]!;
    if (mem) {
      writeEmbeddingCache(mem, {
        targetType: V3_SECTION_TARGET_TYPE,
        targetId: sectionCacheId(section.article, section.ordinal),
        dense: vector,
        contentHash: hashes[i]!,
        provider: writeProvider,
        model: writeModel,
        now,
      });
    }
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
      if (typeof article === "string") {
        articles.add(article);
      }
    }
    const next = result.next_page_offset;
    if (next == null) {
      break;
    }
    offset = typeof next === "string" ? next : (next as number);
  }

  return [...articles];
}

/** @internal Test-only: reset module-level singletons. */
export function _resetSectionDenseStoreForTests(): void {
  _client = null;
  _collectionReady = false;
  _hold = "open";
  _checkFailedAt = 0;
  _retry = null;
  _onRebuildPending = undefined;
}

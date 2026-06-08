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

import type { AssistantConfig } from "../../../config/types.js";
import { embedWithBackend } from "../../../memory/embedding-backend.js";
import { resolveQdrantUrl } from "../../../memory/qdrant-client.js";
import { getLogger } from "../../../util/logger.js";
import type { Section } from "./types.js";

const log = getLogger("memory-v3-section-dense-store");

/** Name of the dedicated Qdrant collection holding section-grain embeddings. */
export const SECTION_COLLECTION = "memory_v3_sections";

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
export function getSectionDenseClient(
  config: AssistantConfig,
): QdrantRestClient {
  if (_client) return _client;
  _client = new QdrantRestClient({
    url: resolveQdrantUrl(config),
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

  const client = getSectionDenseClient(config);
  const vectorSize = config.memory.qdrant.vectorSize;
  const onDisk = config.memory.qdrant.onDisk;

  const exists = await client.collectionExists(SECTION_COLLECTION);
  if (exists.exists) {
    _collectionReady = true;
    return;
  }

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

  // Index the `article` payload so `deleteSectionsForArticle` can filter on it
  // under strict-mode Qdrant (which rejects filters on unindexed fields).
  await client.createPayloadIndex(SECTION_COLLECTION, {
    field_name: "article",
    field_schema: "keyword",
  });

  _collectionReady = true;
}

/**
 * Embed each section's `text` and upsert one point per section, keyed by a
 * deterministic `(article, ordinal)`-derived ID. Stable IDs mean re-upserting
 * the same sections overwrites in place rather than accumulating duplicates,
 * so the operation is idempotent. Payload carries `{ article, ordinal, title }`
 * for downstream filtering and rendering.
 *
 * An empty `sections` array is a no-op (no embedding round-trip).
 */
export async function upsertSections(
  config: AssistantConfig,
  sections: Section[],
): Promise<void> {
  if (sections.length === 0) return;

  await ensureSectionCollection(config);

  const { vectors } = await embedWithBackend(
    config,
    sections.map((s) => s.text),
  );

  const points = sections.map((section, i) => ({
    id: pointIdForSection(section.article, section.ordinal),
    vector: vectors[i]!,
    payload: {
      article: section.article,
      ordinal: section.ordinal,
      title: section.title,
    },
  }));

  await getSectionDenseClient(config).upsert(SECTION_COLLECTION, {
    wait: true,
    points,
  });
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

  await getSectionDenseClient(config).delete(SECTION_COLLECTION, {
    wait: true,
    filter: { must: [{ key: "article", match: { value: article } }] },
  });
}

/** @internal Test-only: reset module-level singletons. */
export function _resetSectionDenseStoreForTests(): void {
  _client = null;
  _collectionReady = false;
}

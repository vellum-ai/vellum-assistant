// ---------------------------------------------------------------------------
// Plugin embeddings — compute-only primitives (Layer 1) and a plugin-owned
// semantic index (Layer 2).
// ---------------------------------------------------------------------------
//
// These are the host-side implementations behind the `@vellumai/plugin-api`
// embeddings facade. They take the live workspace `config` and the calling
// plugin's manifest name explicitly; the thin facade in `plugin-facade.ts`
// injects both (`getConfig()` and `getCurrentPluginName()`) so plugins hold no
// config and cannot spoof another plugin's namespace.
//
// Layer 1 (compute-only): embed / generateSparseEmbedding — run the workspace
// embedding backend and hand the raw vectors back with no persistence.
//
// Layer 2 (plugin index): index / query / get / remove a document in a
// plugin-scoped Qdrant namespace. Points are written into the shared host
// collection (the same one `embedAndUpsert` already uses) under a dedicated
// `plugin_index` target_type and tagged with the owning plugin's name. No
// recall lane queries `plugin_index`, so this index never participates in
// agent recall — it is search *inside the plugin* only.

import { randomUUID } from "node:crypto";

import type { AssistantConfig } from "../../config/types.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { embedWithRetry } from "./embed.js";
import {
  generateSparseEmbedding,
  getMemoryBackendStatus,
} from "./embedding-backend.js";
import {
  type EmbeddingInput,
  normalizeEmbeddingInput,
  type SparseEmbedding,
} from "./embedding-types.js";
import { withQdrantBreaker } from "./qdrant-circuit-breaker.js";
import { getQdrantClient } from "./qdrant-client.js";

const log = getLogger("plugin-index");

/** Qdrant target_type reserved for plugin-owned index documents. */
const PLUGIN_INDEX_TARGET_TYPE = "plugin_index" as const;

// ── Result / option shapes (re-exported to plugins via the facade) ─────────

/** A computed embedding with the provider/model that produced it. */
export interface PluginEmbedding {
  vector: number[];
  provider: string;
  model: string;
  dimensions: number;
}

export interface IndexPluginDocumentOptions {
  /**
   * Reuse a caller-owned id to upsert a document in place (the update path:
   * same id → overwrite). Omit to have the host mint a fresh document id.
   */
  documentId?: string;
  /**
   * Opaque provenance carried with the document (e.g. `{ rowId, fileId }`).
   * Round-tripped verbatim on query/get; never interpreted by the host.
   */
  metadata?: Record<string, unknown>;
  /** Override the stored creation timestamp (defaults to now). */
  createdAt?: number;
}

export interface PluginIndexDocumentResult {
  documentId: string;
  provider: string;
  model: string;
  dimensions: number;
}

export interface QueryPluginIndexOptions {
  /** Max hits to return. Defaults to 10. */
  limit?: number;
  /** Per-branch prefetch depth for the hybrid fusion. */
  prefetchLimit?: number;
}

export interface PluginIndexHit {
  documentId: string;
  score: number;
  text: string;
  modality: "text" | "image" | "audio" | "video";
  metadata?: Record<string, unknown>;
}

export interface PluginDocument {
  documentId: string;
  text: string;
  modality: "text" | "image" | "audio" | "video";
  metadata?: Record<string, unknown>;
  createdAt: number;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** The initialized Qdrant client, as a retryable unavailability if it is not up. */
function requireQdrant(): ReturnType<typeof getQdrantClient> {
  try {
    return getQdrantClient();
  } catch {
    throw new BackendUnavailableError("Qdrant client not initialized");
  }
}

/** Embed a single input to a dense vector, failing loudly if no backend is up. */
async function embedDense(
  config: AssistantConfig,
  input: EmbeddingInput,
): Promise<PluginEmbedding> {
  const status = await getMemoryBackendStatus(config);
  if (!status.provider) {
    throw new BackendUnavailableError(
      `Embedding backend unavailable (${status.reason ?? "no provider"})`,
    );
  }
  const embedded = await embedWithRetry(config, [input]);
  const vector = embedded.vectors[0];
  if (!vector) {
    throw new BackendUnavailableError("Embedding backend returned no vector");
  }
  return {
    vector,
    provider: embedded.provider,
    model: embedded.model,
    dimensions: vector.length,
  };
}

/** Text projection stored on a point's payload (raw text or a media marker). */
function payloadTextFor(input: EmbeddingInput): string {
  const normalized = normalizeEmbeddingInput(input);
  return normalized.type === "text"
    ? normalized.text
    : `[${normalized.type}:${normalized.mimeType}]`;
}

/** Sparse vector for the text side of an input, or undefined for media. */
function sparseFor(input: EmbeddingInput): SparseEmbedding | undefined {
  const normalized = normalizeEmbeddingInput(input);
  return normalized.type === "text"
    ? generateSparseEmbedding(normalized.text)
    : undefined;
}

// ── Layer 1: compute-only ──────────────────────────────────────────────────

/** Embed an input and return the raw dense vector — no persistence. */
export async function computePluginEmbedding(
  config: AssistantConfig,
  input: EmbeddingInput,
): Promise<PluginEmbedding> {
  return embedDense(config, input);
}

/**
 * Generate the sparse (lexical) vector for a text, using the same encoder the
 * host uses for hybrid search. Pure/local — no backend call, no persistence.
 */
export function computePluginSparseEmbedding(text: string): SparseEmbedding {
  return generateSparseEmbedding(text);
}

// ── Layer 2: plugin-owned index ────────────────────────────────────────────

/**
 * Embed a document and upsert it into the calling plugin's private index.
 * Returns the document id (minted here unless `opts.documentId` is supplied).
 */
export async function indexPluginDocument(
  config: AssistantConfig,
  plugin: string,
  input: EmbeddingInput,
  opts?: IndexPluginDocumentOptions,
): Promise<PluginIndexDocumentResult> {
  const embedding = await embedDense(config, input);
  const sparseVector = sparseFor(input);
  const normalized = normalizeEmbeddingInput(input);
  const documentId = opts?.documentId ?? randomUUID();
  const now = opts?.createdAt ?? Date.now();
  const qdrant = requireQdrant();

  await withQdrantBreaker(() =>
    qdrant.upsert(
      PLUGIN_INDEX_TARGET_TYPE,
      documentId,
      embedding.vector,
      {
        text: payloadTextFor(input),
        modality: normalized.type,
        created_at: now,
        plugin,
        ...(opts?.metadata !== undefined ? { meta: opts.metadata } : {}),
      },
      sparseVector,
    ),
  );

  return {
    documentId,
    provider: embedding.provider,
    model: embedding.model,
    dimensions: embedding.dimensions,
  };
}

/**
 * Hybrid (dense + sparse) search over the calling plugin's index only. Falls
 * back to dense-only when the query carries no lexical tokens (e.g. a media
 * query or an all-stopword string).
 */
export async function queryPluginIndex(
  config: AssistantConfig,
  plugin: string,
  query: EmbeddingInput,
  opts?: QueryPluginIndexOptions,
): Promise<PluginIndexHit[]> {
  const embedding = await embedDense(config, query);
  const sparseVector = sparseFor(query);
  const limit = opts?.limit ?? 10;
  const qdrant = requireQdrant();

  const filter = {
    must: [
      { key: "target_type", match: { value: PLUGIN_INDEX_TARGET_TYPE } },
      { key: "plugin", match: { value: plugin } },
    ],
    must_not: [{ key: "_meta", match: { value: true } }],
  };

  const results =
    sparseVector && sparseVector.indices.length > 0
      ? await withQdrantBreaker(() =>
          qdrant.hybridSearch({
            denseVector: embedding.vector,
            sparseVector,
            filter,
            limit,
            prefetchLimit: opts?.prefetchLimit,
          }),
        )
      : await withQdrantBreaker(() =>
          qdrant.search(embedding.vector, limit, filter),
        );

  return results.map((r) => ({
    documentId: r.payload.target_id,
    score: r.score,
    text: r.payload.text,
    modality: r.payload.modality ?? "text",
    metadata: r.payload.meta,
  }));
}

/** Fetch a single document from the calling plugin's index, or null. */
export async function getPluginDocument(
  plugin: string,
  documentId: string,
): Promise<PluginDocument | null> {
  const qdrant = requireQdrant();
  const found = await withQdrantBreaker(() =>
    qdrant.getByTarget(PLUGIN_INDEX_TARGET_TYPE, documentId, { plugin }),
  );
  if (!found) {
    return null;
  }
  return {
    documentId,
    text: found.payload.text,
    modality: found.payload.modality ?? "text",
    metadata: found.payload.meta,
    createdAt: found.payload.created_at,
  };
}

/** Remove a single document from the calling plugin's index. */
export async function removePluginDocument(
  plugin: string,
  documentId: string,
): Promise<void> {
  const qdrant = requireQdrant();
  await withQdrantBreaker(() =>
    qdrant.deleteByTargetAndPlugin(
      PLUGIN_INDEX_TARGET_TYPE,
      documentId,
      plugin,
    ),
  );
}

/**
 * Delete every embedding a plugin owns — its whole index namespace. Meant for
 * plugin uninstall so no vectors outlive the plugin directory. Best-effort:
 * logs and swallows so a purge failure never blocks teardown.
 */
export async function purgePluginEmbeddings(plugin: string): Promise<void> {
  try {
    const qdrant = requireQdrant();
    await withQdrantBreaker(() => qdrant.deleteByPlugin(plugin));
  } catch (err) {
    log.warn({ err, plugin }, "Failed to purge plugin embeddings");
  }
}

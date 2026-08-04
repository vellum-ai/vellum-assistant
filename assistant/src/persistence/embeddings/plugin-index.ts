// ---------------------------------------------------------------------------
// Plugin embeddings: compute-only primitives and a plugin-owned semantic index.
// ---------------------------------------------------------------------------
//
// Host-side implementations behind the `@vellumai/plugin-api` embeddings
// facade. They take the live workspace `config` and the calling plugin's
// manifest name explicitly; the thin facade in `plugin-facade.ts` injects both
// (`getConfig()` and `getCurrentPluginName()`) so plugins hold no config and
// cannot spoof another plugin's namespace.
//
// Compute-only: embed / generateSparseEmbedding run the workspace embedding
// backend and hand the raw vectors back with no persistence.
//
// Index: index / query / get / remove a document in a plugin-scoped Qdrant
// namespace. Points are written into the shared host collection (the same one
// `embedAndUpsert` uses) under a dedicated `plugin_index` target_type, tagged
// with the owning plugin's name, and keyed by a namespace-qualified point id so
// two plugins that pick the same documentId never collide. No recall lane
// queries `plugin_index`, so this index never participates in agent recall: it
// is search inside the plugin only.
//
// Durability: the index is a derived cache of the plugin's own source data. Its
// vectors are tied to the workspace embedding model; when that model (or its
// dimension) changes, the shared collection is rebuilt and these vectors are
// dropped along with the host's, since a dimension change invalidates every
// stored vector. Plugins own their source rows (per plugin self-containment)
// and re-index after such a change. Nothing plugin-owned is persisted in the
// main database.

import { randomUUID } from "node:crypto";

import { getConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { embedWithRetry } from "./embed.js";
import {
  generateSparseEmbedding,
  getMemoryBackendStatus,
  selectEmbeddingBackend,
} from "./embedding-backend.js";
import {
  type EmbeddingInput,
  normalizeEmbeddingInput,
  type SparseEmbedding,
} from "./embedding-types.js";
import { withQdrantBreaker } from "./qdrant-circuit-breaker.js";
import {
  getQdrantClient,
  initQdrantClient,
  resolveQdrantUrl,
  type VellumQdrantClient,
} from "./qdrant-client.js";

const log = getLogger("plugin-index");

/** Qdrant target_type reserved for plugin-owned index documents. */
const PLUGIN_INDEX_TARGET_TYPE = "plugin_index" as const;

/**
 * Namespace-qualified Qdrant point id for a plugin document. `VellumQdrantClient`
 * dedupes points by (target_type, target_id), so the plugin name must be part of
 * the target_id: otherwise two plugins that pick the same documentId would map
 * to one point and clobber each other. Plugin manifest names are kebab-case and
 * cannot contain ":", so the first ":" always splits the namespace from the id.
 */
function pointTargetId(plugin: string, documentId: string): string {
  return `${plugin}:${documentId}`;
}

/** Recover the plugin-facing documentId from a namespace-qualified point id. */
function documentIdFromPoint(plugin: string, targetId: string): string {
  const prefix = `${plugin}:`;
  return targetId.startsWith(prefix) ? targetId.slice(prefix.length) : targetId;
}

// ── Result / option shapes (re-exported to plugins via the facade) ─────────

/** A computed embedding with the provider/model that produced it. */
export interface EmbedResult {
  vector: number[];
  provider: string;
  model: string;
  dimensions: number;
}

export interface IndexDocumentOptions {
  /**
   * Reuse a caller-owned id to upsert a document in place (the update path:
   * same id, overwrite). Omit to have the host mint a fresh document id.
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

export interface IndexDocumentResult {
  documentId: string;
  provider: string;
  model: string;
  dimensions: number;
}

export interface QueryIndexOptions {
  /** Max hits to return. Defaults to 10. */
  limit?: number;
  /** Per-branch prefetch depth for the hybrid fusion. */
  prefetchLimit?: number;
}

export interface IndexHit {
  documentId: string;
  score: number;
  text: string;
  modality: "text" | "image" | "audio" | "video";
  metadata?: Record<string, unknown>;
}

export interface IndexedDocument {
  documentId: string;
  text: string;
  modality: "text" | "image" | "audio" | "video";
  metadata?: Record<string, unknown>;
  createdAt: number;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Config fingerprint of the client {@link resolveQdrant} last built, so a live
 * config change is not served by a stale client. `VellumQdrantClient` captures
 * its collection, dimension, and model identity at construction, so a client
 * built before the change would keep writing at the old dimension (rejected by
 * a resized collection) or quietly mix vectors from two models into one
 * collection without triggering the sentinel migration.
 */
let clientConfigIdentity: string | null = null;

/**
 * The Qdrant client for the shared collection, initializing it from the live
 * workspace config when this process has not.
 *
 * The eager `initQdrantClient` in `runMemoryStartup`
 * (`plugins/defaults/memory/startup.ts`) cannot be relied on here: it runs in
 * the daemon process only, and only while memory v1 is the live tier — on a
 * default workspace (`memory.v2.enabled`, or `memory.v3.live`) it is skipped
 * entirely, because no v1 lane reads or writes the collection in that state.
 * The plugin index is not a memory tier: it is plugin-owned search that must
 * work on every tier and in any process that runs plugin code, so it resolves
 * the client itself rather than depending on a memory-tier decision. Mirrors
 * `resolveLexicalIndex` in `persistence/job-handlers/message-lexical.ts`.
 *
 * Cheap: `initQdrantClient` only constructs a client — the collection is
 * created lazily inside each operation — and the steady-state path is a
 * fingerprint comparison, with the embedding-backend lookup reached only when
 * the config it derives from has actually changed.
 *
 * The dense embedding identity is passed through so a collection created or
 * reused from here keeps the same model-sentinel semantics as the v1 path: a
 * model or dimension change recreates the collection, which is the durability
 * contract documented at the top of this file.
 */
async function resolveQdrant(): Promise<VellumQdrantClient> {
  const config = getConfig();
  const url = resolveQdrantUrl(config);
  const { collection, vectorSize, onDisk, quantization } = config.memory.qdrant;
  // `memory.embeddings` rather than the resolved backend: it is what the
  // resolution below reads, and comparing it keeps that lookup off the hot
  // path. Over-sensitive by a field or two (a `required` flip re-inits), which
  // costs one redundant construction and never a wrong client.
  const identity = JSON.stringify([
    url,
    collection,
    vectorSize,
    onDisk,
    quantization,
    config.memory.embeddings,
  ]);

  if (identity === clientConfigIdentity) {
    try {
      return getQdrantClient();
    } catch {
      // Fingerprint outlived the singleton (another module reset it) — rebuild.
    }
  }

  const selection = await selectEmbeddingBackend(config);
  const client = initQdrantClient({
    url,
    collection,
    vectorSize,
    onDisk,
    quantization,
    embeddingModel: selection.backend
      ? `${selection.backend.provider}:${selection.backend.model}`
      : undefined,
  });
  clientConfigIdentity = identity;
  return client;
}

/** Embed a single input to a dense vector, failing loudly if no backend is up. */
async function embedDense(
  config: AssistantConfig,
  input: EmbeddingInput,
): Promise<EmbedResult> {
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

// ── Compute-only ────────────────────────────────────────────────────────────

/** Embed an input and return the raw dense vector, with no persistence. */
export async function computeEmbedding(
  config: AssistantConfig,
  input: EmbeddingInput,
): Promise<EmbedResult> {
  return embedDense(config, input);
}

/**
 * Generate the sparse (lexical) vector for a text, using the same encoder the
 * host uses for hybrid search. Pure and local: no backend call, no persistence.
 */
export function computeSparseEmbedding(text: string): SparseEmbedding {
  return generateSparseEmbedding(text);
}

// ── Plugin-owned index ───────────────────────────────────────────────────────

/**
 * Embed a document and upsert it into the given plugin's private index.
 * Returns the document id (minted here unless `opts.documentId` is supplied).
 */
export async function indexDocument(
  config: AssistantConfig,
  plugin: string,
  input: EmbeddingInput,
  opts?: IndexDocumentOptions,
): Promise<IndexDocumentResult> {
  const embedding = await embedDense(config, input);
  const sparseVector = sparseFor(input);
  const normalized = normalizeEmbeddingInput(input);
  const documentId = opts?.documentId ?? randomUUID();
  const now = opts?.createdAt ?? Date.now();
  const qdrant = await resolveQdrant();

  await withQdrantBreaker(() =>
    qdrant.upsert(
      PLUGIN_INDEX_TARGET_TYPE,
      pointTargetId(plugin, documentId),
      embedding.vector,
      {
        text: payloadTextFor(input),
        modality: normalized.type,
        created_at: now,
        plugin,
        document_id: documentId,
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
 * Hybrid (dense + sparse) search over the given plugin's index only. Falls back
 * to dense-only when the query carries no lexical tokens (e.g. a media query or
 * an all-stopword string).
 */
export async function queryIndex(
  config: AssistantConfig,
  plugin: string,
  query: EmbeddingInput,
  opts?: QueryIndexOptions,
): Promise<IndexHit[]> {
  const embedding = await embedDense(config, query);
  const sparseVector = sparseFor(query);
  const limit = opts?.limit ?? 10;
  const qdrant = await resolveQdrant();

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
    documentId:
      (r.payload.document_id as string | undefined) ??
      documentIdFromPoint(plugin, r.payload.target_id),
    score: r.score,
    text: r.payload.text,
    modality: r.payload.modality ?? "text",
    metadata: r.payload.meta,
  }));
}

/** Fetch a single document from the given plugin's index, or null. */
export async function getDocument(
  plugin: string,
  documentId: string,
): Promise<IndexedDocument | null> {
  const qdrant = await resolveQdrant();
  const found = await withQdrantBreaker(() =>
    qdrant.getByTarget(
      PLUGIN_INDEX_TARGET_TYPE,
      pointTargetId(plugin, documentId),
      { plugin },
    ),
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

/** Remove a single document from the given plugin's index. */
export async function removeDocument(
  plugin: string,
  documentId: string,
): Promise<void> {
  const qdrant = await resolveQdrant();
  await withQdrantBreaker(() =>
    qdrant.deleteByTargetAndPlugin(
      PLUGIN_INDEX_TARGET_TYPE,
      pointTargetId(plugin, documentId),
      plugin,
    ),
  );
}

/**
 * Delete every embedding a plugin owns, its whole index namespace. Host-only:
 * meant for plugin uninstall so no vectors outlive the plugin directory. Not
 * exposed on the plugin API, since one plugin must never purge another's data.
 * Best-effort: logs and swallows so a purge failure never blocks teardown.
 */
export async function purgeEmbeddingsForPlugin(plugin: string): Promise<void> {
  try {
    const qdrant = await resolveQdrant();
    await withQdrantBreaker(() => qdrant.deleteByPlugin(plugin));
  } catch (err) {
    log.warn({ err, plugin }, "Failed to purge plugin embeddings");
  }
}

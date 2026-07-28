import { getConfig } from "../../config/loader.js";
import { getCurrentPluginName } from "../../plugins/plugin-execution-context.js";
import type { EmbeddingInput, SparseEmbedding } from "./embedding-types.js";
import type {
  IndexPluginDocumentOptions,
  PluginDocument,
  PluginEmbedding,
  PluginIndexDocumentResult,
  PluginIndexHit,
  QueryPluginIndexOptions,
} from "./plugin-index.js";

/**
 * Plugin-facing facade over the embeddings subsystem: self-contained
 * operations that resolve the live workspace config internally, so callers
 * (plugins importing via `@vellumai/plugin-api`) hold no host config.
 *
 * The operations are loaded via dynamic `import()` inside each wrapper so
 * that importing this module — which every `@vellumai/plugin-api` consumer
 * does transitively — does not eagerly pull the embed/vector import graph
 * (`job-utils`, `embedding-backend`). An eager pull would force those
 * modules' named exports to resolve at instantiation, which breaks the
 * intentional partial module mocks in tests.
 */

export type {
  IndexPluginDocumentOptions,
  PluginDocument,
  PluginEmbedding,
  PluginIndexDocumentResult,
  PluginIndexHit,
  QueryPluginIndexOptions,
} from "./plugin-index.js";

type EmbeddingTargetType = Parameters<
  typeof import("../job-utils.js").embedAndUpsert
>[1];

/** Embed a target and upsert its vector into the vector store. */
export async function embedAndUpsert(
  targetType: EmbeddingTargetType,
  targetId: string,
  input: EmbeddingInput,
  extraPayload?: Record<string, unknown>,
): Promise<void> {
  const { embedAndUpsert: withConfig } = await import("../job-utils.js");
  return withConfig(getConfig(), targetType, targetId, input, extraPayload);
}

/** Whether the active embedding backend handles multimodal inputs. */
export async function selectedBackendSupportsMultimodal(): Promise<boolean> {
  const { selectedBackendSupportsMultimodal: withConfig } =
    await import("./embedding-backend.js");
  return withConfig(getConfig());
}

// ── Plugin index (Layers 1–2) ──────────────────────────────────────────────
//
// The index/query/get/remove operations are scoped to the *calling plugin*.
// The host derives the plugin's identity from the active execution context
// (`getCurrentPluginName()`); a plugin cannot name another plugin's namespace.
// Called outside any plugin context (host/CLI/tests) these throw, since an
// unscoped plugin-index write has no owner to tag.

/** The manifest name of the plugin in context, or throw if there is none. */
function requirePlugin(op: string): string {
  const plugin = getCurrentPluginName();
  if (!plugin) {
    throw new Error(
      `${op} requires an active plugin execution context (no calling plugin found)`,
    );
  }
  return plugin;
}

/**
 * Layer 1 — embed an input and return the raw dense vector (provider, model,
 * and dimensions included). No persistence.
 */
export async function embed(input: EmbeddingInput): Promise<PluginEmbedding> {
  const { computePluginEmbedding } = await import("./plugin-index.js");
  return computePluginEmbedding(getConfig(), input);
}

/**
 * Layer 1 — generate the sparse (lexical) vector for a text using the host's
 * shared encoder. Pure and local; no backend call, no persistence.
 */
export async function generateSparseEmbedding(
  text: string,
): Promise<SparseEmbedding> {
  const { computePluginSparseEmbedding } = await import("./plugin-index.js");
  return computePluginSparseEmbedding(text);
}

/**
 * Layer 2 — embed and upsert a document into the calling plugin's private
 * index (not agent recall). Returns the document id. Pass `opts.documentId`
 * to overwrite an existing document in place.
 */
export async function indexPluginDocument(
  input: EmbeddingInput,
  opts?: IndexPluginDocumentOptions,
): Promise<PluginIndexDocumentResult> {
  const plugin = requirePlugin("indexPluginDocument");
  const { indexPluginDocument: run } = await import("./plugin-index.js");
  return run(getConfig(), plugin, input, opts);
}

/**
 * Layer 2 — hybrid semantic search over the calling plugin's index only.
 */
export async function queryPluginIndex(
  query: EmbeddingInput,
  opts?: QueryPluginIndexOptions,
): Promise<PluginIndexHit[]> {
  const plugin = requirePlugin("queryPluginIndex");
  const { queryPluginIndex: run } = await import("./plugin-index.js");
  return run(getConfig(), plugin, query, opts);
}

/** Layer 2 — fetch one document from the calling plugin's index, or null. */
export async function getPluginDocument(
  documentId: string,
): Promise<PluginDocument | null> {
  const plugin = requirePlugin("getPluginDocument");
  const { getPluginDocument: run } = await import("./plugin-index.js");
  return run(plugin, documentId);
}

/** Layer 2 — remove one document from the calling plugin's index. */
export async function removePluginDocument(documentId: string): Promise<void> {
  const plugin = requirePlugin("removePluginDocument");
  const { removePluginDocument: run } = await import("./plugin-index.js");
  return run(plugin, documentId);
}

/**
 * Layer 2 — purge every embedding the plugin owns (its whole namespace).
 * Defaults to the calling plugin; the host may pass an explicit name when
 * purging on behalf of a plugin being uninstalled (no active context).
 */
export async function purgePluginEmbeddings(
  pluginName?: string,
): Promise<void> {
  const plugin = pluginName ?? requirePlugin("purgePluginEmbeddings");
  const { purgePluginEmbeddings: run } = await import("./plugin-index.js");
  return run(plugin);
}

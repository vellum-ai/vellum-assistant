import { getConfig } from "../../config/loader.js";
import { getCurrentPluginName } from "../../plugins/plugin-execution-context.js";
import type { EmbeddingInput, SparseEmbedding } from "./embedding-types.js";
import type {
  EmbedResult,
  IndexDocumentOptions,
  IndexDocumentResult,
  IndexedDocument,
  IndexHit,
  QueryIndexOptions,
} from "./plugin-index.js";

/**
 * Plugin-facing facade over the embeddings subsystem: self-contained
 * operations that resolve the live workspace config internally, so callers
 * (plugins importing via `@vellumai/plugin-api`) hold no host config.
 *
 * The operations are loaded via dynamic `import()` inside each wrapper so
 * that importing this module, which every `@vellumai/plugin-api` consumer
 * does transitively, does not eagerly pull the embed/vector import graph
 * (`job-utils`, `embedding-backend`). An eager pull would force those
 * modules' named exports to resolve at instantiation, which breaks the
 * intentional partial module mocks in tests.
 */

export type {
  EmbedResult,
  IndexDocumentOptions,
  IndexDocumentResult,
  IndexedDocument,
  IndexHit,
  QueryIndexOptions,
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

// ── Plugin-owned index ───────────────────────────────────────────────────────
//
// The index/query/get/remove operations are scoped to the calling plugin. The
// host derives the plugin's identity from the active execution context
// (`getCurrentPluginName()`), never a caller argument, so a plugin cannot name
// another plugin's namespace. Called outside any plugin context (host/CLI/
// tests) these throw, since an unscoped write has no owner to tag. There is no
// plugin-facing purge: wiping a whole namespace is a host-only uninstall
// concern (see `purgeEmbeddingsForPlugin` in plugin-index.ts).

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
 * Embed an input and return the raw dense vector (provider, model, and
 * dimensions included), with no persistence.
 */
export async function embed(input: EmbeddingInput): Promise<EmbedResult> {
  const { computeEmbedding } = await import("./plugin-index.js");
  return computeEmbedding(getConfig(), input);
}

/**
 * Generate the sparse (lexical) vector for a text using the host's shared
 * encoder. Pure and local: no backend call, no persistence.
 */
export async function generateSparseEmbedding(
  text: string,
): Promise<SparseEmbedding> {
  const { computeSparseEmbedding } = await import("./plugin-index.js");
  return computeSparseEmbedding(text);
}

/**
 * Embed and upsert a document into the calling plugin's private index (not
 * agent recall). Returns the document id. Pass `opts.documentId` to overwrite
 * an existing document in place.
 */
export async function indexDocument(
  input: EmbeddingInput,
  opts?: IndexDocumentOptions,
): Promise<IndexDocumentResult> {
  const plugin = requirePlugin("indexDocument");
  const { indexDocument: run } = await import("./plugin-index.js");
  return run(getConfig(), plugin, input, opts);
}

/** Hybrid semantic search over the calling plugin's index only. */
export async function queryIndex(
  query: EmbeddingInput,
  opts?: QueryIndexOptions,
): Promise<IndexHit[]> {
  const plugin = requirePlugin("queryIndex");
  const { queryIndex: run } = await import("./plugin-index.js");
  return run(getConfig(), plugin, query, opts);
}

/** Fetch one document from the calling plugin's index, or null. */
export async function getDocument(
  documentId: string,
): Promise<IndexedDocument | null> {
  const plugin = requirePlugin("getDocument");
  const { getDocument: run } = await import("./plugin-index.js");
  return run(plugin, documentId);
}

/** Remove one document from the calling plugin's index. */
export async function removeDocument(documentId: string): Promise<void> {
  const plugin = requirePlugin("removeDocument");
  const { removeDocument: run } = await import("./plugin-index.js");
  return run(plugin, documentId);
}

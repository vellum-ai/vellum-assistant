/**
 * Shared module state and pure helpers for the memory-reference plugin.
 *
 * Files under `src/` are NOT walked by the external-plugin loader, so this
 * module contributes no surface of its own — it is the plugin's internal
 * glue. The `init` hook stashes the resolved {@link PluginHost} here; the
 * `tools/` and `hooks/` files read it back when they run.
 *
 * The whole module imports ONLY from `@vellumai/plugin-api` (+ stdlib). It is
 * the proof point of the reference plugin: a third party can build a real
 * long-term memory entirely against the public host facets, with no
 * `assistant/` source import.
 */

import type {
  EmbeddingsFacet,
  HistoryFacet,
  JobsFacet,
  PluginHost,
  StoreFacet,
  VectorStoreFacet,
} from "@vellumai/plugin-api";

/** Plugin id — also the namespace prefix the host applies to tables/collections/jobs. */
export const PLUGIN_ID = "memoryreference";

/** The plugin's durable fact table (host-namespaced to `plugin_memoryreference_facts`). */
export const FACTS_TABLE = `plugin_${PLUGIN_ID}_facts`;

/** The plugin's dense-vector collection (host-namespaced under the plugin id). */
export const VECTOR_COLLECTION = "facts";

/** Background job type that runs post-turn consolidation (host-namespaced under the plugin id). */
export const CONSOLIDATE_JOB = "consolidate-turn";

/**
 * Embedding dimensionality the collection is created with. The host's embed
 * backend determines the actual vector size; the plugin learns it from the
 * first embed at init and creates the collection to match. This constant is the
 * fallback used only when a fresh init cannot embed a probe (e.g. no backend
 * configured) — in that case the plugin defers collection creation until the
 * first successful embed.
 */
export const DEFAULT_VECTOR_SIZE = 1024;

/** Max characters of a stored fact (defensive cap; facts are short by design). */
export const MAX_FACT_CHARS = 4000;

/** How many memories `recall` / the injection hook pull back by default. */
export const DEFAULT_RECALL_LIMIT = 5;

/** A handle to the plugin's vector collection (resolved lazily at first use). */
export interface VectorCollectionHandle {
  upsert(
    points: {
      id: string;
      vector: number[];
      payload?: Record<string, unknown>;
    }[],
  ): Promise<void>;
  search(
    vector: number[],
    limit: number,
  ): Promise<{ id: string; score: number; payload: Record<string, unknown> }[]>;
  delete(ids: string[]): Promise<void>;
}

/**
 * The live host facets the plugin operates against, captured at `init`. The
 * tools and hooks read this back; it is `null` until `init` runs (and in
 * lightweight test contexts the test injects a host directly via
 * {@link setRuntime}).
 */
export interface MemoryRuntime {
  store: StoreFacet;
  embeddings: EmbeddingsFacet;
  vectorStore: VectorStoreFacet;
  history: HistoryFacet;
  jobs: JobsFacet;
  /** Resolved lazily: the namespaced vector collection. */
  collection: VectorCollectionHandle | null;
  /** Embedding size the collection was (or will be) created with. */
  vectorSize: number;
}

let runtime: MemoryRuntime | null = null;

/** Install the runtime (called from `init`, or directly from tests). */
export function setRuntime(host: PluginHost): MemoryRuntime {
  runtime = {
    store: host.store,
    embeddings: host.embeddings,
    vectorStore: host.vectorStore,
    history: host.history,
    jobs: host.jobs,
    collection: null,
    vectorSize: DEFAULT_VECTOR_SIZE,
  };
  return runtime;
}

/** Read the installed runtime, throwing a clear error if `init` has not run. */
export function getRuntime(): MemoryRuntime {
  if (runtime === null) {
    throw new Error(
      "memory-reference: runtime not initialized — the init hook must run before tools/hooks fire",
    );
  }
  return runtime;
}

/**
 * Read the installed runtime, or `null` when `init` has not run (or ran without
 * a host). Hooks fire-and-forget over a turn that may predate init, so they
 * degrade gracefully on `null` rather than throwing; the tools, which the model
 * only sees once registered, use {@link getRuntime} and surface a hard error.
 */
export function tryGetRuntime(): MemoryRuntime | null {
  return runtime;
}

/** Reset module state (test isolation only). */
export function resetRuntime(): void {
  runtime = null;
}

/**
 * Resolve (and cache) the plugin's vector collection, sizing it to `vectorSize`.
 * Idempotent: the host's `collection()` returns the same logical collection for
 * a given (plugin, name), so calling this repeatedly is cheap.
 */
export async function ensureCollection(
  rt: MemoryRuntime,
  vectorSize: number,
): Promise<VectorCollectionHandle> {
  if (rt.collection !== null && rt.vectorSize === vectorSize) {
    return rt.collection;
  }
  const collection = await rt.vectorStore.collection(VECTOR_COLLECTION, {
    vectorSize,
  });
  rt.collection = collection;
  rt.vectorSize = vectorSize;
  return collection;
}

/** A single stored fact row, as persisted in the durable store. */
export interface FactRow {
  id: string;
  conversation_id: string;
  text: string;
  created_at: number;
}

/**
 * Embed one text and return its dense vector. Centralizes the "embed a single
 * string" call the tools and hooks share, so the batch-shaped facet is invoked
 * the same way everywhere.
 */
export async function embedOne(
  rt: MemoryRuntime,
  text: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const [vector] = await rt.embeddings.embed(
    [text],
    signal ? { signal } : undefined,
  );
  if (vector === undefined) {
    throw new Error("memory-reference: embeddings backend returned no vector");
  }
  return vector;
}

/** Generate a stable, collision-resistant fact id. */
export function newFactId(): string {
  return `fact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Render the retrieved facts into the `<memory>` block text injected into the
 * turn. Pure: takes the already-fetched fact texts and returns the block body.
 */
export function renderMemoryBlock(facts: string[]): string {
  const lines = facts.map((f) => `- ${f}`).join("\n");
  return `<memory>\nRelevant long-term memories (memory-reference plugin):\n${lines}\n</memory>`;
}

/**
 * Persist a fact: store the row in the durable store and upsert its embedding
 * into the vector collection. Shared by the `remember` tool and the
 * consolidation job so both write a fact the exact same way. Returns the new
 * fact id.
 */
export async function rememberFact(
  rt: MemoryRuntime,
  conversationId: string,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const trimmed = text.trim().slice(0, MAX_FACT_CHARS);
  if (trimmed.length === 0) {
    throw new Error("memory-reference: cannot remember empty text");
  }
  const id = newFactId();
  const createdAt = Date.now();
  rt.store.exec(
    `INSERT OR REPLACE INTO ${FACTS_TABLE} (id, conversation_id, text, created_at)
       VALUES (?, ?, ?, ?)`,
    [id, conversationId, trimmed, createdAt],
  );
  const vector = await embedOne(rt, trimmed, signal);
  const collection = await ensureCollection(rt, vector.length);
  await collection.upsert([
    { id, vector, payload: { conversationId, text: trimmed } },
  ]);
  return id;
}

/**
 * Recall facts most similar to `query`: embed the query, search the vector
 * collection, then hydrate the matching rows from the durable store (the store
 * is the source of truth for fact text; the vector payload is a denormalized
 * convenience). Returns fact texts, best match first. Shared by the `recall`
 * tool and the injection hook.
 */
export async function recallFacts(
  rt: MemoryRuntime,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<FactRow[]> {
  if (rt.collection === null) {
    // No collection yet means nothing has been remembered — nothing to recall.
    return [];
  }
  const vector = await embedOne(rt, query, signal);
  const collection = await ensureCollection(rt, vector.length);
  const hits = await collection.search(vector, limit);
  if (hits.length === 0) return [];

  const ids = hits.map((h) => h.id);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = rt.store.query<FactRow>(
    `SELECT id, conversation_id, text, created_at
       FROM ${FACTS_TABLE}
      WHERE id IN (${placeholders})`,
    ids,
  );
  // Re-order rows to match the vector-search ranking (SQL IN does not preserve order).
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is FactRow => r !== undefined);
}

/**
 * Pull plain text out of a stored content string. History rows carry the raw
 * stored content — a JSON content-block array or plain text. This narrows to the
 * text the plugin embeds/searches, with a plain-string fallback.
 */
export function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (b): b is { type: "text"; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "text" &&
            typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("\n");
    }
  } catch {
    // Not JSON — fall through to the raw string.
  }
  return content;
}

// ---------------------------------------------------------------------------
// Memory Graph — Qdrant vector search for graph nodes
// ---------------------------------------------------------------------------

import { getConfig } from "../../../../config/loader.js";
import type { EmbeddingInput } from "../../../../persistence/embeddings/embedding-types.js";
import { isQdrantBreakerOpen } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import { withQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import {
  getQdrantClient,
  type QdrantSearchResult,
  type QdrantSparseVector,
} from "../../../../persistence/embeddings/qdrant-client.js";
import { asString } from "../../../../persistence/job-utils.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
  type MemoryJob,
} from "../../../../persistence/jobs-store.js";
import { getLogger } from "../../../../util/logger.js";
import {
  embedAndUpsert,
  selectedBackendSupportsMultimodal,
} from "../embeddings.js";
import { loadImageRefData } from "./image-ref-utils.js";
import { getNode } from "./store.js";
import type { MemoryNode } from "./types.js";

const log = getLogger("graph-search");

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface GraphSearchResult {
  nodeId: string;
  score: number;
  text: string;
}

/**
 * Semantic search across graph nodes in Qdrant. Returns scored node IDs
 * that the caller can hydrate from the graph store.
 *
 * Filters to `target_type: "graph_node"`.
 */
export async function searchGraphNodes(
  queryVector: number[],
  limit: number,
  sparseVector?: QdrantSparseVector,
  dateRange?: { afterMs?: number; beforeMs?: number },
): Promise<GraphSearchResult[]> {
  // v2 owns the read path when enabled. The v1 `memory` collection is in
  // active retirement and a corrupted sparse segment can OOM-crash the
  // shared Qdrant process — short-circuiting here keeps v1 background work
  // and stale callers from taking v2 down with them.
  if (getConfig().memory.v2.enabled) return [];

  if (isQdrantBreakerOpen()) {
    log.warn("Qdrant circuit breaker open, skipping graph search");
    return [];
  }

  const client = getQdrantClient();

  const mustNot: Record<string, unknown>[] = [
    { key: "_meta", match: { value: true } },
  ];

  // Use hybrid search (dense + sparse with RRF fusion) when a non-empty
  // sparse vector is available; otherwise fall back to dense-only search.
  if (sparseVector && sparseVector.indices.length > 0) {
    const must: Record<string, unknown>[] = [
      { key: "target_type", match: { value: "graph_node" } },
    ];
    if (dateRange?.afterMs != null) {
      must.push({ key: "created_at", range: { gte: dateRange.afterMs } });
    }
    if (dateRange?.beforeMs != null) {
      must.push({ key: "created_at", range: { lte: dateRange.beforeMs } });
    }
    const filter = { must, must_not: mustNot };

    // RRF fuses per-modality top-N. A small prefetch (e.g. limit*3) silently
    // truncates good matches when the query is wordy or low-similarity, so
    // give RRF a meaningful candidate window with a generous floor.
    const prefetchLimit = Math.max(limit * 10, 200);

    const results: QdrantSearchResult[] = await withQdrantBreaker(() =>
      client.hybridSearch({
        denseVector: queryVector,
        sparseVector,
        filter,
        limit,
        prefetchLimit,
      }),
    );

    return results.map((r) => ({
      nodeId: r.payload.target_id,
      score: r.score,
      text: r.payload.text,
    }));
  }

  // Dense-only fallback
  const denseMusts: Record<string, unknown>[] = [
    {
      key: "target_type",
      match: { value: "graph_node" },
    },
  ];

  if (dateRange?.afterMs != null) {
    denseMusts.push({ key: "created_at", range: { gte: dateRange.afterMs } });
  }
  if (dateRange?.beforeMs != null) {
    denseMusts.push({ key: "created_at", range: { lte: dateRange.beforeMs } });
  }

  const filter: Record<string, unknown> = {
    must: denseMusts,
    must_not: mustNot,
  };

  const results: QdrantSearchResult[] = await withQdrantBreaker(async () => {
    return client.search(queryVector, limit, filter);
  });

  return results.map((r) => ({
    nodeId: r.payload.target_id,
    score: r.score,
    text: r.payload.text,
  }));
}

// ---------------------------------------------------------------------------
// Embedding job
// ---------------------------------------------------------------------------

/**
 * Format a graph node's content for embedding. Prepends type metadata
 * so the embedding captures structural information alongside content.
 */
function formatNodeForEmbedding(node: MemoryNode): string {
  const parts = [`[${node.type}]`];
  if (node.emotionalCharge.intensity > 0.3) {
    const valenceLabel =
      node.emotionalCharge.valence > 0.3
        ? "positive"
        : node.emotionalCharge.valence < -0.3
          ? "negative"
          : "neutral";
    parts.push(`[${valenceLabel}]`);
  }
  parts.push(node.content);
  return parts.join(" ");
}

/**
 * Embed a graph node and upsert to Qdrant. Can be called directly
 * (synchronous embedding during bootstrap) or via the job handler.
 *
 * When the node has image references and the Gemini embedding backend is
 * available, embeds the image content directly for cross-modal retrieval
 * (text queries match image memories in the same vector space). Falls back
 * to text embedding with image description suffixes otherwise.
 */
export async function embedGraphNodeDirect(node: MemoryNode): Promise<void> {
  if (node.fidelity === "gone") return;

  const text = formatNodeForEmbedding(node);
  const extraPayload: Record<string, unknown> = {
    created_at: node.created,
    memory_scope_id: node.scopeId,
    confidence: node.confidence,
    importance: node.significance,
    kind: node.type,
  };

  if (node.imageRefs && node.imageRefs.length > 0) {
    const multimodalAvailable = await selectedBackendSupportsMultimodal();
    if (multimodalAvailable) {
      const imageData = await loadImageRefData(node.imageRefs[0]);
      if (imageData) {
        try {
          const input: EmbeddingInput = {
            type: "image",
            data: imageData.data,
            mimeType: imageData.mimeType,
          };
          await embedAndUpsert("graph_node", node.id, input, {
            ...extraPayload,
            has_image: true,
          });
          return;
        } catch (err) {
          log.warn(
            "Multimodal embed failed for node %s, falling back to text: %s",
            node.id,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // Fallback: text embedding with image description suffix
    const descSuffix = node.imageRefs.map((r) => r.description).join("; ");
    const textWithImages = `${text}\n[images: ${descSuffix}]`;
    await embedAndUpsert("graph_node", node.id, textWithImages, extraPayload);
    return;
  }

  await embedAndUpsert("graph_node", node.id, text, extraPayload);
}

/**
 * Job handler: embed a graph node and upsert to Qdrant.
 */
export async function embedGraphNodeJob(job: MemoryJob): Promise<void> {
  const nodeId = asString(job.payload.nodeId);
  if (!nodeId) return;

  const node = getNode(nodeId);
  if (!node) return;

  await embedGraphNodeDirect(node);
}

/**
 * Enqueue an embedding job for a graph node (async, for live conversations).
 */
export function enqueueGraphNodeEmbed(nodeId: string): void {
  if (!isMemoryEnabled()) return;
  enqueueMemoryJob("embed_graph_node", { nodeId });
}

/**
 * Job handler: embed a trigger's condition text and store the
 * embedding on the trigger row.
 */
export async function embedGraphTriggerJob(job: MemoryJob): Promise<void> {
  const triggerId = asString(job.payload.triggerId);
  if (!triggerId) return;

  // Import here to avoid circular dependency
  const { getDb } = await import("../../../../persistence/db-connection.js");
  const { eq } = await import("drizzle-orm");
  const { memoryGraphTriggers } =
    await import("../../../../persistence/schema/index.js");
  const { embedWithBackend } = await import("../embeddings.js");

  const db = getDb();
  const row = db
    .select()
    .from(memoryGraphTriggers)
    .where(eq(memoryGraphTriggers.id, triggerId))
    .get();

  if (!row || !row.condition) return;

  const result = await embedWithBackend([row.condition]);
  const vector = result.vectors[0];
  if (!vector) return;

  const buffer = Buffer.from(new Float32Array(vector).buffer);
  db.update(memoryGraphTriggers)
    .set({ conditionEmbedding: buffer })
    .where(eq(memoryGraphTriggers.id, triggerId))
    .run();
}

/**
 * Enqueue a trigger embedding job.
 */
export function enqueueGraphTriggerEmbed(triggerId: string): void {
  if (!isMemoryEnabled()) return;
  enqueueMemoryJob("graph_trigger_embed", { triggerId });
}

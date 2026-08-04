// ---------------------------------------------------------------------------
// Memory Graph — node/trigger embedding plumbing (all tiers)
//
// Capability seeding writes graph nodes on every tier, so the
// `embed_graph_node` and `graph_trigger_embed` jobs handled here run under
// the substrate too. The v1 hybrid node SEARCH path lives in
// `../v1/graph/graph-search.ts`.
// ---------------------------------------------------------------------------

import {
  embedAndUpsert,
  selectedBackendSupportsMultimodal,
} from "@vellumai/plugin-api";

import type { AssistantConfig } from "../../../../config/types.js";
import type { EmbeddingInput } from "../../../../persistence/embeddings/embedding-types.js";
import { asString } from "../../../../persistence/job-utils.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
  type MemoryJob,
} from "../../../../persistence/jobs-store.js";
import { getLogger } from "../logging.js";
import { loadImageRefData } from "./image-ref-utils.js";
import { getNode } from "./store.js";
import type { MemoryNode } from "./types.js";

const log = getLogger("graph-search");

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
  if (node.fidelity === "gone") {
    return;
  }

  const text = formatNodeForEmbedding(node);
  const extraPayload: Record<string, unknown> = {
    created_at: node.created,
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
  if (!nodeId) {
    return;
  }

  const node = getNode(nodeId);
  if (!node) {
    return;
  }

  await embedGraphNodeDirect(node);
}

/**
 * Enqueue an embedding job for a graph node (async, for live conversations).
 */
export function enqueueGraphNodeEmbed(nodeId: string): void {
  if (!isMemoryEnabled()) {
    return;
  }
  enqueueMemoryJob("embed_graph_node", { nodeId });
}

/**
 * Job handler: embed a trigger's condition text and store the
 * embedding on the trigger row.
 */
export async function embedGraphTriggerJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const triggerId = asString(job.payload.triggerId);
  if (!triggerId) {
    return;
  }

  // Import here to avoid circular dependency
  const { memoryDbOrNull } = await import("../memory-db.js");
  const { eq } = await import("drizzle-orm");
  const { memoryGraphTriggers } =
    await import("../../../../persistence/schema/index.js");
  const { embedWithBackend } = await import("../embeddings.js");

  const db = memoryDbOrNull("embedGraphTriggerJob");
  if (!db) {
    return;
  }
  const row = db
    .select()
    .from(memoryGraphTriggers)
    .where(eq(memoryGraphTriggers.id, triggerId))
    .get();

  if (!row || !row.condition) {
    return;
  }

  const result = await embedWithBackend(config, [row.condition]);
  const vector = result.vectors[0];
  if (!vector) {
    return;
  }

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
  if (!isMemoryEnabled()) {
    return;
  }
  enqueueMemoryJob("graph_trigger_embed", { triggerId });
}

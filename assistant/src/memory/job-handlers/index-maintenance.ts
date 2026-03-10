import { eq } from "drizzle-orm";

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { getDb, rawExec } from "../db.js";
import { asString, BackendUnavailableError } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { extractMediaBlocks } from "../message-content.js";
import { withQdrantBreaker } from "../qdrant-circuit-breaker.js";
import { getQdrantClient } from "../qdrant-client.js";
import {
  mediaAssets,
  memoryEmbeddings,
  memoryItems,
  memorySegments,
  memorySummaries,
  messages,
} from "../schema.js";

const log = getLogger("memory-jobs-worker");

export function rebuildIndexJob(): void {
  const db = getDb();
  rawExec(/*sql*/ `DELETE FROM memory_segment_fts`);
  rawExec(/*sql*/ `
    INSERT INTO memory_segment_fts(segment_id, text)
    SELECT id, text FROM memory_segments
  `);
  db.delete(memoryEmbeddings).run();

  const items = db
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(eq(memoryItems.status, "active"))
    .all();
  for (const item of items) {
    enqueueMemoryJob("embed_item", { itemId: item.id });
  }

  const summaries = db
    .select({ id: memorySummaries.id })
    .from(memorySummaries)
    .all();
  for (const summary of summaries) {
    enqueueMemoryJob("embed_summary", { summaryId: summary.id });
  }

  const segments = db
    .select({ id: memorySegments.id })
    .from(memorySegments)
    .all();
  for (const segment of segments) {
    enqueueMemoryJob("embed_segment", { segmentId: segment.id });
  }

  // Re-enqueue multimodal embedding jobs only when the embedding provider
  // supports multimodal inputs (Gemini). Without this gate, embed_media and
  // embed_attachment jobs would all fail for non-Gemini users.
  const fullConfig = getConfig();
  const embeddingProvider = fullConfig.memory.embeddings.provider;
  const supportsMultimodal =
    embeddingProvider === "gemini" ||
    (embeddingProvider === "auto" && !!fullConfig.apiKeys.gemini);

  if (supportsMultimodal) {
    const assets = db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.status, "indexed"))
      .all();
    for (const asset of assets) {
      enqueueMemoryJob("embed_media", { assetId: asset.id });
    }

    const allMessages = db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .all();
    for (const msg of allMessages) {
      const blocks = extractMediaBlocks(msg.content);
      const imageBlocks = blocks.filter((b) => b.type === "image");
      for (const block of imageBlocks) {
        enqueueMemoryJob("embed_attachment", {
          messageId: msg.id,
          blockIndex: block.index,
        });
      }
    }
  }
}

export async function deleteQdrantVectorsJob(job: MemoryJob): Promise<void> {
  const targetType = asString(job.payload.targetType);
  const targetId = asString(job.payload.targetId);
  if (!targetType || !targetId) return;

  let qdrant;
  try {
    qdrant = getQdrantClient();
  } catch {
    throw new BackendUnavailableError("Qdrant client not initialized");
  }

  await withQdrantBreaker(() => qdrant.deleteByTarget(targetType, targetId));
  log.info(
    { targetType, targetId },
    "Retried Qdrant vector deletion succeeded",
  );
}

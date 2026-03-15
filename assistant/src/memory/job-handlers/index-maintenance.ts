import { eq, like } from "drizzle-orm";

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { selectedBackendSupportsMultimodal } from "../embedding-backend.js";
import { asString, BackendUnavailableError } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { extractMediaBlockMeta } from "../message-content.js";
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

export async function rebuildIndexJob(): Promise<void> {
  const db = getDb();
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

  // Re-enqueue multimodal embedding jobs only when the resolved embedding
  // backend supports multimodal inputs. Without this gate, embed_media and
  // embed_attachment jobs would all fail for text-only backends.
  if (await selectedBackendSupportsMultimodal(getConfig())) {
    const assets = db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.status, "indexed"))
      .all();
    for (const asset of assets) {
      enqueueMemoryJob("embed_media", { assetId: asset.id });
    }

    const imageMessages = db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(like(messages.content, '%"type":"image"%'))
      .all();
    for (const msg of imageMessages) {
      const blocks = extractMediaBlockMeta(msg.content);
      for (const block of blocks) {
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

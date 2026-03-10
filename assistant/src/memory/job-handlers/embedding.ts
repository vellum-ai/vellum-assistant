import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import { getDb } from "../db.js";
import type { EmbeddingInput } from "../embedding-types.js";
import { asString, embedAndUpsert } from "../job-utils.js";
import type { MemoryJob } from "../jobs-store.js";
import { extractMediaBlocks } from "../message-content.js";
import {
  mediaAssets,
  memoryItems,
  memorySegments,
  memorySummaries,
  messages,
} from "../schema.js";

export async function embedSegmentJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const segmentId = asString(job.payload.segmentId);
  if (!segmentId) return;
  const db = getDb();
  const segment = db
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.id, segmentId))
    .get();
  if (!segment) return;
  await embedAndUpsert(config, "segment", segment.id, segment.text, {
    conversation_id: segment.conversationId,
    message_id: segment.messageId,
    created_at: segment.createdAt,
  });
}

export async function embedItemJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const itemId = asString(job.payload.itemId);
  if (!itemId) return;
  const db = getDb();
  const item = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, itemId))
    .get();
  if (!item || item.status !== "active") return;
  const text = `<kind>${item.kind}</kind> ${item.subject}: ${item.statement}`;
  await embedAndUpsert(config, "item", item.id, text, {
    kind: item.kind,
    subject: item.subject,
    status: item.status,
    confidence: item.confidence,
    created_at: item.firstSeenAt,
    last_seen_at: item.lastSeenAt,
  });
}

export async function embedSummaryJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const summaryId = asString(job.payload.summaryId);
  if (!summaryId) return;
  const db = getDb();
  const summary = db
    .select()
    .from(memorySummaries)
    .where(eq(memorySummaries.id, summaryId))
    .get();
  if (!summary) return;
  await embedAndUpsert(
    config,
    "summary",
    summary.id,
    `[${summary.scope}] ${summary.summary}`,
    {
      kind: summary.scope,
      created_at: summary.startAt,
      last_seen_at: summary.endAt,
    },
  );
}

export async function embedMediaJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const assetId = asString(job.payload.assetId);
  if (!assetId) return;

  const db = getDb();
  const asset = db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId))
    .get();
  if (!asset || asset.status !== "indexed") return;

  // Read the media file from disk
  const fileData = await readFile(asset.filePath);

  // Determine modality from mediaType
  const input: EmbeddingInput = {
    type: asset.mediaType as "image" | "audio" | "video",
    data: fileData,
    mimeType: asset.mimeType,
  };

  await embedAndUpsert(config, "media", asset.id, input, {
    created_at: asset.createdAt,
    kind: asset.mediaType,
    subject: asset.title,
  });
}

export async function embedAttachmentJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const messageId = asString(job.payload.messageId);
  const blockIndex = job.payload.blockIndex as number;
  if (!messageId || typeof blockIndex !== "number") return;

  const db = getDb();
  const message = db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!message) return;

  const mediaBlocks = extractMediaBlocks(message.content);
  const block = mediaBlocks.find((b) => b.index === blockIndex);
  if (!block) return;

  const input: EmbeddingInput = {
    type: block.type,
    data: block.data,
    mimeType: block.mimeType,
  };

  // Use messageId + blockIndex as targetId for uniqueness
  const targetId = `${messageId}:${blockIndex}`;
  await embedAndUpsert(config, "media", targetId, input, {
    created_at: message.createdAt,
    message_id: messageId,
    conversation_id: message.conversationId,
  });
}

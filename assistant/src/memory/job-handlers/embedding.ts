import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import { getConversationMemoryScopeId } from "../conversation-crud.js";
import { getDb } from "../db.js";
import type { EmbeddingInput } from "../embedding-types.js";
import { asString, embedAndUpsert } from "../job-utils.js";
import type { MemoryJob } from "../jobs-store.js";
import { extractMediaBlocks } from "../message-content.js";
import {
  mediaAssets,
  memoryChunks,
  memoryEpisodes,
  memoryObservations,
  messages,
} from "../schema.js";

export async function embedChunkJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const chunkId = asString(job.payload.chunkId);
  if (!chunkId) return;
  const db = getDb();
  const chunk = db
    .select()
    .from(memoryChunks)
    .where(eq(memoryChunks.id, chunkId))
    .get();
  if (!chunk) return;
  await embedAndUpsert(config, "chunk", chunk.id, chunk.content, {
    observation_id: chunk.observationId,
    created_at: chunk.createdAt,
    memory_scope_id: chunk.scopeId,
  });
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
    memory_scope_id: "default",
  });
}

export async function embedObservationJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const observationId = asString(job.payload.observationId);
  const chunkId = asString(job.payload.chunkId);
  if (!observationId || !chunkId) return;

  const db = getDb();
  const observation = db
    .select()
    .from(memoryObservations)
    .where(eq(memoryObservations.id, observationId))
    .get();
  if (!observation) return;

  const chunk = db
    .select()
    .from(memoryChunks)
    .where(eq(memoryChunks.id, chunkId))
    .get();
  if (!chunk) return;

  await embedAndUpsert(config, "observation", chunk.id, chunk.content, {
    observation_id: observationId,
    conversation_id: observation.conversationId,
    role: observation.role,
    modality: observation.modality,
    source: observation.source,
    created_at: observation.createdAt,
    memory_scope_id: observation.scopeId,
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
  const memoryScopeId = getConversationMemoryScopeId(message.conversationId);
  await embedAndUpsert(config, "media", targetId, input, {
    created_at: message.createdAt,
    message_id: messageId,
    conversation_id: message.conversationId,
    memory_scope_id: memoryScopeId,
  });
}

export async function embedEpisodeJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const episodeId = asString(job.payload.episodeId);
  if (!episodeId) return;
  const db = getDb();
  const episode = db
    .select()
    .from(memoryEpisodes)
    .where(eq(memoryEpisodes.id, episodeId))
    .get();
  if (!episode) return;
  const text = `[episode] ${episode.title}: ${episode.summary}`;
  await embedAndUpsert(config, "episode", episode.id, text, {
    conversation_id: episode.conversationId,
    created_at: episode.startAt,
    last_seen_at: episode.endAt,
    memory_scope_id: episode.scopeId,
  });
}

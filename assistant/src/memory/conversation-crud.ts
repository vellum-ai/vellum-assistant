import { mkdirSync, rmSync } from "node:fs";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { z } from "zod";

import type { ChannelId, InterfaceId } from "../channels/types.js";
import { parseChannelId, parseInterfaceId } from "../channels/types.js";
import { CHANNEL_IDS, INTERFACE_IDS, isChannelId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { UserError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getConversationsDir } from "../util/platform.js";
import { createRowMapper } from "../util/row-mapper.js";
import {
  deleteOrphanAttachments,
  linkAttachmentToMessage,
} from "./attachments-store.js";
import {
  projectAssistantMessage,
  seedForkedConversationAttention,
} from "./conversation-attention-store.js";
import {
  initConversationDir,
  removeConversationDir,
  syncMessageToDisk,
  updateMetaFile,
} from "./conversation-disk-view.js";
import { ensureDisplayOrderMigration } from "./conversation-display-order-migration.js";
import { getDb, rawAll, rawExec, rawGet, rawRun } from "./db.js";
import { indexMessageNow } from "./indexer.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import {
  channelInboundEvents,
  conversations,
  conversationStarters,
  llmRequestLogs,
  memoryChunks,
  memoryEmbeddings,
  memoryEpisodes,
  memoryObservations,
  messageAttachments,
  messages,
  openLoops,
  timeContexts,
  toolInvocations,
} from "./schema.js";
import { cancelPendingJobsForConversation } from "./task-memory-cleanup.js";

const log = getLogger("conversation-store");

// ── Message metadata Zod schema ──────────────────────────────────────
// Validates the JSON stored in messages.metadata. Known fields are typed;
// extra keys are allowed via passthrough so callers can attach ad-hoc data.

const channelIdSchema = z.enum(CHANNEL_IDS);
const interfaceIdSchema = z.enum(INTERFACE_IDS);

const subagentNotificationSchema = z.object({
  subagentId: z.string(),
  label: z.string(),
  status: z.enum(["completed", "failed", "aborted"]),
  error: z.string().optional(),
  conversationId: z.string().optional(),
});

export const PRIVATE_CONVERSATION_FORK_ERROR =
  "Private conversations cannot be forked";

export const messageMetadataSchema = z
  .object({
    userMessageChannel: channelIdSchema.optional(),
    assistantMessageChannel: channelIdSchema.optional(),
    userMessageInterface: interfaceIdSchema.optional(),
    assistantMessageInterface: interfaceIdSchema.optional(),
    subagentNotification: subagentNotificationSchema.optional(),
    /**
     * Trust class of the actor at the time this message was persisted.
     * This is a durable snapshot -- it does NOT change if the actor's
     * trust status changes later. Used by the memory write gate (indexer)
     * and read gate (conversation history loading) to enforce trust-aware access.
     */
    provenanceTrustClass: z
      .enum(["guardian", "trusted_contact", "unknown"])
      .optional(),
    provenanceSourceChannel: channelIdSchema.optional(),
    provenanceGuardianExternalUserId: z.string().optional(),
    provenanceRequesterIdentifier: z.string().optional(),
    automated: z.boolean().optional(),
    forkSourceMessageId: z.string().optional(),
    /** Image source paths from desktop attachments, keyed by filename. */
    imageSourcePaths: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

function cloneForkMessageMetadata(
  metadata: string | null,
  sourceMessageId: string,
): string {
  if (!metadata) {
    return JSON.stringify({ forkSourceMessageId: sourceMessageId });
  }

  try {
    const parsed = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const sourceRecord = parsed as Record<string, unknown>;
      const forkSourceMessageId =
        typeof sourceRecord.forkSourceMessageId === "string"
          ? sourceRecord.forkSourceMessageId
          : sourceMessageId;
      return JSON.stringify({
        ...sourceRecord,
        forkSourceMessageId,
      });
    }
  } catch {
    // Fall through to source-only metadata.
  }

  return JSON.stringify({ forkSourceMessageId: sourceMessageId });
}

/**
 * Extract provenance metadata fields from a TrustContext.
 * When no guardian context is provided, defaults to 'unknown' because the
 * absence of trust context means we cannot verify trust —
 * callers with actual guardian trust should always supply a real context.
 */
export function provenanceFromTrustContext(
  ctx: TrustContext | null | undefined,
): Record<string, unknown> {
  if (!ctx) return { provenanceTrustClass: "unknown" };
  return {
    provenanceTrustClass: ctx.trustClass,
    provenanceSourceChannel: ctx.sourceChannel,
    provenanceGuardianExternalUserId: ctx.guardianExternalUserId,
    provenanceRequesterIdentifier: ctx.requesterIdentifier,
  };
}

export interface ConversationRow {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
  contextSummary: string | null;
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
  conversationType: string;
  source: string;
  memoryScopeId: string;
  originChannel: string | null;
  originInterface: string | null;
  forkParentConversationId: string | null;
  forkParentMessageId: string | null;
  isAutoTitle: number;
  scheduleJobId: string | null;
  memoryReducedThroughMessageId: string | null;
  memoryDirtyTailSinceMessageId: string | null;
  memoryLastReducedAt: number | null;
}

export const parseConversation = createRowMapper<
  typeof conversations.$inferSelect,
  ConversationRow
>({
  id: "id",
  title: "title",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  totalInputTokens: "totalInputTokens",
  totalOutputTokens: "totalOutputTokens",
  totalEstimatedCost: "totalEstimatedCost",
  contextSummary: "contextSummary",
  contextCompactedMessageCount: "contextCompactedMessageCount",
  contextCompactedAt: "contextCompactedAt",
  conversationType: "conversationType",
  source: "source",
  memoryScopeId: "memoryScopeId",
  originChannel: "originChannel",
  originInterface: "originInterface",
  forkParentConversationId: "forkParentConversationId",
  forkParentMessageId: "forkParentMessageId",
  isAutoTitle: "isAutoTitle",
  scheduleJobId: "scheduleJobId",
  memoryReducedThroughMessageId: "memoryReducedThroughMessageId",
  memoryDirtyTailSinceMessageId: "memoryDirtyTailSinceMessageId",
  memoryLastReducedAt: "memoryLastReducedAt",
});

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}

export const parseMessage = createRowMapper<
  typeof messages.$inferSelect,
  MessageRow
>({
  id: "id",
  conversationId: "conversationId",
  role: "role",
  content: "content",
  createdAt: "createdAt",
  metadata: "metadata",
});

/**
 * Monotonic timestamp source for message ordering. Two messages saved within
 * the same millisecond (e.g., tool_results user message + assistant message in
 * message_complete) would get the same Date.now(), making their reload order
 * non-deterministic. This counter ensures every call returns a strictly
 * increasing value so insertion order is always preserved.
 */
let lastTimestamp = 0;
function monotonicNow(): number {
  const now = Date.now();
  lastTimestamp = Math.max(now, lastTimestamp + 1);
  return lastTimestamp;
}

export function createConversation(
  titleOrOpts?:
    | string
    | {
        title?: string;
        conversationType?: "standard" | "private" | "background";
        source?: string;
        scheduleJobId?: string;
      },
) {
  const db = getDb();
  const now = Date.now();
  const opts =
    typeof titleOrOpts === "string"
      ? { title: titleOrOpts }
      : (titleOrOpts ?? {});
  const conversationType = opts.conversationType ?? "standard";
  const source = opts.source ?? "user";
  const id = uuid();
  const memoryScopeId =
    conversationType === "private" ? `private:${id}` : "default";
  const conversation = {
    id,
    title: opts.title ?? null,
    createdAt: now,
    updatedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null as string | null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null as number | null,
    conversationType,
    source,
    memoryScopeId,
    scheduleJobId: opts.scheduleJobId ?? null,
  };

  // Retry on SQLITE_BUSY and SQLITE_IOERR — transient disk I/O errors or WAL
  // contention can cause the first attempt to fail even under normal load.
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    try {
      db.insert(conversations).values(conversation).run();
      break;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (
        attempt < MAX_RETRIES &&
        (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR"))
      ) {
        log.warn(
          { attempt, conversationId: id, code },
          "createConversation: transient SQLite error, retrying",
        );
        // Synchronous sleep — createConversation is synchronous and the
        // retry window is short (50-150ms), so Bun.sleepSync is appropriate.
        Bun.sleepSync(50 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  initConversationDir({ ...conversation, originChannel: null });

  return conversation;
}

export function getConversation(id: string): ConversationRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  return row ? parseConversation(row) : null;
}

export function getConversationType(
  conversationId: string,
): "standard" | "private" {
  const conv = getConversation(conversationId);
  const raw = conv?.conversationType;
  return raw === "private" ? "private" : "standard";
}

export function getConversationMemoryScopeId(conversationId: string): string {
  const conv = getConversation(conversationId);
  return conv?.memoryScopeId ?? "default";
}

export function forkConversation(params: {
  conversationId: string;
  throughMessageId?: string;
}): ConversationRow {
  const { conversationId, throughMessageId } = params;
  const db = getDb();
  const sourceConversation = getConversation(conversationId);

  if (!sourceConversation) {
    throw new UserError(`Conversation ${conversationId} not found`);
  }
  if (sourceConversation.conversationType === "private") {
    throw new UserError(PRIVATE_CONVERSATION_FORK_ERROR);
  }

  const sourceMessages = getMessages(conversationId);

  if (sourceMessages.length === 0) {
    throw new UserError(
      `Conversation ${conversationId} has no persisted messages to fork`,
    );
  }

  const copyBoundaryIndex =
    throughMessageId == null
      ? sourceMessages.length - 1
      : sourceMessages.findIndex((message) => message.id === throughMessageId);

  if (throughMessageId != null && copyBoundaryIndex === -1) {
    throw new UserError(
      `Message ${throughMessageId} does not belong to conversation ${conversationId}`,
    );
  }

  const visibleWindowStartIndex = Math.max(
    0,
    Math.min(
      sourceConversation.contextCompactedMessageCount,
      sourceMessages.length,
    ),
  );
  const preserveSourceCompactionState =
    copyBoundaryIndex >= visibleWindowStartIndex;

  const messagesToCopy =
    copyBoundaryIndex >= 0
      ? sourceMessages.slice(0, copyBoundaryIndex + 1)
      : ([] as MessageRow[]);
  const forkParentMessageId = messagesToCopy.at(-1)?.id ?? null;
  const forkTitle = `${sourceConversation.title ?? "Untitled"} (Fork)`;

  // Collect disk-sync work to run after the transaction commits.
  const diskSyncQueue: Array<{
    conversationId: string;
    messageId: string;
    createdAt: number;
  }> = [];

  // Wrap all DB mutations in a single transaction so a mid-flight failure
  // rolls back cleanly instead of leaving a partial fork. Helper functions
  // (linkAttachmentToMessage, relinkAttachments, seedForkedConversationAttention)
  // use the same underlying bun:sqlite connection, so their writes participate
  // in this transaction automatically.
  const forkedConversation = db.transaction(() => {
    const fc = createConversation({
      title: forkTitle,
      conversationType: "standard",
    });

    db.update(conversations)
      .set({
        forkParentConversationId: sourceConversation.id,
        forkParentMessageId,
        contextSummary: preserveSourceCompactionState
          ? sourceConversation.contextSummary
          : null,
        contextCompactedMessageCount: preserveSourceCompactionState
          ? sourceConversation.contextCompactedMessageCount
          : 0,
        contextCompactedAt: preserveSourceCompactionState
          ? sourceConversation.contextCompactedAt
          : null,
      })
      .where(eq(conversations.id, fc.id))
      .run();

    const forkedMessageIds = new Map<string, string>();
    let latestForkedAssistant: {
      messageId: string;
      messageAt: number;
    } | null = null;

    for (const message of messagesToCopy) {
      const forkedMessageId = uuid();
      db.insert(messages)
        .values({
          id: forkedMessageId,
          conversationId: fc.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          metadata: cloneForkMessageMetadata(message.metadata, message.id),
        })
        .run();
      forkedMessageIds.set(message.id, forkedMessageId);

      if (message.role === "assistant") {
        latestForkedAssistant = {
          messageId: forkedMessageId,
          messageAt: message.createdAt,
        };
      }
    }

    const attachmentIdMap = new Map<string, string>();
    for (const message of messagesToCopy) {
      const forkedMessageId = forkedMessageIds.get(message.id);
      if (!forkedMessageId) continue;

      const attachmentLinks = db
        .select({
          attachmentId: messageAttachments.attachmentId,
          position: messageAttachments.position,
        })
        .from(messageAttachments)
        .where(eq(messageAttachments.messageId, message.id))
        .orderBy(messageAttachments.position)
        .all();
      const uncachedAttachmentLinks = attachmentLinks.filter(
        (link) => !attachmentIdMap.has(link.attachmentId),
      );
      const stagingMessageId =
        uncachedAttachmentLinks.length > 0 ? uuid() : null;

      if (stagingMessageId) {
        db.insert(messages)
          .values({
            id: stagingMessageId,
            conversationId: fc.id,
            role: message.role,
            content: "",
            createdAt: message.createdAt,
            metadata: null,
          })
          .run();
      }

      for (const link of attachmentLinks) {
        const cachedAttachmentId = attachmentIdMap.get(link.attachmentId);
        if (cachedAttachmentId) {
          db.insert(messageAttachments)
            .values({
              id: uuid(),
              messageId: forkedMessageId,
              attachmentId: cachedAttachmentId,
              position: link.position,
              createdAt: Date.now(),
            })
            .run();
          continue;
        }

        const scopedAttachmentId = linkAttachmentToMessage(
          stagingMessageId ?? forkedMessageId,
          link.attachmentId,
          link.position,
        );
        attachmentIdMap.set(link.attachmentId, scopedAttachmentId);
      }

      if (stagingMessageId) {
        relinkAttachments([stagingMessageId], forkedMessageId);
        db.delete(messages).where(eq(messages.id, stagingMessageId)).run();
      }

      diskSyncQueue.push({
        conversationId: fc.id,
        messageId: forkedMessageId,
        createdAt: fc.createdAt,
      });
    }

    seedForkedConversationAttention({
      conversationId: fc.id,
      latestAssistantMessageId: latestForkedAssistant?.messageId ?? null,
      latestAssistantMessageAt: latestForkedAssistant?.messageAt ?? null,
    });

    return fc;
  });

  // Disk-view sync runs after commit — file I/O is idempotent and
  // conversation deletion cleans up orphaned directories.
  for (const entry of diskSyncQueue) {
    syncMessageToDisk(entry.conversationId, entry.messageId, entry.createdAt);
  }

  const persistedFork = getConversation(forkedConversation.id);
  if (!persistedFork) {
    throw new Error(
      `Failed to load forked conversation ${forkedConversation.id} after creation`,
    );
  }

  return persistedFork;
}

/**
 * Delete a conversation and all its messages, cleaning up orphaned memory
 * artifacts (embeddings). Returns deleted observation, chunk, and episode IDs
 * so callers can clean up the corresponding Qdrant vector entries.
 */
export function deleteConversation(id: string): DeletedMemoryIds {
  const db = getDb();
  const result: DeletedMemoryIds = {
    deletedObservationIds: [],
    deletedChunkIds: [],
    deletedEpisodeIds: [],
  };

  // Capture createdAt before the transaction deletes the row — needed to
  // resolve the conversation's disk-view directory path after deletion.
  const convBeforeDelete = getConversation(id);
  const createdAtForDiskCleanup = convBeforeDelete?.createdAt;
  const memoryScopeId = convBeforeDelete?.memoryScopeId;
  const isPrivateScope = memoryScopeId?.startsWith("private:") ?? false;

  db.transaction((tx) => {
    // Delete non-cascading tables first.
    tx.delete(llmRequestLogs)
      .where(eq(llmRequestLogs.conversationId, id))
      .run();
    tx.delete(toolInvocations)
      .where(eq(toolInvocations.conversationId, id))
      .run();
    // Cascade deletes message_attachments.
    tx.delete(messages).where(eq(messages.conversationId, id)).run();

    if (isPrivateScope && memoryScopeId) {
      // Sweep conversation starters with this private scopeId.
      tx.delete(conversationStarters)
        .where(eq(conversationStarters.scopeId, memoryScopeId))
        .run();

      // Sweep brief-state tables scoped to this private conversation.
      tx.delete(timeContexts)
        .where(eq(timeContexts.scopeId, memoryScopeId))
        .run();
      tx.delete(openLoops).where(eq(openLoops.scopeId, memoryScopeId)).run();
    }

    // Collect archive table IDs before the cascade delete removes them.
    // Observations and episodes reference conversations with ON DELETE CASCADE,
    // and chunks cascade from observations.
    const observationRows = tx
      .select({ id: memoryObservations.id })
      .from(memoryObservations)
      .where(eq(memoryObservations.conversationId, id))
      .all();
    const observationIds = observationRows.map((r) => r.id);

    if (observationIds.length > 0) {
      // Collect chunk IDs before observations cascade-delete them.
      const chunkRows = tx
        .select({ id: memoryChunks.id })
        .from(memoryChunks)
        .where(inArray(memoryChunks.observationId, observationIds))
        .all();
      const chunkIds = chunkRows.map((r) => r.id);

      // Clean up embeddings for chunks.
      if (chunkIds.length > 0) {
        tx.delete(memoryEmbeddings)
          .where(
            and(
              eq(memoryEmbeddings.targetType, "chunk"),
              inArray(memoryEmbeddings.targetId, chunkIds),
            ),
          )
          .run();
        result.deletedChunkIds.push(...chunkIds);
      }

      // Clean up embeddings for observations.
      tx.delete(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.targetType, "observation"),
            inArray(memoryEmbeddings.targetId, observationIds),
          ),
        )
        .run();
      result.deletedObservationIds.push(...observationIds);
    }

    const episodeRows = tx
      .select({ id: memoryEpisodes.id })
      .from(memoryEpisodes)
      .where(eq(memoryEpisodes.conversationId, id))
      .all();
    const episodeIds = episodeRows.map((r) => r.id);

    if (episodeIds.length > 0) {
      tx.delete(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.targetType, "episode"),
            inArray(memoryEmbeddings.targetId, episodeIds),
          ),
        )
        .run();
      result.deletedEpisodeIds.push(...episodeIds);
    }

    tx.delete(conversations).where(eq(conversations.id, id)).run();
  });

  // Remove the conversation's disk-view directory after the DB transaction
  if (createdAtForDiskCleanup != null) {
    removeConversationDir(id, createdAtForDiskCleanup);
  }

  return result;
}

/**
 * Wipe a conversation and revert all memory changes it caused.
 *
 * Extends `deleteConversation` with:
 * - Cancelling pending memory jobs before deletion
 */
export function wipeConversation(id: string): WipeConversationResult {
  // Step A — Cancel pending memory jobs (before deleting messages, since
  // the cancellation queries join on `messages`).
  const cancelledJobCount = cancelPendingJobsForConversation(id);

  // Step B — Delegate to deleteConversation which handles messages (cascade
  // attachments), llmRequestLogs, toolInvocations, observation/chunk/episode
  // embeddings, and the conversation row.
  const deletedMemoryIds = deleteConversation(id);

  // Step C — Return the combined result.
  return {
    ...deletedMemoryIds,
    cancelledJobCount,
  };
}

/**
 * Delete all private (temporary) conversations and their associated data.
 * Called at daemon startup to clean up ephemeral conversations from previous sessions.
 * Returns the count and aggregated deleted memory IDs for Qdrant cleanup.
 */
export function purgePrivateConversations(): {
  count: number;
  deletedMemory: DeletedMemoryIds;
} {
  const db = getDb();
  const privateConvs = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.conversationType, "private"))
    .all();

  if (privateConvs.length === 0) {
    return {
      count: 0,
      deletedMemory: {
        deletedObservationIds: [],
        deletedChunkIds: [],
        deletedEpisodeIds: [],
      },
    };
  }

  const allDeletedObservationIds: string[] = [];
  const allDeletedChunkIds: string[] = [];
  const allDeletedEpisodeIds: string[] = [];

  for (const conv of privateConvs) {
    const deleted = deleteConversation(conv.id);
    allDeletedObservationIds.push(...deleted.deletedObservationIds);
    allDeletedChunkIds.push(...deleted.deletedChunkIds);
    allDeletedEpisodeIds.push(...deleted.deletedEpisodeIds);
  }

  return {
    count: privateConvs.length,
    deletedMemory: {
      deletedObservationIds: allDeletedObservationIds,
      deletedChunkIds: allDeletedChunkIds,
      deletedEpisodeIds: allDeletedEpisodeIds,
    },
  };
}

export async function addMessage(
  conversationId: string,
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  opts?: { skipIndexing?: boolean },
) {
  const db = getDb();
  const messageId = uuid();

  if (metadata) {
    const result = messageMetadataSchema.safeParse(metadata);
    if (!result.success) {
      log.warn(
        { conversationId, messageId, issues: result.error.issues },
        "Invalid message metadata, storing as-is",
      );
    }
  }

  const metadataStr = metadata ? JSON.stringify(metadata) : undefined;
  const originChannelCandidate =
    metadata && isChannelId(metadata.userMessageChannel)
      ? metadata.userMessageChannel
      : null;
  // Wrap insert + updatedAt bump in a transaction so they're atomic.
  // Retry on SQLITE_BUSY* and SQLITE_IOERR* — covers WAL contention variants
  // (SQLITE_BUSY_SNAPSHOT, SQLITE_BUSY_RECOVERY) and transient disk I/O errors.
  // Timestamp is recomputed each attempt so a late retry doesn't persist a stale updatedAt.
  const MAX_RETRIES = 3;
  let now!: number;
  for (let attempt = 0; ; attempt++) {
    now = monotonicNow();
    try {
      const values = {
        id: messageId,
        conversationId,
        role,
        content,
        createdAt: now,
        ...(metadataStr ? { metadata: metadataStr } : {}),
      };
      db.transaction((tx) => {
        tx.insert(messages).values(values).run();
        if (originChannelCandidate) {
          tx.update(conversations)
            .set({ originChannel: originChannelCandidate })
            .where(
              and(
                eq(conversations.id, conversationId),
                isNull(conversations.originChannel),
              ),
            )
            .run();
        }
        tx.update(conversations)
          .set({ updatedAt: now })
          .where(eq(conversations.id, conversationId))
          .run();
      });
      break;
    } catch (err) {
      const errCode = (err as { code?: string }).code ?? "";
      if (
        attempt < MAX_RETRIES &&
        (errCode.startsWith("SQLITE_BUSY") ||
          errCode.startsWith("SQLITE_IOERR"))
      ) {
        log.warn(
          { attempt, conversationId, code: errCode },
          "addMessage: transient SQLite error, retrying",
        );
        await Bun.sleep(50 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  // Mark the conversation dirty for delayed memory reduction. This runs
  // after the insert transaction succeeds so the reducer knows which
  // conversations have unprocessed messages. The helper preserves the
  // earliest unreduced boundary (no-op when already dirty).
  markConversationMemoryDirty(conversationId, messageId);

  const message = {
    id: messageId,
    conversationId,
    role,
    content,
    createdAt: now,
    ...(metadataStr ? { metadata: metadataStr } : {}),
  };

  if (!opts?.skipIndexing) {
    try {
      const config = getConfig();
      const scopeId = getConversationMemoryScopeId(conversationId);
      const parsed = metadata
        ? messageMetadataSchema.safeParse(metadata)
        : null;
      const provenanceTrustClass = parsed?.success
        ? parsed.data.provenanceTrustClass
        : undefined;
      const automated = parsed?.success ? parsed.data.automated : undefined;
      await indexMessageNow(
        {
          messageId: message.id,
          conversationId: message.conversationId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          scopeId,
          provenanceTrustClass,
          automated,
        },
        config.memory,
      );
    } catch (err) {
      log.warn(
        { err, conversationId, messageId: message.id },
        "Failed to index message for memory",
      );
    }
  }

  if (role === "assistant") {
    try {
      projectAssistantMessage({
        conversationId,
        messageId: message.id,
        messageAt: message.createdAt,
      });
    } catch (err) {
      log.warn(
        { err, conversationId, messageId: message.id },
        "Failed to project assistant message for attention tracking",
      );
    }
  }

  return message;
}

export function getMessages(conversationId: string): MessageRow[] {
  const db = getDb();
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map(parseMessage);
}

/** Fetch a single message by ID, optionally scoped to a specific conversation. */
export function getMessageById(
  messageId: string,
  conversationId?: string,
): MessageRow | null {
  const db = getDb();
  const conditions = [eq(messages.id, messageId)];
  if (conversationId) {
    conditions.push(eq(messages.conversationId, conversationId));
  }
  const row = db
    .select()
    .from(messages)
    .where(and(...conditions))
    .get();
  return row ? parseMessage(row) : null;
}

export function updateConversationTitle(
  id: string,
  title: string,
  isAutoTitle?: number,
): void {
  const db = getDb();
  const set: Record<string, unknown> = { title, updatedAt: Date.now() };
  if (isAutoTitle !== undefined) set.isAutoTitle = isAutoTitle;
  db.update(conversations).set(set).where(eq(conversations.id, id)).run();

  // Update disk view meta.json with the new title
  const conv = getConversation(id);
  if (conv) {
    updateMetaFile(conv);
  }
}

export function updateConversationUsage(
  id: string,
  totalInputTokens: number,
  totalOutputTokens: number,
  totalEstimatedCost: number,
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCost,
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, id))
    .run();
}

export function updateConversationContextWindow(
  id: string,
  contextSummary: string,
  contextCompactedMessageCount: number,
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      contextSummary,
      contextCompactedMessageCount,
      contextCompactedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, id))
    .run();
}

/**
 * Delete all conversations, messages, and related data (tool invocations,
 * memory segments, etc.) from the daemon database.
 * Returns { conversations, messages } counts.
 */
export function clearAll(): { conversations: number; messages: number } {
  const msgCount =
    rawGet<{ c: number }>("SELECT COUNT(*) AS c FROM messages")?.c ?? 0;
  const convCount =
    rawGet<{ c: number }>("SELECT COUNT(*) AS c FROM conversations")?.c ?? 0;

  // Delete in dependency order. Cascades handle tool_invocations, but we
  // explicitly clear non-cascading memory tables too.
  //
  // FTS virtual tables are cleared before their base tables. If an FTS
  // table is corrupted, the DELETE will fail — we drop the associated
  // triggers so that the subsequent base-table DELETEs don't also fail
  // (SQLite triggers are atomic with the triggering statement, so a
  // corrupted FTS table would roll back every base-table DELETE).
  rawExec("DELETE FROM memory_embeddings");
  rawExec("DELETE FROM memory_jobs");
  rawExec("DELETE FROM memory_checkpoints");
  rawExec("DELETE FROM llm_request_logs");
  rawExec("DELETE FROM llm_usage_events");
  rawExec("DELETE FROM message_attachments");
  rawExec("DELETE FROM attachments");
  rawExec("DELETE FROM tool_invocations");
  let messagesFtsCorrupted = false;
  try {
    rawExec("DELETE FROM messages_fts");
  } catch (err) {
    log.warn(
      { err },
      "clearAll: failed to clear messages_fts — dropping triggers so base-table cleanup can proceed",
    );
    rawExec("DROP TRIGGER IF EXISTS messages_fts_ai");
    rawExec("DROP TRIGGER IF EXISTS messages_fts_ad");
    rawExec("DROP TRIGGER IF EXISTS messages_fts_au");
    messagesFtsCorrupted = true;
  }
  rawExec("DELETE FROM messages");
  rawExec("DELETE FROM conversations");

  // Record audit event — lifecycle_events is NOT deleted by clearAll(),
  // so this survives the wipe and provides a permanent trail.
  rawRun(
    `INSERT INTO lifecycle_events (id, event_name, created_at) VALUES (?, ?, ?)`,
    uuid(),
    "conversations_clear_all",
    Date.now(),
  );

  // Rebuild corrupted FTS tables and restore triggers after all base-table
  // DELETEs have completed. Dropping the virtual table clears the corruption,
  // and recreating it + triggers means subsequent writes maintain FTS
  // consistency without requiring a daemon restart.
  if (messagesFtsCorrupted) {
    rawExec("DROP TABLE IF EXISTS messages_fts");
    rawExec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, content)`,
    );
    rawExec(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content); END`,
    );
    rawExec(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE message_id = old.id; END`,
    );
    rawExec(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN DELETE FROM messages_fts WHERE message_id = old.id; INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content); END`,
    );
  }

  // Clear the disk-view conversations directory and recreate it empty
  try {
    rmSync(getConversationsDir(), { recursive: true, force: true });
    mkdirSync(getConversationsDir(), { recursive: true });
  } catch (err) {
    log.warn({ err }, "clearAll: failed to reset conversations directory");
  }

  return { conversations: convCount, messages: msgCount };
}

export function deleteLastExchange(conversationId: string): number {
  const db = getDb();

  // Find the last user message's id
  const lastUserMsg = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
      ),
    )
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .get();

  if (!lastUserMsg) return 0;

  // Use rowid to identify the last user message and everything after it.
  // rowid is monotonically increasing for inserts, so this is safe even if
  // multiple messages share the same millisecond timestamp.
  const rowidSubquery = sql`(SELECT rowid FROM messages WHERE id = ${lastUserMsg.id})`;
  const condition = and(
    eq(messages.conversationId, conversationId),
    sql`rowid >= ${rowidSubquery}`,
  );

  const [{ deleted }] = db
    .select({ deleted: count() })
    .from(messages)
    .where(condition)
    .all();
  if (deleted === 0) return 0;

  // Collect attachment IDs linked to the messages being deleted so we can
  // scope orphan cleanup to only those candidates (not freshly uploaded ones).
  const messageIds = db
    .select({ id: messages.id })
    .from(messages)
    .where(condition)
    .all()
    .map((r) => r.id);
  const candidateAttachmentIds =
    messageIds.length > 0
      ? db
          .select({ attachmentId: messageAttachments.attachmentId })
          .from(messageAttachments)
          .where(inArray(messageAttachments.messageId, messageIds))
          .all()
          .map((r) => r.attachmentId)
          .filter((id): id is string => id != null)
      : [];

  db.transaction((tx) => {
    tx.delete(messages).where(condition).run();
    tx.update(conversations)
      .set({ updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();
  });

  deleteOrphanAttachments(candidateAttachmentIds);

  return deleted;
}

/**
 * IDs collected during message deletion for Qdrant vector cleanup.
 * Callers must delete these from the Qdrant collection after the
 * SQLite transaction commits.
 */
export interface DeletedMemoryIds {
  deletedObservationIds: string[];
  deletedChunkIds: string[];
  deletedEpisodeIds: string[];
}

export interface WipeConversationResult extends DeletedMemoryIds {
  cancelledJobCount: number;
}

/**
 * Update the content of an existing message. Used when consolidating
 * multiple assistant messages into one.
 */
export function updateMessageContent(
  messageId: string,
  newContent: string,
): void {
  const db = getDb();
  db.update(messages)
    .set({ content: newContent })
    .where(eq(messages.id, messageId))
    .run();
}

/**
 * Re-link all attachments from a set of source messages to a target message.
 * Used during message consolidation so that attachments linked to deleted
 * messages survive the ON DELETE CASCADE on message_attachments.
 */
export function relinkAttachments(
  fromMessageIds: string[],
  toMessageId: string,
): number {
  if (fromMessageIds.length === 0) return 0;
  const db = getDb();

  // Count how many links will be moved before updating.
  const [{ total }] = db
    .select({ total: count() })
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, fromMessageIds))
    .all();

  if (total === 0) return 0;

  db.update(messageAttachments)
    .set({ messageId: toMessageId })
    .where(inArray(messageAttachments.messageId, fromMessageIds))
    .run();

  return total;
}

/**
 * Delete a single message by ID without cascading to message_runs or
 * channel_inbound_events. Nullable FK columns in those tables are set to
 * NULL before the message row is removed, so associated run and event
 * records survive.
 *
 * Returns deleted memory IDs so the caller can clean up the
 * corresponding Qdrant vector entries.
 */
export function deleteMessageById(messageId: string): DeletedMemoryIds {
  const db = getDb();
  const result: DeletedMemoryIds = {
    deletedObservationIds: [],
    deletedChunkIds: [],
    deletedEpisodeIds: [],
  };

  // Collect attachment IDs linked to this message before cascade-delete
  // so we can scope orphan cleanup to only those candidates.
  const candidateAttachmentIds = db
    .select({ attachmentId: messageAttachments.attachmentId })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId))
    .all()
    .map((r) => r.attachmentId)
    .filter((id): id is string => id !== undefined);

  db.transaction((tx) => {
    // Detach nullable FK references so the cascade doesn't destroy them.
    tx.update(channelInboundEvents)
      .set({ messageId: null })
      .where(eq(channelInboundEvents.messageId, messageId))
      .run();

    // Now safe to delete — NOT NULL cascades remove message_attachments.
    tx.delete(messages).where(eq(messages.id, messageId)).run();
  });

  deleteOrphanAttachments(candidateAttachmentIds);

  return result;
}

/**
 * Mark a conversation as having unreduced messages starting from the given
 * message. Sets `memoryDirtyTailSinceMessageId` only when it is currently
 * null so the earliest unreduced boundary is preserved across multiple
 * messages — later messages must not clobber the original dirty marker.
 *
 * Also upserts a pending `reduce_conversation_memory` job scheduled at
 * `now + idleDelayMs`. If a pending job for this conversation already exists,
 * its `runAfter` is pushed forward (rescheduled) so the reducer waits for
 * the full idle window after the *latest* message — avoiding premature runs
 * while the user is still actively typing.
 */
export function markConversationMemoryDirty(
  conversationId: string,
  messageId: string,
): void {
  const db = getDb();
  db.update(conversations)
    .set({ memoryDirtyTailSinceMessageId: messageId })
    .where(
      and(
        eq(conversations.id, conversationId),
        isNull(conversations.memoryDirtyTailSinceMessageId),
      ),
    )
    .run();

  // Schedule (or reschedule) a deferred reducer job for this conversation.
  scheduleReducerJob(conversationId);
}

/**
 * Upsert a pending `reduce_conversation_memory` job for the given
 * conversation, scheduled `idleDelayMs` from now. If one already exists in
 * pending state, its `runAfter` is pushed forward to restart the idle timer.
 * This ensures exactly one pending reducer job per conversation — new
 * messages reschedule rather than duplicate.
 */
export function scheduleReducerJob(
  conversationId: string,
  runAfter?: number,
): void {
  const idleDelayMs = getReducerIdleDelayMs();
  const scheduledAt = runAfter ?? Date.now() + idleDelayMs;

  const existing = rawGet<{ id: string; status: string }>(
    `SELECT id, status FROM memory_jobs
     WHERE type = 'reduce_conversation_memory'
       AND json_extract(payload, '$.conversationId') = ?
       AND status = 'pending'
     LIMIT 1`,
    conversationId,
  );

  if (existing) {
    // Reschedule: push runAfter forward so the idle timer resets.
    rawRun(
      `UPDATE memory_jobs SET run_after = ?, updated_at = ? WHERE id = ?`,
      scheduledAt,
      Date.now(),
      existing.id,
    );
  } else {
    enqueueMemoryJob(
      "reduce_conversation_memory",
      { conversationId },
      scheduledAt,
    );
  }
}

/**
 * Startup sweep: find conversations that are marked dirty and whose tail
 * message is already older than the idle delay. For these conversations the
 * reducer should have run but didn't (daemon was down). Enqueue immediate
 * reducer jobs for each so they are processed on the next worker tick.
 *
 * Conversations whose tail is still within the idle window are skipped —
 * the normal `markConversationMemoryDirty` path will schedule them when
 * new messages arrive (or on the next conversation interaction).
 *
 * Returns the number of jobs enqueued.
 */
export function sweepStaleReducerJobs(): number {
  const idleDelayMs = getReducerIdleDelayMs();
  const cutoff = Date.now() - idleDelayMs;

  // Find dirty conversations whose latest message is older than the idle
  // window AND that don't already have a pending reducer job.
  const stale = rawAll<{ conversationId: string }>(
    `SELECT c.id AS conversationId
     FROM conversations c
     WHERE c.memory_dirty_tail_since_message_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM memory_jobs mj
         WHERE mj.type = 'reduce_conversation_memory'
           AND json_extract(mj.payload, '$.conversationId') = c.id
           AND mj.status IN ('pending', 'running')
       )
       AND (
         SELECT MAX(m.created_at) FROM messages m
         WHERE m.conversation_id = c.id
       ) <= ?`,
    cutoff,
  );

  for (const { conversationId } of stale) {
    enqueueMemoryJob("reduce_conversation_memory", { conversationId });
  }

  return stale.length;
}

function getReducerIdleDelayMs(): number {
  // Some test suites mock getConfig() with partial objects; fall back to the
  // schema default so reducer scheduling stays stable outside full config load.
  const config = getConfig() as {
    memory?: {
      simplified?: {
        reducer?: {
          idleDelayMs?: number;
        };
      };
    };
  };
  return config.memory?.simplified?.reducer?.idleDelayMs ?? 30_000;
}

export function setConversationOriginChannelIfUnset(
  conversationId: string,
  channel: ChannelId,
): void {
  const db = getDb();
  db.update(conversations)
    .set({ originChannel: channel })
    .where(
      and(
        eq(conversations.id, conversationId),
        isNull(conversations.originChannel),
      ),
    )
    .run();
}

export function getConversationOriginChannel(
  conversationId: string,
): ChannelId | null {
  const db = getDb();
  const row = db
    .select({ originChannel: conversations.originChannel })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return parseChannelId(row?.originChannel) ?? null;
}

export function setConversationOriginInterfaceIfUnset(
  conversationId: string,
  interfaceId: InterfaceId,
): void {
  const db = getDb();
  db.update(conversations)
    .set({ originInterface: interfaceId })
    .where(
      and(
        eq(conversations.id, conversationId),
        isNull(conversations.originInterface),
      ),
    )
    .run();
}

export function getConversationOriginInterface(
  conversationId: string,
): InterfaceId | null {
  const db = getDb();
  const row = db
    .select({ originInterface: conversations.originInterface })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return parseInterfaceId(row?.originInterface) ?? null;
}

/**
 * Return the most recent non-null provenanceTrustClass from user messages
 * in the given conversation, or `undefined` if none is found.
 *
 * Used by the pointer message trust resolver to detect conversations
 * whose audience is a guardian or trusted_contact (even if the
 * conversation itself isn't a desktop-origin private conversation).
 */
export function getConversationRecentProvenanceTrustClass(
  conversationId: string,
): "guardian" | "trusted_contact" | "unknown" | undefined {
  const row = rawGet<{ metadata: string | null }>(
    `SELECT metadata FROM messages
     WHERE conversation_id = ? AND role = 'user' AND metadata IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    conversationId,
  );
  if (!row?.metadata) return undefined;
  try {
    const parsed = messageMetadataSchema.safeParse(JSON.parse(row.metadata));
    return parsed.success ? parsed.data.provenanceTrustClass : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// CRUD functions for display_order and is_pinned
// ---------------------------------------------------------------------------

export function batchSetDisplayOrders(
  updates: Array<{
    id: string;
    displayOrder: number | null;
    isPinned: boolean;
  }>,
): void {
  ensureDisplayOrderMigration();
  rawExec("BEGIN");
  try {
    for (const update of updates) {
      rawRun(
        "UPDATE conversations SET display_order = ?, is_pinned = ? WHERE id = ?",
        update.displayOrder,
        update.isPinned ? 1 : 0,
        update.id,
      );
    }
    rawExec("COMMIT");
  } catch (err) {
    rawExec("ROLLBACK");
    throw err;
  }
}

export function getDisplayMetaForConversations(
  conversationIds: string[],
): Map<string, { displayOrder: number | null; isPinned: boolean }> {
  ensureDisplayOrderMigration();
  const result = new Map<
    string,
    { displayOrder: number | null; isPinned: boolean }
  >();
  if (conversationIds.length === 0) return result;
  for (const id of conversationIds) {
    const row = rawGet<{
      display_order: number | null;
      is_pinned: number | null;
    }>("SELECT display_order, is_pinned FROM conversations WHERE id = ?", id);
    result.set(id, {
      displayOrder: row?.display_order ?? null,
      isPinned: (row?.is_pinned ?? 0) === 1,
    });
  }
  return result;
}

// ── Turn boundary resolution ─────────────────────────────────────────

/**
 * Returns `true` if a message is a tool-result user message — i.e. its
 * role is "user" and its content is a JSON array where every block has
 * `type === "tool_result"`. These synthetic user messages are injected
 * between assistant messages within a single agent turn and should NOT
 * be treated as turn boundaries.
 */
function isToolResultMessage(role: string, content: string): boolean {
  if (role !== "user") return false;
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.every(
      (block: unknown) =>
        block != null &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "tool_result",
    );
  } catch {
    return false;
  }
}

/**
 * Resolve all assistant message IDs that belong to the same agent turn
 * as the given `messageId`. A "turn" is bounded by:
 *   - The start of the conversation, or
 *   - A user message whose content is NOT a tool_result array.
 *
 * Within a multi-step agent loop, the pattern is:
 *   user msg → assistant A1 → user (tool_result) → assistant A2 → ...
 * All assistant messages from A1 through the queried message (and beyond,
 * up to the next real user message) are part of the same turn.
 *
 * Returns `[messageId]` as a fallback if the message is not found,
 * preserving backward compatibility for callers.
 */
export function getAssistantMessageIdsInTurn(messageId: string): string[] {
  const db = getDb();

  // Look up the target message to get its conversationId and createdAt.
  const target = getMessageById(messageId);
  if (!target) return [messageId];

  // Walk backward from the target message to find the turn boundary.
  // Limit to 50 rows — sufficient for even aggressive tool-use loops.
  const backwardRows = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, target.conversationId),
        lte(messages.createdAt, target.createdAt),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(50)
    .all();

  const assistantIds: string[] = [];
  let boundaryCreatedAt: number | null = null;

  for (const row of backwardRows) {
    if (row.role === "assistant") {
      assistantIds.push(row.id);
    } else if (row.role === "user") {
      if (isToolResultMessage(row.role, row.content)) {
        // Tool-result user message — still within the same turn, continue.
        continue;
      }
      // Real user message — this is the turn boundary.
      boundaryCreatedAt = row.createdAt;
      break;
    }
  }

  // Walk forward from the target to collect any later assistant messages
  // still within the same turn (e.g. when querying an intermediate
  // message like A1 in a multi-step turn A1 → tool_result → A2).
  const forwardRows = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, target.conversationId),
        gt(messages.createdAt, target.createdAt),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(50)
    .all();

  for (const row of forwardRows) {
    if (row.role === "assistant") {
      if (!assistantIds.includes(row.id)) {
        assistantIds.push(row.id);
      }
    } else if (row.role === "user") {
      if (isToolResultMessage(row.role, row.content)) {
        // Tool-result user message — still within the same turn.
        continue;
      }
      // Real user message — end of the turn.
      break;
    }
  }

  // Also query forward from the backward-walk boundary to pick up any
  // assistant messages between the boundary and the target that may have
  // been missed (e.g. due to the 50-row limit in the backward walk).
  if (boundaryCreatedAt != null) {
    const gapRows = db
      .select({
        id: messages.id,
        role: messages.role,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, target.conversationId),
          gt(messages.createdAt, boundaryCreatedAt),
          lte(messages.createdAt, target.createdAt),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .all();

    for (const row of gapRows) {
      if (row.role === "assistant" && !assistantIds.includes(row.id)) {
        assistantIds.push(row.id);
      }
    }
  }

  // Sort by createdAt to ensure stable ordering.
  // Re-fetch createdAt for all collected IDs so the sort is accurate.
  if (assistantIds.length <= 1) return assistantIds;

  const idSet = new Set(assistantIds);
  const sorted = db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, target.conversationId),
        inArray(messages.id, [...idSet]),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .all();

  return sorted.map((r) => r.id);
}

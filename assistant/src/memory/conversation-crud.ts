import { mkdirSync, rmSync } from "node:fs";

import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { z } from "zod";

import type { ChannelId, InterfaceId } from "../channels/types.js";
import { parseChannelId, parseInterfaceId } from "../channels/types.js";
import { CHANNEL_IDS, INTERFACE_IDS, isChannelId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { getLogger } from "../util/logger.js";
import { getConversationsDir } from "../util/platform.js";
import { createRowMapper } from "../util/row-mapper.js";
import { deleteOrphanAttachments } from "./attachments-store.js";
import { projectAssistantMessage } from "./conversation-attention-store.js";
import {
  initConversationDir,
  removeConversationDir,
  updateMetaFile,
} from "./conversation-disk-view.js";
import { ensureDisplayOrderMigration } from "./conversation-display-order-migration.js";
import { getDb, rawAll, rawExec, rawGet, rawRun } from "./db.js";
import { indexMessageNow } from "./indexer.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import {
  channelInboundEvents,
  conversations,
  llmRequestLogs,
  memoryEmbeddings,
  memoryItems,
  memoryItemSources,
  memorySegments,
  memorySummaries,
  messageAttachments,
  messages,
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
    /** Image source paths from desktop attachments, keyed by filename. */
    imageSourcePaths: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

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
  isAutoTitle: number;
  scheduleJobId: string | null;
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
  isAutoTitle: "isAutoTitle",
  scheduleJobId: "scheduleJobId",
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

/**
 * Delete a conversation and all its messages, cleaning up orphaned memory
 * artifacts (items, embeddings). Returns segment and orphaned item IDs so
 * callers can clean up the corresponding Qdrant vector entries.
 */
export function deleteConversation(id: string): DeletedMemoryIds {
  const db = getDb();
  const result: DeletedMemoryIds = { segmentIds: [], orphanedItemIds: [] };

  // Capture createdAt before the transaction deletes the row — needed to
  // resolve the conversation's disk-view directory path after deletion.
  const convBeforeDelete = getConversation(id);
  const createdAtForDiskCleanup = convBeforeDelete?.createdAt;

  db.transaction((tx) => {
    // Collect all message IDs for this conversation.
    const messageRows = tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .all();
    const messageIds = messageRows.map((r) => r.id);

    if (messageIds.length > 0) {
      // Collect memory segment IDs linked to these messages before cascade.
      const linkedSegments = tx
        .select({ id: memorySegments.id })
        .from(memorySegments)
        .where(inArray(memorySegments.messageId, messageIds))
        .all();
      result.segmentIds = linkedSegments.map((r) => r.id);

      // Collect memory item IDs linked to these messages before cascade.
      const linkedItems = tx
        .select({ memoryItemId: memoryItemSources.memoryItemId })
        .from(memoryItemSources)
        .where(inArray(memoryItemSources.messageId, messageIds))
        .all();
      const candidateItemIds = [
        ...new Set(linkedItems.map((r) => r.memoryItemId)),
      ];

      // Delete non-cascading tables first.
      tx.delete(llmRequestLogs)
        .where(eq(llmRequestLogs.conversationId, id))
        .run();
      tx.delete(toolInvocations)
        .where(eq(toolInvocations.conversationId, id))
        .run();
      // Cascade deletes memory_segments, memory_item_sources, message_attachments.
      tx.delete(messages).where(eq(messages.conversationId, id)).run();

      // Clean up segment embeddings.
      if (result.segmentIds.length > 0) {
        tx.delete(memoryEmbeddings)
          .where(
            and(
              eq(memoryEmbeddings.targetType, "segment"),
              inArray(memoryEmbeddings.targetId, result.segmentIds),
            ),
          )
          .run();
      }

      // Clean up orphaned memory items whose only sources were in this conversation.
      if (candidateItemIds.length > 0) {
        const surviving = tx
          .select({ memoryItemId: memoryItemSources.memoryItemId })
          .from(memoryItemSources)
          .where(inArray(memoryItemSources.memoryItemId, candidateItemIds))
          .all();
        const survivingIds = new Set(surviving.map((r) => r.memoryItemId));
        const orphanedIds = candidateItemIds.filter(
          (itemId) => !survivingIds.has(itemId),
        );
        result.orphanedItemIds = orphanedIds;

        if (orphanedIds.length > 0) {
          tx.delete(memoryEmbeddings)
            .where(
              and(
                eq(memoryEmbeddings.targetType, "item"),
                inArray(memoryEmbeddings.targetId, orphanedIds),
              ),
            )
            .run();
          tx.delete(memoryItems)
            .where(inArray(memoryItems.id, orphanedIds))
            .run();
        }
      }
    } else {
      // No messages — just clean up non-message tables.
      tx.delete(llmRequestLogs)
        .where(eq(llmRequestLogs.conversationId, id))
        .run();
      tx.delete(toolInvocations)
        .where(eq(toolInvocations.conversationId, id))
        .run();
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
 * - Restoring memory items that were explicitly superseded by items from this conversation
 * - Restoring orphaned subject-match superseded items after deletion
 * - Deleting conversation-scoped memory summaries and their embeddings
 * - Enqueuing `embed_item` jobs for all restored items
 */
export function wipeConversation(id: string): WipeConversationResult {
  const db = getDb();
  const unsupersededItemIds: string[] = [];
  const deletedSummaryIds: string[] = [];

  // Step A — Cancel pending memory jobs (before deleting messages, since
  // the cancellation queries join on `messages`).
  const cancelledJobCount = cancelPendingJobsForConversation(id);

  // Step B — Un-supersede memory items with explicit `supersededBy` links.
  // Find memory items whose `superseded_by` points to an item sourced
  // exclusively from this conversation.
  const explicitSuperseded = rawAll<{ oldItemId: string }>(
    `SELECT DISTINCT mi_old.id AS oldItemId
     FROM memory_items mi_old
     JOIN memory_items mi_new ON mi_old.superseded_by = mi_new.id
     WHERE mi_old.status = 'superseded'
       AND mi_new.id IN (
         SELECT mis.memory_item_id
         FROM memory_item_sources mis
         JOIN messages m ON m.id = mis.message_id
         WHERE m.conversation_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM memory_item_sources mis2
         JOIN messages m2 ON m2.id = mis2.message_id
         WHERE mis2.memory_item_id = mi_new.id
           AND m2.conversation_id != ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM memory_items mi_active
         WHERE mi_active.kind = mi_old.kind
           AND mi_active.subject = mi_old.subject
           AND mi_active.scope_id = mi_old.scope_id
           AND mi_active.status = 'active'
           AND mi_active.id != mi_old.id
           -- Exclude items sourced exclusively from the conversation being
           -- wiped — deleteConversation will remove them, so they should not
           -- block restoration of mi_old.
           AND NOT (
             EXISTS (
               SELECT 1 FROM memory_item_sources mis_a
               JOIN messages m_a ON m_a.id = mis_a.message_id
               WHERE mis_a.memory_item_id = mi_active.id
                 AND m_a.conversation_id = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM memory_item_sources mis_b
               JOIN messages m_b ON m_b.id = mis_b.message_id
               WHERE mis_b.memory_item_id = mi_active.id
                 AND m_b.conversation_id != ?
             )
           )
       )`,
    id,
    id,
    id,
    id,
  );
  for (const { oldItemId } of explicitSuperseded) {
    rawRun(
      "UPDATE memory_items SET status = 'active', superseded_by = NULL WHERE id = ?",
      oldItemId,
    );
    enqueueMemoryJob("embed_item", { itemId: oldItemId });
    unsupersededItemIds.push(oldItemId);
  }

  // Step C — Delete conversation-scoped memory summaries and their embeddings.
  const summaryRows = db
    .select({ id: memorySummaries.id })
    .from(memorySummaries)
    .where(
      and(
        eq(memorySummaries.scope, "conversation"),
        eq(memorySummaries.scopeKey, id),
      ),
    )
    .all();
  const summaryIds = summaryRows.map((r) => r.id);
  if (summaryIds.length > 0) {
    db.delete(memoryEmbeddings)
      .where(
        and(
          eq(memoryEmbeddings.targetType, "summary"),
          inArray(memoryEmbeddings.targetId, summaryIds),
        ),
      )
      .run();
    db.delete(memorySummaries)
      .where(inArray(memorySummaries.id, summaryIds))
      .run();
  }
  deletedSummaryIds.push(...summaryIds);

  // Step D — Get the conversation's memoryScopeId before deletion.
  const scopeId = getConversationMemoryScopeId(id);

  // Step D.5 — Collect kind + subject pairs of items that will be orphaned
  // by deleteConversation. These are items sourced from this conversation's
  // messages that have NO sources from any other conversation. We need this
  // before deletion so we can scope Step F to only restore superseded items
  // matching the specific kind + subject pairs that just lost their active
  // replacement.
  const orphanedKindSubjects = rawAll<{ kind: string; subject: string }>(
    `SELECT DISTINCT mi.kind, mi.subject
     FROM memory_items mi
     JOIN memory_item_sources mis ON mis.memory_item_id = mi.id
     JOIN messages m ON m.id = mis.message_id
     WHERE m.conversation_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM memory_item_sources mis2
         JOIN messages m2 ON m2.id = mis2.message_id
         WHERE mis2.memory_item_id = mi.id
           AND m2.conversation_id != ?
       )`,
    id,
    id,
  );

  // Step E — Delegate to deleteConversation which handles messages (cascade
  // segments, item_sources, attachments), llmRequestLogs, toolInvocations,
  // orphaned memory items + embeddings, and the conversation row.
  const deletedMemoryIds = deleteConversation(id);

  // Step F — Restore orphaned subject-match superseded items. After
  // deleteConversation removes superseding items, find superseded items
  // with no supersededBy link where no active item with the same
  // kind + subject + scope_id exists. Scoped to only the kind + subject
  // pairs of items that were just orphaned by deleteConversation, so we
  // don't accidentally restore items superseded by unrelated conversations.
  let orphanedSuperseded: Array<{ id: string }> = [];
  if (orphanedKindSubjects.length > 0) {
    const placeholders = orphanedKindSubjects.map(() => "(?, ?)").join(", ");
    const params: Array<string> = [scopeId];
    for (const { kind, subject } of orphanedKindSubjects) {
      params.push(kind, subject);
    }
    orphanedSuperseded = rawAll<{ id: string }>(
      `SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY kind, subject, scope_id
           ORDER BY last_seen_at DESC
         ) AS rn
         FROM memory_items
         WHERE status = 'superseded'
           AND superseded_by IS NULL
           AND scope_id = ?
           AND (kind, subject) IN (VALUES ${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM memory_items mi2
             WHERE mi2.kind = memory_items.kind
               AND mi2.subject = memory_items.subject
               AND mi2.scope_id = memory_items.scope_id
               AND mi2.status = 'active'
               AND mi2.id != memory_items.id
           )
       ) WHERE rn = 1`,
      ...params,
    );
  }
  for (const { id: itemId } of orphanedSuperseded) {
    rawRun("UPDATE memory_items SET status = 'active' WHERE id = ?", itemId);
    enqueueMemoryJob("embed_item", { itemId });
    unsupersededItemIds.push(itemId);
  }

  // Step G — Return the combined result.
  return {
    ...deletedMemoryIds,
    unsupersededItemIds,
    deletedSummaryIds,
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
    return { count: 0, deletedMemory: { segmentIds: [], orphanedItemIds: [] } };
  }

  const allSegmentIds: string[] = [];
  const allOrphanedItemIds: string[] = [];

  for (const conv of privateConvs) {
    const deleted = deleteConversation(conv.id);
    allSegmentIds.push(...deleted.segmentIds);
    allOrphanedItemIds.push(...deleted.orphanedItemIds);
  }

  return {
    count: privateConvs.length,
    deletedMemory: {
      segmentIds: allSegmentIds,
      orphanedItemIds: allOrphanedItemIds,
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

  // Delete in dependency order. Cascades handle memory_segments,
  // memory_item_sources, and tool_invocations, but we explicitly
  // clear non-cascading memory tables too.
  //
  // FTS virtual tables are cleared before their base tables. If an FTS
  // table is corrupted, the DELETE will fail — we drop the associated
  // triggers so that the subsequent base-table DELETEs don't also fail
  // (SQLite triggers are atomic with the triggering statement, so a
  // corrupted FTS table would roll back every base-table DELETE).
  rawExec("DELETE FROM memory_item_sources");
  rawExec("DELETE FROM memory_segments");
  rawExec("DELETE FROM memory_items");
  rawExec("DELETE FROM memory_summaries");
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
  segmentIds: string[];
  orphanedItemIds: string[];
}

export interface WipeConversationResult extends DeletedMemoryIds {
  unsupersededItemIds: string[];
  deletedSummaryIds: string[];
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
 * Also cleans up derived memory_items: if the memory worker has already
 * processed an extract_items job for this message, deleting the message
 * cascades memory_item_sources but leaves the memory_items active.
 * Without cleanup, those items would leak into summaries and recall.
 * We delete any memory_items that become orphaned (no remaining sources)
 * after this message is removed.
 *
 * Returns segment and orphaned item IDs so the caller can clean up the
 * corresponding Qdrant vector entries.
 */
export function deleteMessageById(messageId: string): DeletedMemoryIds {
  const db = getDb();
  const result: DeletedMemoryIds = { segmentIds: [], orphanedItemIds: [] };

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
    // Collect memory segment IDs linked to this message before cascade.
    const linkedSegments = tx
      .select({ id: memorySegments.id })
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();
    result.segmentIds = linkedSegments.map((r) => r.id);

    // Collect memory item IDs linked to this message before cascade.
    const linkedItems = tx
      .select({ memoryItemId: memoryItemSources.memoryItemId })
      .from(memoryItemSources)
      .where(eq(memoryItemSources.messageId, messageId))
      .all();
    const candidateItemIds = linkedItems.map((r) => r.memoryItemId);

    // Detach nullable FK references so the cascade doesn't destroy them.
    tx.update(channelInboundEvents)
      .set({ messageId: null })
      .where(eq(channelInboundEvents.messageId, messageId))
      .run();

    // Now safe to delete — NOT NULL cascades remove memory_item_sources,
    // memory_segments, and message_attachments.
    tx.delete(messages).where(eq(messages.id, messageId)).run();

    // Clean up segment embeddings from SQLite (Qdrant cleanup is the caller's job).
    if (result.segmentIds.length > 0) {
      tx.delete(memoryEmbeddings)
        .where(
          and(
            eq(memoryEmbeddings.targetType, "segment"),
            inArray(memoryEmbeddings.targetId, result.segmentIds),
          ),
        )
        .run();
    }

    // Clean up orphaned memory items whose only source was this message.
    if (candidateItemIds.length > 0) {
      // Find which items still have at least one remaining source.
      const surviving = tx
        .select({ memoryItemId: memoryItemSources.memoryItemId })
        .from(memoryItemSources)
        .where(inArray(memoryItemSources.memoryItemId, candidateItemIds))
        .all();
      const survivingIds = new Set(surviving.map((r) => r.memoryItemId));
      const orphanedIds = candidateItemIds.filter(
        (id) => !survivingIds.has(id),
      );
      result.orphanedItemIds = orphanedIds;

      if (orphanedIds.length > 0) {
        // Delete embeddings referencing these items.
        tx.delete(memoryEmbeddings)
          .where(
            and(
              eq(memoryEmbeddings.targetType, "item"),
              inArray(memoryEmbeddings.targetId, orphanedIds),
            ),
          )
          .run();
        // Delete the orphaned memory items themselves.
        tx.delete(memoryItems)
          .where(inArray(memoryItems.id, orphanedIds))
          .run();
      }
    }
  });

  deleteOrphanAttachments(candidateAttachmentIds);

  return result;
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

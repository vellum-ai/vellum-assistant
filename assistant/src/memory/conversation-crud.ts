import { mkdirSync, rmSync } from "node:fs";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
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
import { AUTO_ANALYSIS_SOURCE } from "./auto-analysis-guard.js";
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
import { ensureGroupMigration } from "./conversation-group-migration.js";
import { getDb, rawExec, rawGet, rawRun } from "./db.js";
import { indexMessageNow } from "./indexer.js";
import {
  channelInboundEvents,
  conversations,
  conversationStarters,
  llmRequestLogs,
  memoryEmbeddings,
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
  status: z.enum(["running", "completed", "failed", "aborted"]),
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
  hostAccess: number;
  isAutoTitle: number;
  scheduleJobId: string | null;
  lastMessageAt: number | null;
  archivedAt: number | null;
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
  hostAccess: "hostAccess",
  isAutoTitle: "isAutoTitle",
  scheduleJobId: "scheduleJobId",
  lastMessageAt: "lastMessageAt",
  archivedAt: "archivedAt",
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
        conversationType?: "standard" | "private" | "background" | "scheduled";
        source?: string;
        scheduleJobId?: string;
        groupId?: string;
        hostAccess?: boolean;
        forkParentConversationId?: string;
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
  const groupId = opts.groupId;
  const id = uuid();
  const memoryScopeId =
    conversationType === "private" ? `private:${id}` : "default";

  // Ensure group_id column exists for deterministic schema readiness,
  // even when this conversation has no groupId (a subsequent query or
  // reorder may reference the column).
  ensureGroupMigration();

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
    hostAccess: opts.hostAccess ? 1 : 0,
    conversationType,
    source,
    memoryScopeId,
    scheduleJobId: opts.scheduleJobId ?? null,
    forkParentConversationId: opts.forkParentConversationId ?? null,
  };

  // Retry on SQLITE_BUSY and SQLITE_IOERR — transient disk I/O errors or WAL
  // contention can cause the first attempt to fail even under normal load.
  // INSERT and group_id UPDATE are retried independently so a transient failure
  // on the UPDATE doesn't re-execute the already-succeeded INSERT (which would
  // hit a unique constraint violation).
  // No explicit BEGIN/COMMIT here — callers that need atomicity (e.g.
  // forkConversation) wrap in their own transaction, and nesting raw BEGIN
  // inside Drizzle's db.transaction() would crash SQLite.
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
          "createConversation: INSERT transient error, retrying",
        );
        Bun.sleepSync(50 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  // group_id is NOT in the Drizzle schema (raw-query-only pattern).
  // Set via raw SQL after the INSERT succeeds.
  // Always set group_id — default to "system:all" when none provided.
  {
    const effectiveGroupId = groupId ?? "system:all";
    for (let attempt = 0; ; attempt++) {
      try {
        rawRun(
          "UPDATE conversations SET group_id = ?, is_pinned = ? WHERE id = ?",
          effectiveGroupId,
          effectiveGroupId === "system:pinned" ? 1 : 0,
          id,
        );
        break;
      } catch (err) {
        const code = (err as { code?: string }).code ?? "";
        if (
          attempt < MAX_RETRIES &&
          (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR"))
        ) {
          log.warn(
            { attempt, conversationId: id, code },
            "createConversation: group_id UPDATE transient error, retrying",
          );
          Bun.sleepSync(50 * (attempt + 1));
          continue;
        }
        throw err;
      }
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

/**
 * Count conversations that reference a given schedule job ID.
 * Useful for determining whether a schedule can be safely deleted
 * (i.e. no other conversations still reference it).
 */
export function countConversationsByScheduleJobId(
  scheduleJobId: string,
): number {
  return (
    rawGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM conversations WHERE schedule_job_id = ?",
      scheduleJobId,
    )?.c ?? 0
  );
}

/**
 * Find the rolling analysis conversation for a given source conversation,
 * or null if none exists yet. Used by the auto-analyze loop to append
 * to an existing analysis conversation rather than creating a new one
 * each time the analyze job fires.
 *
 * Returns the most recently updated match if multiple exist (defensive —
 * shouldn't happen in normal operation but the contract is well-defined).
 *
 * Hits `idx_conversations_fork_parent_conversation_id` for the
 * `forkParentConversationId` lookup.
 */
export function findAnalysisConversationFor(
  parentConversationId: string,
): { id: string } | null {
  const db = getDb();
  const row = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.source, AUTO_ANALYSIS_SOURCE),
        eq(conversations.forkParentConversationId, parentConversationId),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  return row ? { id: row.id } : null;
}

/**
 * Returns the `source` column for the given conversation, or null if
 * not found. Tiny convenience used by the recursion guard in the
 * auto-analyze loop.
 */
export function getConversationSource(
  conversationId: string,
): string | null {
  const db = getDb();
  const row = db
    .select({ source: conversations.source })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.source ?? null;
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

export function getConversationHostAccess(conversationId: string): boolean {
  const conv = getConversation(conversationId);
  return conv?.hostAccess === 1;
}

/**
 * Fetch group_id for a conversation via raw SQL. group_id is NOT in the
 * Drizzle schema (raw-query-only pattern), so ConversationRow doesn't
 * include it. This helper is used by forkConversation to inherit group_id.
 */
export function getConversationGroupId(conversationId: string): string | null {
  ensureGroupMigration();
  const row = rawGet<{ group_id: string | null }>(
    "SELECT group_id FROM conversations WHERE id = ?",
    conversationId,
  );
  return row?.group_id ?? null;
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
  // Inherit group_id from parent via raw SQL helper (group_id is not in Drizzle schema)
  const parentGroupId = getConversationGroupId(conversationId);

  const forkedConversation = db.transaction(() => {
    const fc = createConversation({
      title: forkTitle,
      conversationType: "standard",
      groupId: parentGroupId ?? "system:all",
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

    // Set lastMessageAt to the max createdAt of copied messages so the
    // forked conversation sorts correctly by message recency.
    const lastCopiedMessage = messagesToCopy.at(-1);
    if (lastCopiedMessage) {
      db.update(conversations)
        .set({ lastMessageAt: lastCopiedMessage.createdAt })
        .where(eq(conversations.id, fc.id))
        .run();
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
 * artifacts (embeddings). Returns segment IDs so callers can clean up
 * the corresponding Qdrant vector entries.
 */
export function deleteConversation(id: string): DeletedMemoryIds {
  const db = getDb();
  const result: DeletedMemoryIds = {
    segmentIds: [],
    deletedSummaryIds: [],
  };

  // Capture createdAt before the transaction deletes the row — needed to
  // resolve the conversation's disk-view directory path after deletion.
  const convBeforeDelete = getConversation(id);
  const createdAtForDiskCleanup = convBeforeDelete?.createdAt;
  const memoryScopeId = convBeforeDelete?.memoryScopeId;
  const isPrivateScope = memoryScopeId?.startsWith("private:") ?? false;

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

      // Delete non-cascading tables first.
      tx.delete(llmRequestLogs)
        .where(eq(llmRequestLogs.conversationId, id))
        .run();
      tx.delete(toolInvocations)
        .where(eq(toolInvocations.conversationId, id))
        .run();
      // Cascade deletes memory_segments, message_attachments.
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
    } else {
      // No messages — just clean up non-message tables.
      tx.delete(llmRequestLogs)
        .where(eq(llmRequestLogs.conversationId, id))
        .run();
      tx.delete(toolInvocations)
        .where(eq(toolInvocations.conversationId, id))
        .run();
    }

    if (isPrivateScope && memoryScopeId) {
      // Sweep memory summaries with this private scopeId.
      const scopeSummaries = tx
        .select({ id: memorySummaries.id })
        .from(memorySummaries)
        .where(eq(memorySummaries.scopeId, memoryScopeId))
        .all();
      const scopeSummaryIds = scopeSummaries.map((r) => r.id);

      if (scopeSummaryIds.length > 0) {
        tx.delete(memoryEmbeddings)
          .where(
            and(
              eq(memoryEmbeddings.targetType, "summary"),
              inArray(memoryEmbeddings.targetId, scopeSummaryIds),
            ),
          )
          .run();
        tx.delete(memorySummaries)
          .where(inArray(memorySummaries.id, scopeSummaryIds))
          .run();
        result.deletedSummaryIds.push(...scopeSummaryIds);
      }

      // Sweep conversation starters with this private scopeId.
      tx.delete(conversationStarters)
        .where(eq(conversationStarters.scopeId, memoryScopeId))
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
 * - Deleting conversation-scoped memory summaries and their embeddings
 */
export function wipeConversation(id: string): WipeConversationResult {
  const db = getDb();
  const deletedSummaryIds: string[] = [];

  // Step A — Cancel pending memory jobs (before deleting messages, since
  // the cancellation queries join on `messages`).
  const cancelledJobCount = cancelPendingJobsForConversation(id);

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

  // Step D — Delegate to deleteConversation which handles messages (cascade
  // segments, attachments), llmRequestLogs, toolInvocations,
  // embeddings, and the conversation row.
  const deletedMemoryIds = deleteConversation(id);

  // Step E — Return the combined result.
  return {
    ...deletedMemoryIds,
    deletedSummaryIds: [
      ...deletedSummaryIds,
      ...deletedMemoryIds.deletedSummaryIds,
    ],
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
        segmentIds: [],
        deletedSummaryIds: [],
      },
    };
  }

  const allSegmentIds: string[] = [];
  const allDeletedSummaryIds: string[] = [];

  for (const conv of privateConvs) {
    const deleted = deleteConversation(conv.id);
    allSegmentIds.push(...deleted.segmentIds);
    allDeletedSummaryIds.push(...deleted.deletedSummaryIds);
  }

  return {
    count: privateConvs.length,
    deletedMemory: {
      segmentIds: allSegmentIds,
      deletedSummaryIds: allDeletedSummaryIds,
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
          .set({ updatedAt: now, lastMessageAt: now })
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

export interface PaginatedMessagesResult {
  messages: MessageRow[];
  hasMore: boolean;
}

export function getMessagesPaginated(
  conversationId: string,
  limit: number | undefined,
  beforeTimestamp?: number,
): PaginatedMessagesResult {
  const db = getDb();

  if (limit === undefined) {
    const conditions = [eq(messages.conversationId, conversationId)];
    if (beforeTimestamp !== undefined) {
      conditions.push(lt(messages.createdAt, beforeTimestamp));
    }
    const rows = db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(asc(messages.createdAt))
      .all()
      .map(parseMessage);
    return { messages: rows, hasMore: false };
  }

  const conditions = [eq(messages.conversationId, conversationId)];
  if (beforeTimestamp !== undefined) {
    conditions.push(lt(messages.createdAt, beforeTimestamp));
  }

  const rows = db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1)
    .all()
    .map(parseMessage);

  const hasMore = rows.length > limit;
  if (hasMore) {
    rows.splice(limit);
  }
  rows.reverse();

  return { messages: rows, hasMore };
}

export function getLastAssistantTimestampBefore(
  conversationId: string,
  beforeTimestamp: number,
): number {
  const db = getDb();
  const row = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
        lt(messages.createdAt, beforeTimestamp),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .get();
  return row?.createdAt ?? 0;
}

export function getLastUserTimestampBefore(
  conversationId: string,
  beforeTimestamp: number,
): number {
  const db = getDb();
  const row = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
        lt(messages.createdAt, beforeTimestamp),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .get();
  return row?.createdAt ?? 0;
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

export function updateConversationHostAccess(
  id: string,
  hostAccess: boolean,
): void {
  const db = getDb();
  db.update(conversations)
    .set({
      hostAccess: hostAccess ? 1 : 0,
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, id))
    .run();
}

export function archiveConversation(id: string): boolean {
  const conv = getConversation(id);
  if (!conv) return false;
  const now = Date.now();
  rawRun(
    "UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?",
    now,
    now,
    id,
  );
  return true;
}

export function unarchiveConversation(id: string): boolean {
  const conv = getConversation(id);
  if (!conv) return false;
  const now = Date.now();
  rawRun(
    "UPDATE conversations SET archived_at = NULL, updated_at = ? WHERE id = ?",
    now,
    id,
  );
  return true;
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

  // Delete in dependency order. Cascades handle memory_segments and
  // tool_invocations, but we explicitly clear non-cascading memory
  // tables too.
  //
  // FTS virtual tables are cleared before their base tables. If an FTS
  // table is corrupted, the DELETE will fail — we drop the associated
  // triggers so that the subsequent base-table DELETEs don't also fail
  // (SQLite triggers are atomic with the triggering statement, so a
  // corrupted FTS table would roll back every base-table DELETE).
  rawExec("DELETE FROM memory_segments");
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
    const maxResult = tx
      .select({ maxCreatedAt: sql<number | null>`MAX(${messages.createdAt})` })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .get();
    tx.update(conversations)
      .set({
        updatedAt: Date.now(),
        lastMessageAt: maxResult?.maxCreatedAt ?? null,
      })
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
  deletedSummaryIds: string[];
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
 * Merge `updates` into the metadata JSON of an existing message.
 * Reads the current metadata, shallow-merges the new fields, and writes back.
 */
export function updateMessageMetadata(
  messageId: string,
  updates: Record<string, unknown>,
): void {
  const db = getDb();
  const row = db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  const existing = row?.metadata ? JSON.parse(row.metadata) : {};
  db.update(messages)
    .set({ metadata: JSON.stringify({ ...existing, ...updates }) })
    .where(eq(messages.id, messageId))
    .run();
}

/**
 * Atomically update both `content` and (shallow-merged) `metadata` for a
 * message. Used by edit-propagation paths that need to update the message
 * body and stamp metadata (e.g. `slackMeta.editedAt`) in a single
 * transaction so a partial write cannot leak.
 *
 * `metadataUpdates` is shallow-merged into the existing top-level metadata
 * object. To merge into a nested sub-key (e.g. `slackMeta`), the caller
 * must compute the merged sub-value first and pass `{ slackMeta: merged }`.
 */
export function updateMessageContentAndMetadata(
  messageId: string,
  newContent: string,
  metadataUpdates: Record<string, unknown>,
): void {
  const db = getDb();
  db.transaction((tx) => {
    const row = tx
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();
    const existing = row?.metadata ? JSON.parse(row.metadata) : {};
    tx.update(messages)
      .set({
        content: newContent,
        metadata: JSON.stringify({ ...existing, ...metadataUpdates }),
      })
      .where(eq(messages.id, messageId))
      .run();
  });
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
 * Returns segment IDs so the caller can clean up the corresponding
 * Qdrant vector entries.
 */
export function deleteMessageById(messageId: string): DeletedMemoryIds {
  const db = getDb();
  const result: DeletedMemoryIds = {
    segmentIds: [],
    deletedSummaryIds: [],
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

  // Look up the conversation before the transaction so we can recalculate lastMessageAt.
  const msgRow = db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();

  db.transaction((tx) => {
    // Collect memory segment IDs linked to this message before cascade.
    const linkedSegments = tx
      .select({ id: memorySegments.id })
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();
    result.segmentIds = linkedSegments.map((r) => r.id);

    // Detach nullable FK references so the cascade doesn't destroy them.
    tx.update(channelInboundEvents)
      .set({ messageId: null })
      .where(eq(channelInboundEvents.messageId, messageId))
      .run();

    // Now safe to delete — NOT NULL cascades remove memory_segments
    // and message_attachments.
    tx.delete(messages).where(eq(messages.id, messageId)).run();

    // Recalculate lastMessageAt after deletion.
    if (msgRow) {
      const maxResult = tx
        .select({
          maxCreatedAt: sql<number | null>`MAX(${messages.createdAt})`,
        })
        .from(messages)
        .where(eq(messages.conversationId, msgRow.conversationId))
        .get();
      tx.update(conversations)
        .set({ lastMessageAt: maxResult?.maxCreatedAt ?? null })
        .where(eq(conversations.id, msgRow.conversationId))
        .run();
    }

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
    groupId?: string | null;
  }>,
): void {
  ensureDisplayOrderMigration();
  ensureGroupMigration();
  rawExec("BEGIN");
  try {
    for (const update of updates) {
      if (update.groupId !== undefined) {
        // New client: groupId is authoritative.
        // Derive is_pinned from groupId.
        // Sanitize: if groupId is null or references a deleted/unknown group,
        // fall back to "system:all" to avoid FK violation that would roll back
        // the entire batch.
        let safeGroupId = update.groupId;
        if (safeGroupId === null) {
          safeGroupId = "system:all";
        } else if (
          !rawGet<{ id: string }>(
            "SELECT id FROM conversation_groups WHERE id = ?",
            safeGroupId,
          )
        ) {
          safeGroupId = "system:all";
        }
        rawRun(
          "UPDATE conversations SET display_order = ?, is_pinned = ?, group_id = ? WHERE id = ?",
          update.displayOrder,
          safeGroupId === "system:pinned" ? 1 : 0,
          safeGroupId,
          update.id,
        );
      } else {
        // Old client: no groupId in payload
        // isPinned true -> set group_id = system:pinned
        // isPinned false -> clear group_id ONLY IF currently system:pinned
        //                   otherwise preserve existing group_id
        if (update.isPinned) {
          rawRun(
            "UPDATE conversations SET display_order = ?, is_pinned = 1, group_id = 'system:pinned' WHERE id = ?",
            update.displayOrder,
            update.id,
          );
        } else {
          // Restore system group from source/conversationType when old clients
          // unpin, instead of clearing to NULL (which would lose provenance).
          rawRun(
            `UPDATE conversations SET display_order = ?, is_pinned = 0,
             group_id = CASE WHEN group_id = 'system:pinned' THEN
               CASE
                 WHEN source IN ('schedule', 'reminder') THEN 'system:scheduled'
                 WHEN source IN ('heartbeat', 'task') THEN 'system:background'
                 WHEN conversation_type = 'background' AND COALESCE(source, '') != 'notification' THEN 'system:background'
                 ELSE 'system:all'
               END
             ELSE group_id END
             WHERE id = ?`,
            update.displayOrder,
            update.id,
          );
        }
      }
    }
    rawExec("COMMIT");
  } catch (err) {
    rawExec("ROLLBACK");
    throw err;
  }
}

export function getDisplayMetaForConversations(
  conversationIds: string[],
): Map<
  string,
  { displayOrder: number | null; isPinned: boolean; groupId: string | null }
> {
  ensureDisplayOrderMigration();
  ensureGroupMigration();
  const result = new Map<
    string,
    { displayOrder: number | null; isPinned: boolean; groupId: string | null }
  >();
  if (conversationIds.length === 0) return result;
  for (const id of conversationIds) {
    const row = rawGet<{
      display_order: number | null;
      is_pinned: number | null;
      group_id: string | null;
    }>(
      "SELECT display_order, is_pinned, group_id FROM conversations WHERE id = ?",
      id,
    );
    result.set(id, {
      displayOrder: row?.display_order ?? null,
      isPinned: (row?.is_pinned ?? 0) === 1,
      groupId: row?.group_id ?? null,
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
 * Returns the time boundaries (start/end `createdAt` values) for the turn
 * containing the given message. The bounds span from the real user message
 * that started the turn to just before the real user message that starts the
 * next turn (or to the end of the conversation if this is the last turn).
 *
 * Also extends the end boundary to capture orphaned LLM request logs from
 * deleted intermediate messages (e.g. removed by retry/deleteLastExchange).
 *
 * Returns null if the message is the only one in the conversation.
 */
export function getTurnTimeBounds(
  conversationId: string,
  messageCreatedAt: number,
): { startTime: number; endTime: number } | null {
  const db = getDb();

  // Walk backward (by rowid, not just createdAt) to find the real user
  // message that starts this turn.
  const rowidSubquery = sql`(
    SELECT rowid FROM messages
    WHERE conversation_id = ${conversationId}
      AND created_at <= ${messageCreatedAt}
    ORDER BY rowid DESC LIMIT 1
  )`;
  const backwardRows = db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`rowid <= ${rowidSubquery}`,
      ),
    )
    .orderBy(sql`rowid DESC`)
    .limit(50)
    .all();

  let startTime = messageCreatedAt;
  for (const row of backwardRows) {
    if (row.role === "user" && !isToolResultMessage(row.role, row.content)) {
      startTime = row.createdAt;
      break;
    }
  }

  // Walk forward (by rowid) to find the next real user message.
  const forwardRowidSubquery = sql`(
    SELECT rowid FROM messages
    WHERE conversation_id = ${conversationId}
      AND created_at >= ${messageCreatedAt}
    ORDER BY rowid DESC LIMIT 1
  )`;
  const forwardRows = db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`rowid > ${forwardRowidSubquery}`,
      ),
    )
    .orderBy(sql`rowid ASC`)
    .limit(50)
    .all();

  let endTime = messageCreatedAt;
  let nextTurnStart: number | null = null;
  for (const row of forwardRows) {
    if (row.role === "user" && !isToolResultMessage(row.role, row.content)) {
      nextTurnStart = row.createdAt;
      break;
    }
    endTime = row.createdAt;
  }

  // When the next turn start has a strictly greater timestamp, use it minus
  // 1ms as the hard upper bound. When timestamps collide (e.g. in tests),
  // don't extend — the message-ID-based query is authoritative.
  if (nextTurnStart != null && nextTurnStart > endTime) {
    endTime = nextTurnStart - 1;
  }

  // Extend end boundary to the latest log that falls within the turn window.
  // Orphaned logs from deleted intermediate messages may have timestamps
  // beyond any surviving message. Cap at 30 minutes to avoid sweeping in
  // logs from a much later turn.
  const MAX_TURN_DURATION_MS = 30 * 60 * 1000;
  const hardCeiling =
    nextTurnStart != null && nextTurnStart > startTime
      ? nextTurnStart - 1
      : startTime + MAX_TURN_DURATION_MS;

  if (hardCeiling > endTime) {
    const latestLog = db
      .select({ createdAt: llmRequestLogs.createdAt })
      .from(llmRequestLogs)
      .where(
        and(
          eq(llmRequestLogs.conversationId, conversationId),
          gte(llmRequestLogs.createdAt, startTime),
          lte(llmRequestLogs.createdAt, hardCeiling),
        ),
      )
      .orderBy(desc(llmRequestLogs.createdAt))
      .limit(1)
      .get();

    if (latestLog && latestLog.createdAt > endTime) {
      endTime = latestLog.createdAt;
    }
  }

  return { startTime, endTime };
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

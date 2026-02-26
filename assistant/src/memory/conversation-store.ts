import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

import type { ChannelId, InterfaceId } from '../channels/types.js';
import { parseChannelId, parseInterfaceId } from '../channels/types.js';
import { CHANNEL_IDS, INTERFACE_IDS,isChannelId } from '../channels/types.js';
import { getConfig } from '../config/loader.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import { getLogger } from '../util/logger.js';
import { createRowMapper } from '../util/row-mapper.js';
import { deleteOrphanAttachments } from './attachments-store.js';
import { getDb, rawAll, rawExec,rawGet } from './db.js';
import { indexMessageNow } from './indexer.js';
import { channelInboundEvents, conversations, llmRequestLogs,memoryEmbeddings, memoryItemEntities, memoryItems, memoryItemSources, memorySegments, messageAttachments, messages, toolInvocations } from './schema.js';
import { buildFtsMatchQuery } from './search/lexical.js';

const log = getLogger('conversation-store');

// ── Message metadata Zod schema ──────────────────────────────────────
// Validates the JSON stored in messages.metadata. Known fields are typed;
// extra keys are allowed via passthrough so callers can attach ad-hoc data.

const channelIdSchema = z.enum(CHANNEL_IDS);
const interfaceIdSchema = z.enum(INTERFACE_IDS);

const subagentNotificationSchema = z.object({
  subagentId: z.string(),
  label: z.string(),
  status: z.enum(['completed', 'failed', 'aborted']),
  error: z.string().optional(),
  conversationId: z.string().optional(),
});

export const messageMetadataSchema = z.object({
  userMessageChannel: channelIdSchema.optional(),
  assistantMessageChannel: channelIdSchema.optional(),
  userMessageInterface: interfaceIdSchema.optional(),
  assistantMessageInterface: interfaceIdSchema.optional(),
  subagentNotification: subagentNotificationSchema.optional(),
  // Provenance fields for trust-aware memory gating (M3)
  provenanceActorRole: z.enum(['guardian', 'non-guardian', 'unverified_channel']).optional(),
  provenanceSourceChannel: channelIdSchema.optional(),
  provenanceGuardianExternalUserId: z.string().optional(),
  provenanceRequesterIdentifier: z.string().optional(),
}).passthrough();

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

/**
 * Extract provenance metadata fields from a GuardianRuntimeContext.
 * When no guardian context is provided, defaults to 'unverified_channel'
 * because the absence of guardian context means we cannot verify trust —
 * callers with actual guardian trust should always supply a real context.
 */
export function provenanceFromGuardianContext(ctx: GuardianRuntimeContext | null | undefined): Record<string, unknown> {
  if (!ctx) return { provenanceActorRole: 'unverified_channel' };
  return {
    provenanceActorRole: ctx.actorRole,
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
  threadType: string;
  source: string;
  memoryScopeId: string;
  originChannel: string | null;
  originInterface: string | null;
  isAutoTitle: number;
}

const parseConversation = createRowMapper<typeof conversations.$inferSelect, ConversationRow>({
  id: 'id',
  title: 'title',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  totalInputTokens: 'totalInputTokens',
  totalOutputTokens: 'totalOutputTokens',
  totalEstimatedCost: 'totalEstimatedCost',
  contextSummary: 'contextSummary',
  contextCompactedMessageCount: 'contextCompactedMessageCount',
  contextCompactedAt: 'contextCompactedAt',
  threadType: 'threadType',
  source: 'source',
  memoryScopeId: 'memoryScopeId',
  originChannel: 'originChannel',
  originInterface: 'originInterface',
  isAutoTitle: 'isAutoTitle',
});

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}

const parseMessage = createRowMapper<typeof messages.$inferSelect, MessageRow>({
  id: 'id',
  conversationId: 'conversationId',
  role: 'role',
  content: 'content',
  createdAt: 'createdAt',
  metadata: 'metadata',
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

export function createConversation(titleOrOpts?: string | { title?: string; threadType?: 'standard' | 'private' | 'background'; source?: string }) {
  const db = getDb();
  const now = Date.now();
  const opts = typeof titleOrOpts === 'string' ? { title: titleOrOpts } : (titleOrOpts ?? {});
  const threadType = opts.threadType ?? 'standard';
  const source = opts.source ?? 'user';
  const id = uuid();
  const memoryScopeId = threadType === 'private' ? `private:${id}` : 'default';
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
    threadType,
    source,
    memoryScopeId,
  };
  db.insert(conversations).values(conversation).run();
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

export function getConversationThreadType(conversationId: string): 'standard' | 'private' {
  const conv = getConversation(conversationId);
  const raw = conv?.threadType;
  return raw === 'private' ? 'private' : 'standard';
}

export function getConversationMemoryScopeId(conversationId: string): string {
  const conv = getConversation(conversationId);
  return conv?.memoryScopeId ?? 'default';
}

/**
 * Delete a conversation and all its messages.
 * Used for ephemeral conversations (e.g. secret-redirect placeholders)
 * that should not persist in session history.
 */
export function deleteConversation(id: string): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(llmRequestLogs).where(eq(llmRequestLogs.conversationId, id)).run();
    tx.delete(toolInvocations).where(eq(toolInvocations.conversationId, id)).run();
    tx.delete(messages).where(eq(messages.conversationId, id)).run();
    tx.delete(conversations).where(eq(conversations.id, id)).run();
  });
}

export function listConversations(limit?: number, includeBackground = false, offset = 0): ConversationRow[] {
  const db = getDb();
  const where = includeBackground ? undefined : sql`${conversations.threadType} != 'background'`;
  const query = db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit ?? 100)
    .offset(offset);
  return query.all().map(parseConversation);
}

export function countConversations(includeBackground = false): number {
  const db = getDb();
  const where = includeBackground ? undefined : sql`${conversations.threadType} != 'background'`;
  const [{ total }] = db
    .select({ total: count() })
    .from(conversations)
    .where(where)
    .all();
  return total;
}

export function getLatestConversation(): ConversationRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(conversations)
    .where(sql`${conversations.threadType} != 'background'`)
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  return row ? parseConversation(row) : null;
}

export function addMessage(conversationId: string, role: string, content: string, metadata?: Record<string, unknown>, opts?: { skipIndexing?: boolean }) {
  const db = getDb();
  const messageId = uuid();

  if (metadata) {
    const result = messageMetadataSchema.safeParse(metadata);
    if (!result.success) {
      log.warn({ conversationId, messageId, issues: result.error.issues }, 'Invalid message metadata, storing as-is');
    }
  }

  const metadataStr = metadata ? JSON.stringify(metadata) : undefined;
  const originChannelCandidate =
    metadata && isChannelId(metadata.userMessageChannel)
      ? metadata.userMessageChannel
      : null;
  // Wrap insert + updatedAt bump in a transaction so they're atomic.
  // Retry on SQLITE_BUSY in case busy_timeout is exhausted under heavy contention.
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
            .where(and(eq(conversations.id, conversationId), isNull(conversations.originChannel)))
            .run();
        }
        tx.update(conversations)
          .set({ updatedAt: now })
          .where(eq(conversations.id, conversationId))
          .run();
      });
      break;
    } catch (err) {
      if (attempt < MAX_RETRIES && (err as { code?: string }).code === 'SQLITE_BUSY') {
        log.warn({ attempt, conversationId }, 'addMessage: SQLITE_BUSY, retrying');
        Bun.sleepSync(50 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  const message = { id: messageId, conversationId, role, content, createdAt: now, ...(metadataStr ? { metadata: metadataStr } : {}) };

  if (!opts?.skipIndexing) {
    try {
      const config = getConfig();
      const scopeId = getConversationMemoryScopeId(conversationId);
      const parsed = metadata ? messageMetadataSchema.safeParse(metadata) : null;
      const provenanceActorRole = parsed?.success ? parsed.data.provenanceActorRole : undefined;
      indexMessageNow({
        messageId: message.id,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        scopeId,
        provenanceActorRole,
      }, config.memory);
    } catch (err) {
      log.warn({ err, conversationId, messageId: message.id }, 'Failed to index message for memory');
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
export function getMessageById(messageId: string, conversationId?: string): MessageRow | null {
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

/**
 * Get the next message in a conversation after a given message (by timestamp).
 * Used for legacy tool_result merging in the rehydrate endpoint.
 */
export function getNextMessage(conversationId: string, afterTimestamp: number): MessageRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(messages)
    .where(and(
      eq(messages.conversationId, conversationId),
      gt(messages.createdAt, afterTimestamp),
    ))
    .orderBy(asc(messages.createdAt))
    .limit(1)
    .get();
  return row ? parseMessage(row) : null;
}

export interface PaginatedMessagesResult {
  messages: MessageRow[];
  /** Whether older messages exist beyond the returned page. */
  hasMore: boolean;
}

/**
 * Paginated variant of getMessages. Returns the most recent `limit` messages
 * (optionally before a cursor timestamp), in chronological order.
 *
 * When `limit` is undefined, all matching messages are returned (no pagination).
 * When `beforeMessageId` is provided alongside `beforeTimestamp`, it acts as a
 * tie-breaker to avoid skipping messages that share the same millisecond timestamp
 * at page boundaries.
 */
export function getMessagesPaginated(
  conversationId: string,
  limit: number | undefined,
  beforeTimestamp?: number,
  beforeMessageId?: string,
): PaginatedMessagesResult {
  const db = getDb();
  const conditions = [eq(messages.conversationId, conversationId)];
  if (beforeTimestamp !== undefined) {
    if (beforeMessageId) {
      // Use lte + ne as a compound cursor: include messages at the same
      // millisecond but exclude the specific boundary message already seen.
      conditions.push(lte(messages.createdAt, beforeTimestamp));
      conditions.push(ne(messages.id, beforeMessageId));
    } else {
      // Legacy callers without a message ID tie-breaker: use strict lt.
      // This may skip same-millisecond messages at boundaries, but avoids
      // re-fetching the boundary message. New callers should prefer the
      // compound cursor (beforeTimestamp + beforeMessageId).
      conditions.push(lt(messages.createdAt, beforeTimestamp));
    }
  }

  if (limit === undefined) {
    // Unlimited: return all messages in chronological order, no pagination.
    const rows = db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(asc(messages.createdAt))
      .all()
      .map(parseMessage);
    return { messages: rows, hasMore: false };
  }

  // Fetch limit+1 rows ordered newest-first so we can detect hasMore
  const rows = db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1)
    .all()
    .map(parseMessage);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Return in chronological order (oldest first) for the client
  page.reverse();

  return { messages: page, hasMore };
}

export function updateConversationTitle(id: string, title: string, isAutoTitle?: number): void {
  const db = getDb();
  const set: Record<string, unknown> = { title, updatedAt: Date.now() };
  if (isAutoTitle !== undefined) set.isAutoTitle = isAutoTitle;
  db.update(conversations)
    .set(set)
    .where(eq(conversations.id, id))
    .run();
}

export function updateConversationUsage(
  id: string,
  totalInputTokens: number,
  totalOutputTokens: number,
  totalEstimatedCost: number,
): void {
  const db = getDb();
  db.update(conversations)
    .set({ totalInputTokens, totalOutputTokens, totalEstimatedCost, updatedAt: Date.now() })
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
 * Delete the last user message and any subsequent assistant messages.
 * Uses rowid comparison instead of timestamps to avoid deleting messages
 * that share the same millisecond timestamp.
 * Returns the number of messages deleted.
 */
/**
 * Delete all conversations, messages, and related data (tool invocations,
 * memory segments, etc.) from the daemon database.
 * Returns { conversations, messages } counts.
 */
export function clearAll(): { conversations: number; messages: number } {
  const msgCount = rawGet<{ c: number }>('SELECT COUNT(*) AS c FROM messages')?.c ?? 0;
  const convCount = rawGet<{ c: number }>('SELECT COUNT(*) AS c FROM conversations')?.c ?? 0;

  // Delete in dependency order. Cascades handle memory_segments,
  // memory_item_sources, and tool_invocations, but we explicitly
  // clear non-cascading memory tables too.
  rawExec('DELETE FROM memory_segment_fts');
  rawExec('DELETE FROM memory_item_sources');
  rawExec('DELETE FROM memory_segments');
  rawExec('DELETE FROM memory_items');
  rawExec('DELETE FROM memory_summaries');
  rawExec('DELETE FROM memory_embeddings');
  rawExec('DELETE FROM memory_jobs');
  rawExec('DELETE FROM memory_checkpoints');
  rawExec('DELETE FROM llm_request_logs');
  rawExec('DELETE FROM llm_usage_events');
  rawExec('DELETE FROM message_attachments');
  rawExec('DELETE FROM attachments');
  rawExec('DELETE FROM tool_invocations');
  rawExec('DELETE FROM messages_fts');
  rawExec('DELETE FROM messages');
  rawExec('DELETE FROM conversations');

  return { conversations: convCount, messages: msgCount };
}

/**
 * Check whether the last user message in a conversation is a tool_result-only
 * message (i.e., not a real user-typed message). This is used by undo() to
 * determine if additional exchanges need to be deleted from the DB.
 */
export function isLastUserMessageToolResult(conversationId: string): boolean {
  const db = getDb();
  const lastUserMsg = db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .get();

  if (!lastUserMsg) return false;

  try {
    const parsed = JSON.parse(lastUserMsg.content);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((block: Record<string, unknown>) => block.type === 'tool_result')) {
      return true;
    }
  } catch {
    // Not JSON — it's a plain text user message
  }
  return false;
}

export function deleteLastExchange(conversationId: string): number {
  const db = getDb();

  // Find the last user message's id
  const lastUserMsg = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
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

  const [{ deleted }] = db.select({ deleted: count() }).from(messages).where(condition).all();
  if (deleted === 0) return 0;

  // Collect attachment IDs linked to the messages being deleted so we can
  // scope orphan cleanup to only those candidates (not freshly uploaded ones).
  const messageIds = db.select({ id: messages.id }).from(messages).where(condition).all().map((r) => r.id);
  const candidateAttachmentIds = messageIds.length > 0
    ? db.select({ attachmentId: messageAttachments.attachmentId })
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

/**
 * Update the content of an existing message. Used when consolidating
 * multiple assistant messages into one.
 */
export function updateMessageContent(messageId: string, newContent: string): void {
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
export function relinkAttachments(fromMessageIds: string[], toMessageId: string): number {
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
        .where(and(
          eq(memoryEmbeddings.targetType, 'segment'),
          inArray(memoryEmbeddings.targetId, result.segmentIds),
        ))
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
      const orphanedIds = candidateItemIds.filter((id) => !survivingIds.has(id));
      result.orphanedItemIds = orphanedIds;

      if (orphanedIds.length > 0) {
        // Delete memory_item_entities (no FK cascade on this table).
        tx.delete(memoryItemEntities)
          .where(inArray(memoryItemEntities.memoryItemId, orphanedIds))
          .run();
        // Delete embeddings referencing these items.
        tx.delete(memoryEmbeddings)
          .where(and(
            eq(memoryEmbeddings.targetType, 'item'),
            inArray(memoryEmbeddings.targetId, orphanedIds),
          ))
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

export interface ConversationSearchResult {
  conversationId: string;
  conversationTitle: string | null;
  conversationUpdatedAt: number;
  matchingMessages: Array<{
    messageId: string;
    role: string;
    /** Plain-text excerpt around the match, truncated to ~200 chars. */
    excerpt: string;
    createdAt: number;
  }>;
}

/**
 * Full-text search across message content using FTS5.
 * Uses the messages_fts virtual table for fast tokenized matching on message
 * content, with a LIKE fallback on conversation titles. Returns matching
 * conversations with their relevant messages, ordered by most recently updated.
 */
export function searchConversations(
  query: string,
  opts?: { limit?: number; maxMessagesPerConversation?: number },
): ConversationSearchResult[] {
  if (!query.trim()) return [];

  const db = getDb();
  const limit = opts?.limit ?? 20;
  const maxMsgsPerConv = opts?.maxMessagesPerConversation ?? 3;

  const ftsMatch = buildFtsMatchQuery(query.trim());

  // LIKE pattern for title matching (FTS only covers message content).
  const titlePattern = `%${query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

  interface ConvIdRow {
    conversation_id: string;
  }

  // Collect conversation IDs from FTS message matches and title LIKE matches,
  // then merge them to produce the final set of matching conversations.
  // Both paths LIMIT on distinct conversation_id to prevent a single
  // conversation with many matching messages from crowding out others.
  const ftsConvIds = new Set<string>();
  if (ftsMatch) {
    try {
      const ftsRows = rawAll<ConvIdRow>(`
        SELECT DISTINCT m.conversation_id
        FROM messages_fts f
        JOIN messages m ON m.id = f.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ? AND c.thread_type != 'background'
        LIMIT 1000
      `, ftsMatch);
      for (const row of ftsRows) ftsConvIds.add(row.conversation_id);
    } catch {
      // FTS parse failure — fall through, title matches may still produce results.
    }
  } else if (query.trim()) {
    // FTS tokens were all dropped (non-ASCII, single-char, etc.) — fall back to
    // LIKE-based message content search so queries like "你", "é", or "C++" still
    // match message text.
    const likePattern = `%${query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const likeRows = rawAll<ConvIdRow>(`
      SELECT DISTINCT m.conversation_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.content LIKE ? ESCAPE '\\' AND c.thread_type != 'background'
      LIMIT 1000
    `, likePattern);
    for (const row of likeRows) ftsConvIds.add(row.conversation_id);
  }

  // Title-only matches (FTS doesn't index conversation titles).
  const titleMatchConvs = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        sql`${conversations.threadType} != 'background'`,
        sql`${conversations.title} LIKE ${titlePattern} ESCAPE '\\'`,
      ),
    )
    .all();
  for (const row of titleMatchConvs) ftsConvIds.add(row.id);

  if (ftsConvIds.size === 0) return [];

  // Fetch the matching conversation rows, ordered by updatedAt, capped at limit.
  const convIds = [...ftsConvIds];
  const placeholders = convIds.map(() => '?').join(',');
  interface ConvRow { id: string; title: string | null; updated_at: number }
  const matchingConversations = rawAll<ConvRow>(
    `SELECT id, title, updated_at FROM conversations
     WHERE id IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT ?`,
    ...convIds, limit,
  );

  if (matchingConversations.length === 0) return [];

  const results: ConversationSearchResult[] = [];

  for (const conv of matchingConversations) {
    interface MsgRow { id: string; role: string; content: string; created_at: number }
    let matchingMsgs: MsgRow[] = [];
    if (ftsMatch) {
      try {
        matchingMsgs = rawAll<MsgRow>(`
          SELECT m.id, m.role, m.content, m.created_at
          FROM messages_fts f
          JOIN messages m ON m.id = f.message_id
          WHERE messages_fts MATCH ? AND m.conversation_id = ?
          ORDER BY m.created_at ASC
          LIMIT ?
        `, ftsMatch, conv.id, maxMsgsPerConv);
      } catch {
        // FTS parse failure — no matching messages for this conversation.
      }
    } else if (query.trim()) {
      // LIKE fallback for non-ASCII / short-token queries.
      const msgLikePattern = `%${query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      matchingMsgs = rawAll<MsgRow>(`
        SELECT id, role, content, created_at
        FROM messages
        WHERE conversation_id = ? AND content LIKE ? ESCAPE '\\'
        ORDER BY created_at ASC
        LIMIT ?
      `, conv.id, msgLikePattern, maxMsgsPerConv);
    }

    results.push({
      conversationId: conv.id,
      conversationTitle: conv.title,
      conversationUpdatedAt: conv.updated_at,
      matchingMessages: matchingMsgs.map((m) => ({
        messageId: m.id,
        role: m.role,
        excerpt: buildExcerpt(m.content, query),
        createdAt: m.created_at,
      })),
    });
  }

  return results;
}

/**
 * Build a short excerpt from raw message content centered around the first
 * occurrence of `query`. The content may be JSON (content blocks) or plain
 * text; we extract a readable snippet in either case.
 */
function buildExcerpt(rawContent: string, query: string): string {
  // Try to extract plain text from JSON content blocks first.
  let text = rawContent;
  try {
    const parsed = JSON.parse(rawContent);
    if (Array.isArray(parsed)) {
      const parts: string[] = [];
      for (const block of parsed) {
        if (typeof block === 'object' && block != null) {
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
          } else if (block.type === 'tool_result') {
            const inner = Array.isArray(block.content) ? block.content : [];
            for (const ib of inner) {
              if (ib?.type === 'text' && typeof ib.text === 'string') parts.push(ib.text);
            }
          }
        }
      }
      if (parts.length > 0) text = parts.join(' ');
    } else if (typeof parsed === 'string') {
      text = parsed;
    }
  } catch {
    // Not JSON — use as-is
  }

  const WINDOW = 100;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) {
    // Query matched the raw JSON but not the extracted text — fall back to raw start
    return text.slice(0, WINDOW * 2).replace(/\s+/g, ' ').trim();
  }
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(text.length, idx + query.length + WINDOW);
  const excerpt = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
  return excerpt;
}

export function setConversationOriginChannelIfUnset(conversationId: string, channel: ChannelId): void {
  const db = getDb();
  db.update(conversations)
    .set({ originChannel: channel })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.originChannel)))
    .run();
}

export function getConversationOriginChannel(conversationId: string): ChannelId | null {
  const db = getDb();
  const row = db.select({ originChannel: conversations.originChannel })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return parseChannelId(row?.originChannel) ?? null;
}

export function setConversationOriginInterfaceIfUnset(conversationId: string, interfaceId: InterfaceId): void {
  const db = getDb();
  db.update(conversations)
    .set({ originInterface: interfaceId })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.originInterface)))
    .run();
}

export function getConversationOriginInterface(conversationId: string): InterfaceId | null {
  const db = getDb();
  const row = db.select({ originInterface: conversations.originInterface })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return parseInterfaceId(row?.originInterface) ?? null;
}

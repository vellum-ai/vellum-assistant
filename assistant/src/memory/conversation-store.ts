import { eq, desc, asc, and, count, sql, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb, rawGet, rawExec } from './db.js';
import { conversations, messages, toolInvocations, messageRuns, channelInboundEvents, memoryItemSources, memoryItems, memoryEmbeddings, memoryItemEntities, memorySegments, messageAttachments, llmRequestLogs } from './schema.js';
import { getConfig } from '../config/loader.js';
import { indexMessageNow } from './indexer.js';
import { getLogger } from '../util/logger.js';
import { deleteOrphanAttachments } from './attachments-store.js';

const log = getLogger('conversation-store');

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

export function getConversation(id: string) {
  const db = getDb();
  const result = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  return result ?? null;
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

export function listConversations(limit?: number, includeBackground = false, offset = 0) {
  const db = getDb();
  const where = includeBackground ? undefined : sql`${conversations.threadType} != 'background'`;
  const query = db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit ?? 100)
    .offset(offset);
  return query.all();
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

export function getLatestConversation() {
  const db = getDb();
  const result = db
    .select()
    .from(conversations)
    .where(sql`${conversations.threadType} != 'background'`)
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  return result ?? null;
}

export function addMessage(conversationId: string, role: string, content: string, metadata?: Record<string, unknown>) {
  const db = getDb();
  const messageId = uuid();
  const metadataStr = metadata ? JSON.stringify(metadata) : undefined;
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

  try {
    const config = getConfig();
    const scopeId = getConversationMemoryScopeId(conversationId);
    indexMessageNow({
      messageId: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      scopeId,
    }, config.memory);
  } catch (err) {
    log.warn({ err, conversationId, messageId: message.id }, 'Failed to index message for memory');
  }

  return message;
}

export function getMessages(conversationId: string) {
  const db = getDb();
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();
}

export function updateConversationTitle(id: string, title: string): void {
  const db = getDb();
  db.update(conversations)
    .set({ title, updatedAt: Date.now() })
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
      .filter((id): id is string => id !== null)
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
    .filter((id): id is string => id !== null);

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
    tx.update(messageRuns)
      .set({ messageId: null })
      .where(eq(messageRuns.messageId, messageId))
      .run();
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

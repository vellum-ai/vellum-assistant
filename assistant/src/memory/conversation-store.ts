import { eq, desc, asc, and, count, sql, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { conversations, messages, messageRuns, channelInboundEvents, memoryItemSources, memoryItems, memoryEmbeddings, memoryItemEntities } from './schema.js';
import { getConfig } from '../config/loader.js';
import { indexMessageNow } from './indexer.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('conversation-store');

export function createConversation(title?: string) {
  const db = getDb();
  const now = Date.now();
  const conversation = {
    id: uuid(),
    title: title ?? null,
    createdAt: now,
    updatedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null as string | null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null as number | null,
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

export function listConversations(limit?: number) {
  const db = getDb();
  const query = db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit ?? 100);
  return query.all();
}

export function getLatestConversation() {
  const db = getDb();
  const result = db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  return result ?? null;
}

export function addMessage(conversationId: string, role: string, content: string) {
  const db = getDb();
  const now = Date.now();
  const message = {
    id: uuid(),
    conversationId,
    role,
    content,
    createdAt: now,
  };
  // Wrap insert + updatedAt bump in a transaction so they're atomic.
  db.transaction((tx) => {
    tx.insert(messages).values(message).run();
    tx.update(conversations)
      .set({ updatedAt: now })
      .where(eq(conversations.id, conversationId))
      .run();
  });

  try {
    const config = getConfig();
    indexMessageNow({
      messageId: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
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
  const db = getDb();
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;

  const msgCount = (raw.query('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
  const convCount = (raw.query('SELECT COUNT(*) AS c FROM conversations').get() as { c: number }).c;

  // Delete in dependency order. Cascades handle memory_segments,
  // memory_item_sources, and tool_invocations, but we explicitly
  // clear non-cascading memory tables too.
  raw.exec('DELETE FROM memory_segment_fts');
  raw.exec('DELETE FROM memory_item_sources');
  raw.exec('DELETE FROM memory_segments');
  raw.exec('DELETE FROM memory_items');
  raw.exec('DELETE FROM memory_summaries');
  raw.exec('DELETE FROM memory_embeddings');
  raw.exec('DELETE FROM memory_jobs');
  raw.exec('DELETE FROM memory_checkpoints');
  raw.exec('DELETE FROM llm_usage_events');
  raw.exec('DELETE FROM tool_invocations');
  raw.exec('DELETE FROM messages');
  raw.exec('DELETE FROM conversations');

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

  db.transaction((tx) => {
    tx.delete(messages).where(condition).run();
    tx.update(conversations)
      .set({ updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();
  });

  return deleted;
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
 */
export function deleteMessageById(messageId: string): void {
  const db = getDb();
  db.transaction((tx) => {
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
}

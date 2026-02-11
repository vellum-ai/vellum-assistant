import { eq, desc, asc, and, count, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { conversations, messages } from './schema.js';
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
 * Patch a saved assistant message's content to inject tool_result data
 * alongside the corresponding tool_use blocks.
 *
 * The pendingResults map is keyed by tool_use_id with value { content, isError }.
 * For each tool_use block in the saved message whose id matches a key in the map,
 * a sibling tool_result block is appended immediately after it.
 */
export function patchToolResults(
  conversationId: string,
  messageId: string,
  pendingResults: Map<string, { content: string; isError: boolean }>,
): void {
  if (pendingResults.size === 0) return;

  const db = getDb();
  const row = db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .get();
  if (!row) return;

  let blocks: unknown[];
  try {
    blocks = JSON.parse(row.content);
    if (!Array.isArray(blocks)) return;
  } catch {
    return;
  }

  const patched: unknown[] = [];
  for (const block of blocks) {
    patched.push(block);
    if (
      typeof block === 'object' && block !== null &&
      (block as Record<string, unknown>).type === 'tool_use'
    ) {
      const id = (block as Record<string, unknown>).id;
      if (typeof id === 'string' && pendingResults.has(id)) {
        const result = pendingResults.get(id)!;
        patched.push({
          type: 'tool_result',
          tool_use_id: id,
          content: result.content,
          is_error: result.isError,
        });
      }
    }
  }

  db.update(messages)
    .set({ content: JSON.stringify(patched) })
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .run();
}

/**
 * Delete the last user message and any subsequent assistant messages.
 * Uses rowid comparison instead of timestamps to avoid deleting messages
 * that share the same millisecond timestamp.
 * Returns the number of messages deleted.
 */
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

  // Count messages to delete, then delete them atomically
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

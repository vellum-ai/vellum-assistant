import { eq, desc, asc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { conversations, messages } from './schema.js';

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
  db.insert(messages).values(message).run();
  db.update(conversations)
    .set({ updatedAt: now })
    .where(eq(conversations.id, conversationId))
    .run();
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
): void {
  const db = getDb();
  db.update(conversations)
    .set({ totalInputTokens, totalOutputTokens, updatedAt: Date.now() })
    .where(eq(conversations.id, id))
    .run();
}

/**
 * Delete the last user message and any subsequent assistant messages.
 * Returns the number of messages deleted.
 */
export function deleteLastExchange(conversationId: string): number {
  const db = getDb();
  const allMessages = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();

  if (allMessages.length === 0) return 0;

  // Find the last user message
  let lastUserIdx = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return 0;

  // Delete from lastUserIdx onward
  const toDelete = allMessages.slice(lastUserIdx);
  for (const m of toDelete) {
    db.delete(messages).where(eq(messages.id, m.id)).run();
  }

  db.update(conversations)
    .set({ updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();

  return toDelete.length;
}


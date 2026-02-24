/**
 * Query helpers for the assistant_inbox_thread_state table.
 *
 * Provides CRUD operations for inbox thread state — the denormalized
 * view that powers the assistant's inbox UI with per-thread metadata
 * (unread counts, escalation state, last activity timestamps).
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { assistantInboxThreadState } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InboxThread = typeof assistantInboxThreadState.$inferSelect;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * List inbox threads ordered by most recent activity.
 * NULL last_message_at values sort last.
 */
export function listThreads(params?: {
  assistantId?: string;
  limit?: number;
  offset?: number;
}): InboxThread[] {
  const db = getDb();
  const assistantId = params?.assistantId ?? 'self';
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;

  return db
    .select()
    .from(assistantInboxThreadState)
    .where(eq(assistantInboxThreadState.assistantId, assistantId))
    .orderBy(sql`${assistantInboxThreadState.lastMessageAt} DESC NULLS LAST`)
    .limit(limit)
    .offset(offset)
    .all();
}

/**
 * Get a single thread by its conversation ID (the primary key).
 */
export function getThread(conversationId: string): InboxThread | null {
  const db = getDb();
  const row = db
    .select()
    .from(assistantInboxThreadState)
    .where(eq(assistantInboxThreadState.conversationId, conversationId))
    .get();

  return row ?? null;
}

/**
 * Look up a thread by its unique binding (assistant_id, source_channel, external_chat_id).
 */
export function getThreadByBinding(
  assistantId: string,
  sourceChannel: string,
  externalChatId: string,
): InboxThread | null {
  const db = getDb();
  const row = db
    .select()
    .from(assistantInboxThreadState)
    .where(
      and(
        eq(assistantInboxThreadState.assistantId, assistantId),
        eq(assistantInboxThreadState.sourceChannel, sourceChannel),
        eq(assistantInboxThreadState.externalChatId, externalChatId),
      ),
    )
    .get();

  return row ?? null;
}

/**
 * Create or update an inbox thread state row.
 * If a row with the given conversationId exists, updates display fields and updated_at.
 * Otherwise, creates a new row with counters initialized to 0.
 */
export function upsertThread(params: {
  conversationId: string;
  assistantId?: string;
  sourceChannel: string;
  externalChatId: string;
  externalUserId?: string;
  displayName?: string;
  username?: string;
}): InboxThread {
  const db = getDb();
  const now = Date.now();
  const assistantId = params.assistantId ?? 'self';

  const existing = getThread(params.conversationId);

  if (existing) {
    db.update(assistantInboxThreadState)
      .set({
        displayName: params.displayName ?? existing.displayName,
        username: params.username ?? existing.username,
        externalUserId: params.externalUserId ?? existing.externalUserId,
        updatedAt: now,
      })
      .where(eq(assistantInboxThreadState.conversationId, params.conversationId))
      .run();

    return {
      ...existing,
      displayName: params.displayName ?? existing.displayName,
      username: params.username ?? existing.username,
      externalUserId: params.externalUserId ?? existing.externalUserId,
      updatedAt: now,
    };
  }

  const row = {
    conversationId: params.conversationId,
    assistantId,
    sourceChannel: params.sourceChannel,
    externalChatId: params.externalChatId,
    externalUserId: params.externalUserId ?? null,
    displayName: params.displayName ?? null,
    username: params.username ?? null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastMessageAt: null,
    unreadCount: 0,
    pendingEscalationCount: 0,
    hasPendingEscalation: 0,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(assistantInboxThreadState).values(row).run();

  return row;
}

/**
 * Record message activity on a thread.
 * - inbound: updates last_inbound_at, last_message_at, increments unread_count
 * - outbound: updates last_outbound_at, last_message_at, resets unread_count to 0
 */
export function updateThreadActivity(
  conversationId: string,
  direction: 'inbound' | 'outbound',
): void {
  const db = getDb();
  const now = Date.now();

  if (direction === 'inbound') {
    db.update(assistantInboxThreadState)
      .set({
        lastInboundAt: now,
        lastMessageAt: now,
        unreadCount: sql`${assistantInboxThreadState.unreadCount} + 1`,
        updatedAt: now,
      })
      .where(eq(assistantInboxThreadState.conversationId, conversationId))
      .run();
  } else {
    db.update(assistantInboxThreadState)
      .set({
        lastOutboundAt: now,
        lastMessageAt: now,
        unreadCount: 0,
        updatedAt: now,
      })
      .where(eq(assistantInboxThreadState.conversationId, conversationId))
      .run();
  }
}

/**
 * Mark a thread as read by resetting its unread count.
 */
export function markThreadRead(conversationId: string): void {
  const db = getDb();
  const now = Date.now();

  db.update(assistantInboxThreadState)
    .set({
      unreadCount: 0,
      updatedAt: now,
    })
    .where(eq(assistantInboxThreadState.conversationId, conversationId))
    .run();
}

/**
 * Update the escalation state for a thread.
 * Sets pending_escalation_count and derives has_pending_escalation from it.
 */
export function updateEscalationState(
  conversationId: string,
  pendingCount: number,
): void {
  const db = getDb();
  const now = Date.now();

  db.update(assistantInboxThreadState)
    .set({
      pendingEscalationCount: pendingCount,
      hasPendingEscalation: pendingCount > 0 ? 1 : 0,
      updatedAt: now,
    })
    .where(eq(assistantInboxThreadState.conversationId, conversationId))
    .run();
}

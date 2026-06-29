/**
 * Store for external conversation bindings — maps internal conversation IDs
 * to external channel identifiers (e.g. Telegram chat ID, voice session).
 *
 * This enables the system to track which conversations originated from
 * external channels and expose channel metadata in session/conversation
 * list APIs.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { externalConversationBindings } from "./schema/index.js";

export interface ExternalConversationBinding {
  conversationId: string;
  sourceChannel: string;
  externalChatId: string;
  externalChatName?: string | null;
  externalThreadId?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
  createdAt: number;
  updatedAt: number;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
}

export interface UpsertBindingInput {
  conversationId: string;
  sourceChannel: string;
  externalChatId: string;
  externalChatName?: string | null;
  externalThreadId?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
}

function normalizeExternalThreadId(
  externalThreadId?: string | null,
): string | null {
  const trimmed = externalThreadId?.trim();
  return trimmed ? trimmed : null;
}

function normalizeExternalChatName(
  externalChatName?: string | null,
): string | null {
  const trimmed = externalChatName?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Insert or update an external conversation binding on conflict (conversationId).
 * On conflict, updates channel metadata and timestamps.
 */
export function upsertBinding(input: UpsertBindingInput): void {
  const db = getDb();
  const now = Date.now();
  const externalThreadId = normalizeExternalThreadId(input.externalThreadId);
  const externalChatName = normalizeExternalChatName(input.externalChatName);

  // If a stale binding exists for this channel/chat/thread tuple under a
  // different conversationId, remove it first so the unique index is not violated.
  const existing = getBindingByChannelChatThread(
    input.sourceChannel,
    input.externalChatId,
    externalThreadId,
  );
  if (existing && existing.conversationId !== input.conversationId) {
    db.delete(externalConversationBindings)
      .where(
        eq(
          externalConversationBindings.conversationId,
          existing.conversationId,
        ),
      )
      .run();
  }

  db.insert(externalConversationBindings)
    .values({
      conversationId: input.conversationId,
      sourceChannel: input.sourceChannel,
      externalChatId: input.externalChatId,
      externalChatName,
      externalThreadId,
      externalUserId: input.externalUserId ?? null,
      displayName: input.displayName ?? null,
      username: input.username ?? null,
      createdAt: now,
      updatedAt: now,
      lastInboundAt: now,
    })
    .onConflictDoUpdate({
      target: externalConversationBindings.conversationId,
      set: {
        sourceChannel: input.sourceChannel,
        externalChatId: input.externalChatId,
        externalChatName:
          externalChatName ??
          sql`${externalConversationBindings.externalChatName}`,
        externalThreadId,
        externalUserId: input.externalUserId ?? null,
        displayName: input.displayName ?? null,
        username: input.username ?? null,
        updatedAt: now,
        lastInboundAt: now,
      },
    })
    .run();
}

/**
 * Upsert an external conversation binding for outbound sends.
 * Similar to upsertBinding but touches lastOutboundAt instead of lastInboundAt,
 * and only requires channel identifiers (no sender metadata needed).
 */
export function upsertOutboundBinding(input: {
  conversationId: string;
  sourceChannel: string;
  externalChatId: string;
  externalThreadId?: string | null;
}): void {
  const db = getDb();
  const now = Date.now();
  const externalThreadId = normalizeExternalThreadId(input.externalThreadId);

  // If a stale binding exists for this channel/chat/thread tuple under a
  // different conversationId, remove it first so the unique index is not violated.
  const existing = getBindingByChannelChatThread(
    input.sourceChannel,
    input.externalChatId,
    externalThreadId,
  );
  if (existing && existing.conversationId !== input.conversationId) {
    db.delete(externalConversationBindings)
      .where(
        eq(
          externalConversationBindings.conversationId,
          existing.conversationId,
        ),
      )
      .run();
  }

  db.insert(externalConversationBindings)
    .values({
      conversationId: input.conversationId,
      sourceChannel: input.sourceChannel,
      externalChatId: input.externalChatId,
      externalThreadId,
      externalUserId: null,
      displayName: null,
      username: null,
      createdAt: now,
      updatedAt: now,
      lastOutboundAt: now,
    })
    .onConflictDoUpdate({
      target: externalConversationBindings.conversationId,
      set: {
        sourceChannel: input.sourceChannel,
        externalChatId: input.externalChatId,
        externalThreadId,
        updatedAt: now,
        lastOutboundAt: now,
      },
    })
    .run();
}

export function updateExternalChatName(
  conversationId: string,
  externalChatName: string,
): void {
  const db = getDb();
  const trimmedName = externalChatName.trim();
  if (!trimmedName) return;

  db.update(externalConversationBindings)
    .set({
      externalChatName: trimmedName,
      updatedAt: Date.now(),
    })
    .where(eq(externalConversationBindings.conversationId, conversationId))
    .run();
}

/**
 * Look up an external binding by conversation ID.
 */
export function getBindingByConversation(
  conversationId: string,
): ExternalConversationBinding | null {
  const db = getDb();
  const row = db
    .select()
    .from(externalConversationBindings)
    .where(eq(externalConversationBindings.conversationId, conversationId))
    .get();
  return row ?? null;
}

/**
 * Look up an external binding by channel + external chat ID.
 */
export function getBindingByChannelChat(
  sourceChannel: string,
  externalChatId: string,
): ExternalConversationBinding | null {
  return getBindingByChannelChatThread(sourceChannel, externalChatId, null);
}

/**
 * Look up an external binding by channel + external chat ID + optional thread ID.
 */
export function getBindingByChannelChatThread(
  sourceChannel: string,
  externalChatId: string,
  externalThreadId?: string | null,
): ExternalConversationBinding | null {
  const db = getDb();
  const normalizedThreadId = normalizeExternalThreadId(externalThreadId);
  const row = db
    .select()
    .from(externalConversationBindings)
    .where(
      and(
        eq(externalConversationBindings.sourceChannel, sourceChannel),
        eq(externalConversationBindings.externalChatId, externalChatId),
        normalizedThreadId
          ? eq(
              externalConversationBindings.externalThreadId,
              normalizedThreadId,
            )
          : isNull(externalConversationBindings.externalThreadId),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Remove an external binding by channel + external chat ID.
 * Used when disconnecting a synced conversation by its channel identifiers.
 */
export function deleteBindingByChannelChat(
  sourceChannel: string,
  externalChatId: string,
): void {
  const db = getDb();
  db.delete(externalConversationBindings)
    .where(
      and(
        eq(externalConversationBindings.sourceChannel, sourceChannel),
        eq(externalConversationBindings.externalChatId, externalChatId),
      ),
    )
    .run();
}

/**
 * Remove an external binding by channel + external chat ID + thread ID.
 */
export function deleteBindingByChannelChatThread(
  sourceChannel: string,
  externalChatId: string,
  externalThreadId: string,
): void {
  const db = getDb();
  const normalizedThreadId = normalizeExternalThreadId(externalThreadId);
  if (!normalizedThreadId) {
    deleteBindingByChannelChat(sourceChannel, externalChatId);
    return;
  }
  db.delete(externalConversationBindings)
    .where(
      and(
        eq(externalConversationBindings.sourceChannel, sourceChannel),
        eq(externalConversationBindings.externalChatId, externalChatId),
        eq(externalConversationBindings.externalThreadId, normalizedThreadId),
      ),
    )
    .run();
}

/**
 * Get bindings for multiple conversation IDs at once.
 * Returns a map of conversationId -> binding for efficient lookup.
 */
export function getBindingsForConversations(
  conversationIds: string[],
): Map<string, ExternalConversationBinding> {
  if (conversationIds.length === 0) return new Map();

  const db = getDb();
  const result = new Map<string, ExternalConversationBinding>();

  const all = db
    .select()
    .from(externalConversationBindings)
    .where(
      inArray(externalConversationBindings.conversationId, conversationIds),
    )
    .all();

  for (const row of all) {
    result.set(row.conversationId, row);
  }

  return result;
}

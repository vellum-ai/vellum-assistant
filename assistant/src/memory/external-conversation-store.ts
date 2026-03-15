/**
 * Store for external conversation bindings — maps internal conversation IDs
 * to external channel identifiers (e.g. Telegram chat ID, voice session).
 *
 * This enables the system to track which conversations originated from
 * external channels and expose channel metadata in session/conversation
 * list APIs.
 */

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "./db.js";
import { externalConversationBindings } from "./schema.js";

export interface ExternalConversationBinding {
  conversationId: string;
  sourceChannel: string;
  externalChatId: string;
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
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
}

/**
 * Insert or update an external conversation binding on conflict (conversationId).
 * On conflict, updates channel metadata and timestamps.
 */
export function upsertBinding(input: UpsertBindingInput): void {
  const db = getDb();
  const now = Date.now();

  // If a stale binding exists for this (sourceChannel, externalChatId) under a
  // different conversationId, remove it first so the unique index is not violated.
  const existing = getBindingByChannelChat(
    input.sourceChannel,
    input.externalChatId,
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
}): void {
  const db = getDb();
  const now = Date.now();

  // If a stale binding exists for this (sourceChannel, externalChatId) under a
  // different conversationId, remove it first so the unique index is not violated.
  const existing = getBindingByChannelChat(
    input.sourceChannel,
    input.externalChatId,
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
        updatedAt: now,
        lastOutboundAt: now,
      },
    })
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
  const db = getDb();
  const row = db
    .select()
    .from(externalConversationBindings)
    .where(
      and(
        eq(externalConversationBindings.sourceChannel, sourceChannel),
        eq(externalConversationBindings.externalChatId, externalChatId),
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

/**
 * Core CRUD operations for channel inbound events.
 *
 * Handles recording inbound messages, linking them to internal message IDs,
 * finding messages by source identifiers, and managing raw payload storage.
 */

import { and, eq, isNotNull, like, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import {
  getConversationByKey,
  getOrCreateConversation,
  setConversationKeyIfAbsent,
} from "./conversation-key-store.js";
import { getDb } from "./db-connection.js";
import { channelInboundEvents, conversations, messages } from "./schema.js";

export interface InboundResult {
  accepted: boolean;
  eventId: string;
  conversationId: string;
  duplicate: boolean;
}

export interface RecordInboundOptions {
  sourceMessageId?: string;
  assistantId?: string;
  sourceThreadId?: string;
}

function buildScopedConversationKeyForAssistant(
  assistantId: string,
  sourceChannel: string,
  externalChatId: string,
  sourceThreadId?: string | null,
): string {
  const threadId = sourceThreadId?.trim();
  if (sourceChannel === "slack" && threadId) {
    return `asst:${assistantId}:${sourceChannel}:${externalChatId}:thread:${threadId}`;
  }
  return `asst:${assistantId}:${sourceChannel}:${externalChatId}`;
}

export function buildScopedConversationKey(
  sourceChannel: string,
  externalChatId: string,
  sourceThreadId?: string | null,
): string {
  return buildScopedConversationKeyForAssistant(
    DAEMON_INTERNAL_ASSISTANT_ID,
    sourceChannel,
    externalChatId,
    sourceThreadId,
  );
}

function readSlackMetadataEvidence(
  raw: string | null,
): { channelId: string; threadTs?: string } | null {
  if (!raw) {
    return null;
  }

  const candidates: string[] = [raw];
  try {
    const envelope: unknown = JSON.parse(raw);
    if (
      envelope !== null &&
      typeof envelope === "object" &&
      !Array.isArray(envelope)
    ) {
      const slackMeta = (envelope as { slackMeta?: unknown }).slackMeta;
      if (typeof slackMeta === "string") {
        candidates.unshift(slackMeta);
      }
    }
  } catch {
    // Fall through to parsing the raw value as a flat Slack metadata blob.
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        continue;
      }

      const record = parsed as Record<string, unknown>;
      const eventKind = record.eventKind;
      if (
        record.source !== "slack" ||
        typeof record.channelId !== "string" ||
        typeof record.channelTs !== "string" ||
        (eventKind !== "message" && eventKind !== "reaction")
      ) {
        continue;
      }

      return {
        channelId: record.channelId,
        ...(typeof record.threadTs === "string"
          ? { threadTs: record.threadTs }
          : {}),
      };
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function legacySlackConversationHasThreadEvidence(
  conversationId: string,
  externalChatId: string,
  sourceThreadId: string,
): boolean {
  const db = getDb();
  const inboundEvidence = db
    .select({ id: channelInboundEvents.id })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.conversationId, conversationId),
        eq(channelInboundEvents.sourceChannel, "slack"),
        eq(channelInboundEvents.externalChatId, externalChatId),
        or(
          eq(channelInboundEvents.sourceMessageId, sourceThreadId),
          eq(channelInboundEvents.externalMessageId, sourceThreadId),
        ),
      ),
    )
    .get();

  if (inboundEvidence) {
    return true;
  }

  const metadataRows = db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNotNull(messages.metadata),
        or(
          like(messages.metadata, '%"slackMeta"%'),
          like(messages.metadata, '%"source":"slack"%'),
        ),
      ),
    )
    .all();

  return metadataRows.some((row) => {
    const slackMeta = readSlackMetadataEvidence(row.metadata);
    return (
      slackMeta?.channelId === externalChatId &&
      slackMeta.threadTs === sourceThreadId
    );
  });
}

function resolveInboundConversation(
  assistantId: string,
  sourceChannel: string,
  externalChatId: string,
  sourceThreadId?: string | null,
): { conversationId: string } {
  const threadedKey = buildScopedConversationKeyForAssistant(
    assistantId,
    sourceChannel,
    externalChatId,
    sourceThreadId,
  );

  const threadId = sourceThreadId?.trim();
  if (sourceChannel !== "slack" || !threadId) {
    return getOrCreateConversation(threadedKey);
  }

  const threadedMapping = getConversationByKey(threadedKey);
  if (threadedMapping) {
    return { conversationId: threadedMapping.conversationId };
  }

  const legacyKey = buildScopedConversationKeyForAssistant(
    assistantId,
    sourceChannel,
    externalChatId,
    null,
  );
  const legacyMapping = getConversationByKey(legacyKey);
  if (
    legacyMapping &&
    legacySlackConversationHasThreadEvidence(
      legacyMapping.conversationId,
      externalChatId,
      threadId,
    )
  ) {
    setConversationKeyIfAbsent(threadedKey, legacyMapping.conversationId);
    const aliasedMapping = getConversationByKey(threadedKey);
    if (aliasedMapping) {
      return { conversationId: aliasedMapping.conversationId };
    }
  }

  return getOrCreateConversation(threadedKey);
}

/**
 * Record an inbound channel event. Returns `duplicate: true` if this
 * exact (channel, chat, message) combination was already seen.
 */
export function recordInbound(
  sourceChannel: string,
  externalChatId: string,
  externalMessageId: string,
  options?: RecordInboundOptions,
): InboundResult {
  const db = getDb();

  const existing = db
    .select({
      id: channelInboundEvents.id,
      conversationId: channelInboundEvents.conversationId,
    })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.sourceChannel, sourceChannel),
        eq(channelInboundEvents.externalChatId, externalChatId),
        eq(channelInboundEvents.externalMessageId, externalMessageId),
      ),
    )
    .get();

  if (existing) {
    return {
      accepted: true,
      eventId: existing.id,
      conversationId: existing.conversationId,
      duplicate: true,
    };
  }

  const assistantId = options?.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;
  const mapping = resolveInboundConversation(
    assistantId,
    sourceChannel,
    externalChatId,
    options?.sourceThreadId,
  );
  const now = Date.now();
  const eventId = uuid();

  db.transaction((tx) => {
    tx.update(conversations)
      .set({ updatedAt: now })
      .where(eq(conversations.id, mapping.conversationId))
      .run();
    tx.insert(channelInboundEvents)
      .values({
        id: eventId,
        sourceChannel,
        externalChatId,
        externalMessageId,
        sourceMessageId: options?.sourceMessageId ?? null,
        conversationId: mapping.conversationId,
        deliveryStatus: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  return {
    accepted: true,
    eventId,
    conversationId: mapping.conversationId,
    duplicate: false,
  };
}

/**
 * Delete an inbound event record by its event ID. Used to roll back a
 * dedup record when downstream processing (e.g. invite redemption) fails,
 * so that webhook retries can re-attempt instead of short-circuiting as
 * duplicates.
 */
export function deleteInbound(eventId: string): void {
  const db = getDb();
  db.delete(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}

/**
 * Link an inbound event to the user message it created, so edits can
 * later find the correct message by source_message_id -> message_id.
 */
export function linkMessage(eventId: string, messageId: string): void {
  const db = getDb();
  db.update(channelInboundEvents)
    .set({ messageId, updatedAt: Date.now() })
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}

/**
 * Find the message ID linked to the original inbound event for a given
 * platform-level message identifier (e.g. Telegram message_id).
 */
export function findMessageBySourceId(
  sourceChannel: string,
  externalChatId: string,
  sourceMessageId: string,
): { messageId: string; conversationId: string } | null {
  const db = getDb();
  const row = db
    .select({
      messageId: channelInboundEvents.messageId,
      conversationId: channelInboundEvents.conversationId,
    })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.sourceChannel, sourceChannel),
        eq(channelInboundEvents.externalChatId, externalChatId),
        eq(channelInboundEvents.sourceMessageId, sourceMessageId),
        isNotNull(channelInboundEvents.messageId),
      ),
    )
    .get();

  if (!row || !row.messageId) return null;
  return { messageId: row.messageId, conversationId: row.conversationId };
}

/**
 * Store the raw request payload on an inbound event so it can be
 * replayed later if processing fails.
 */
export function storePayload(
  eventId: string,
  payload: Record<string, unknown>,
): void {
  const db = getDb();
  db.update(channelInboundEvents)
    .set({ rawPayload: JSON.stringify(payload), updatedAt: Date.now() })
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}

/**
 * Clear a previously stored payload. Used when the ingress check
 * detects secret-bearing content — the payload must not remain on disk.
 */
export function clearPayload(eventId: string): void {
  const db = getDb();
  db.update(channelInboundEvents)
    .set({ rawPayload: null, updatedAt: Date.now() })
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}

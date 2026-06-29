/**
 * Core CRUD operations for channel inbound events.
 *
 * Handles recording inbound messages, linking them to internal message IDs,
 * finding messages by source identifiers, and managing raw payload storage.
 */

import { and, eq, isNotNull, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { readSlackMetadataFromMessageMetadata } from "../messaging/providers/slack/message-metadata.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { selectSlackMetaCandidateMetadata } from "./conversation-crud.js";
import {
  getConversationByKey,
  getOrCreateConversation,
  setConversationKeyIfAbsent,
} from "./conversation-key-store.js";
import { getDb } from "./db-connection.js";
import { channelInboundEvents, conversations } from "./schema.js";

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

const SLACK_LEGACY_THREAD_EVIDENCE_BATCH_SIZE = 50;
const SLACK_LEGACY_THREAD_EVIDENCE_MAX_SCAN = 500;

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

  let offset = 0;
  while (offset < SLACK_LEGACY_THREAD_EVIDENCE_MAX_SCAN) {
    const remaining = SLACK_LEGACY_THREAD_EVIDENCE_MAX_SCAN - offset;
    const batchLimit = Math.min(
      SLACK_LEGACY_THREAD_EVIDENCE_BATCH_SIZE,
      remaining,
    );
    const metadataRows = selectSlackMetaCandidateMetadata(
      conversationId,
      batchLimit,
      offset,
      { includeFlatLegacy: true },
    );

    if (metadataRows.length === 0) return false;
    for (const metadata of metadataRows) {
      const slackMeta = readSlackMetadataFromMessageMetadata(metadata, {
        allowFlatLegacy: true,
      });
      if (
        slackMeta?.channelId === externalChatId &&
        slackMeta.threadTs === sourceThreadId
      ) {
        return true;
      }
    }

    if (metadataRows.length < batchLimit) return false;
    offset += metadataRows.length;
  }

  return false;
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
 * Persist the assistant reply row generated for an inbound event so callback
 * delivery retries target that exact response instead of the latest message in
 * the conversation.
 */
export function storeReplyMessageId(
  eventId: string,
  replyMessageId: string,
): void {
  const db = getDb();
  const row = db
    .select({ rawPayload: channelInboundEvents.rawPayload })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();
  if (!row?.rawPayload) return;

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.rawPayload) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  db.update(channelInboundEvents)
    .set({
      rawPayload: JSON.stringify({ ...payload, replyMessageId }),
      updatedAt: Date.now(),
    })
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

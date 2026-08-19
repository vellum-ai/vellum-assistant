/**
 * Core CRUD operations for channel inbound events.
 *
 * Handles recording inbound messages, linking them to internal message IDs,
 * finding messages by source identifiers, and managing raw payload storage.
 */

import { and, desc, eq, isNotNull, like, ne, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { ChannelId } from "../channels/types.js";
import { readProviderMetadata } from "../messaging/read-provider-metadata.js";
import type { SlackInboundMessageMetadata } from "../runtime/http-types.js";
import { parseJsonSafe } from "../util/json.js";
import { isPlainObject } from "../util/object.js";
import { selectProviderMetaCandidateMetadata } from "./conversation-crud.js";
import {
  getConversationByKey,
  getOrCreateConversation,
  setConversationKeyIfAbsent,
} from "./conversation-key-store.js";
import type { NonScheduledConversationType } from "./conversation-types.js";
import { getDb } from "./db-connection.js";
import {
  channelInboundEvents,
  conversationKeys,
  conversations,
  messages,
} from "./schema.js";

export interface InboundResult {
  accepted: boolean;
  eventId: string;
  conversationId: string;
  duplicate: boolean;
}

export interface RecordInboundOptions {
  sourceMessageId?: string;
  sourceThreadId?: string;
  /**
   * Record the event against this conversation instead of resolving one from
   * the address. For events that belong to a message rather than to a chat: a
   * reaction lives in the conversation of the message it was attached to, and
   * resolving from its own address would mint a second one.
   */
  conversationId?: string;
}

const SLACK_LEGACY_THREAD_EVIDENCE_BATCH_SIZE = 50;
const SLACK_LEGACY_THREAD_EVIDENCE_MAX_SCAN = 500;

/**
 * Rows examined when locating a Slack message the assistant itself posted.
 * Bounded on purpose: the scan runs on the inbound path while the gateway
 * waits for its ack, and reactions land on recent messages, so a cap costs
 * almost no recall and keeps the cost flat as the database grows.
 */
const SLACK_OUTBOUND_TS_MAX_SCAN = 400;

/**
 * Channels where an inbound thread id scopes the conversation: a Slack thread
 * or a Telegram private-chat topic each maps to its own conversation. A
 * message without a thread id always resolves to the chat-level base key.
 */
const THREAD_SCOPED_CHANNELS = new Set(["slack", "telegram"]);

/**
 * Scope prefix on every conversation key.
 *
 * Part of the stored key format, so it is fixed: rows are written under
 * `asst:self:` and stop resolving if it changes. The daemon is single-tenant
 * and scopes all its storage to `self` (`DAEMON_INTERNAL_ASSISTANT_ID`).
 */
const CONVERSATION_KEY_SCOPE = "asst:self";

export function buildScopedConversationKey(
  sourceChannel: string,
  externalChatId: string,
  sourceThreadId?: string | null,
): string {
  const threadId = sourceThreadId?.trim();
  if (THREAD_SCOPED_CHANNELS.has(sourceChannel) && threadId) {
    return `${CONVERSATION_KEY_SCOPE}:${sourceChannel}:${externalChatId}:thread:${threadId}`;
  }
  return `${CONVERSATION_KEY_SCOPE}:${sourceChannel}:${externalChatId}`;
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
    const metadataRows = selectProviderMetaCandidateMetadata(
      conversationId,
      batchLimit,
      offset,
      { includeFlatLegacy: true },
    );

    if (metadataRows.length === 0) {
      return false;
    }
    for (const metadata of metadataRows) {
      const meta = readProviderMetadata(metadata, { allowFlatLegacy: true });
      if (
        meta?.conversationExternalId === externalChatId &&
        meta.threadId === sourceThreadId
      ) {
        return true;
      }
    }

    if (metadataRows.length < batchLimit) {
      return false;
    }
    offset += metadataRows.length;
  }

  return false;
}

/**
 * Applied only where this call is what creates the conversation. An address
 * that already resolves is an existing conversation, and neither its type nor
 * where it came from is the current message's to restate.
 */
export interface ResolveInboundConversationOptions {
  conversationType?: NonScheduledConversationType;
  /** Channel this conversation originates on, for first-message attribution. */
  origin?: ChannelId;
}

export function resolveInboundConversation(
  sourceChannel: string,
  externalChatId: string,
  sourceThreadId?: string | null,
  opts?: ResolveInboundConversationOptions,
): { conversationId: string } {
  const threadedKey = buildScopedConversationKey(
    sourceChannel,
    externalChatId,
    sourceThreadId,
  );

  const threadId = sourceThreadId?.trim();
  // Flat→threaded aliasing applies only to Slack: a Slack thread may continue
  // a conversation that lives on the flat channel key, so the alias path below
  // checks for that evidence before minting a threaded conversation. Every
  // other thread-scoped channel (Telegram topics) has no flat-key aliasing —
  // a thread id always resolves the threaded key directly.
  if (sourceChannel !== "slack" || !threadId) {
    return getOrCreateConversation(threadedKey, opts);
  }

  const threadedMapping = getConversationByKey(threadedKey);
  if (threadedMapping) {
    return { conversationId: threadedMapping.conversationId };
  }

  const legacyKey = buildScopedConversationKey(
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

  return getOrCreateConversation(threadedKey, opts);
}

/**
 * Resolve the internal conversation already bound to an inbound
 * (channel, chat, thread) address, or `null` when none exists. Mirrors
 * {@link resolveInboundConversation}'s lookup order — threaded key first,
 * then the Slack flat-key alias when thread evidence exists — but is
 * strictly read-only: deny lanes use it to attach the in-app
 * access-request card to the originating conversation, and a denied
 * inbound must never mint a conversation as a side effect.
 */
export function findInboundConversationId(
  sourceChannel: string,
  externalChatId: string,
  sourceThreadId?: string | null,
): string | null {
  const threadedKey = buildScopedConversationKey(
    sourceChannel,
    externalChatId,
    sourceThreadId,
  );
  const threadedMapping = getConversationByKey(threadedKey);
  if (threadedMapping) {
    return threadedMapping.conversationId;
  }

  const threadId = sourceThreadId?.trim();
  if (sourceChannel !== "slack" || !threadId) {
    return null;
  }

  const legacyKey = buildScopedConversationKey(sourceChannel, externalChatId);
  const legacyMapping = getConversationByKey(legacyKey);
  if (
    legacyMapping &&
    legacySlackConversationHasThreadEvidence(
      legacyMapping.conversationId,
      externalChatId,
      threadId,
    )
  ) {
    return legacyMapping.conversationId;
  }

  return null;
}

/**
 * Record an inbound channel event. Returns `duplicate: true` if this
 * exact (channel, chat, message) combination was already seen.
 *
 * The dedup half of this is also implemented gateway-side, on the same
 * triple, in `gateway/src/db/inbound-dedup-store.ts`. Deliberately, not by
 * accident: the gateway claims a delivery before handing it over, so a
 * vendor's retry costs no crossing, and this stays as the record that binds
 * the conversation and tracks the reply. Both must key on the same three
 * fields for either to mean anything.
 */
/**
 * The inbound event already recorded for this address, if any. Read-only twin
 * of the dedup check inside {@link recordInbound}, for callers that must know
 * an event is a redelivery before doing work that recording would otherwise
 * gate (routing a guardian decision, for one).
 */
export function findInboundEvent(
  sourceChannel: string,
  externalChatId: string,
  externalMessageId: string,
): { eventId: string; conversationId: string } | null {
  const row = getDb()
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
  return row ? { eventId: row.id, conversationId: row.conversationId } : null;
}

/**
 * The conversation holding the message with this provider id, found by reading
 * the metadata the assistant's own posts carry.
 *
 * Reads through `readProviderMetadata`, so it matches any channel that
 * describes its rows in the neutral shape as well as Slack's own envelope.
 *
 * `findMessageBySourceId` covers every message that arrived as an inbound
 * event. It cannot see what the assistant posted, because an outbound reply
 * opens no inbound event, so a reaction on the assistant's own message needs
 * this. The search is confined to conversations already bound to the same
 * Slack channel and to the most recent {@link SLACK_OUTBOUND_TS_MAX_SCAN}
 * rows among them; beyond that it gives up and the caller drops the
 * annotation, which is the same outcome as never finding it at all.
 */
export function findSlackConversationByMessageTs(
  externalChatId: string,
  channelTs: string,
): string | null {
  const db = getDb();
  const keyPrefix = `${CONVERSATION_KEY_SCOPE}:slack:${externalChatId}`;
  const rows = db
    .select({
      conversationId: messages.conversationId,
      metadata: messages.metadata,
    })
    .from(messages)
    .innerJoin(
      conversationKeys,
      eq(conversationKeys.conversationId, messages.conversationId),
    )
    .where(
      and(
        or(
          eq(conversationKeys.conversationKey, keyPrefix),
          like(conversationKeys.conversationKey, `${keyPrefix}:thread:%`),
        ),
        or(
          like(messages.metadata, '%"providerMeta"%'),
          like(messages.metadata, '%"slackMeta"%'),
        ),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(SLACK_OUTBOUND_TS_MAX_SCAN)
    .all();

  for (const row of rows) {
    const meta = readProviderMetadata(row.metadata, { allowFlatLegacy: true });
    if (
      meta?.conversationExternalId === externalChatId &&
      meta.messageId === channelTs
    ) {
      return row.conversationId;
    }
  }
  return null;
}

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

  const mapping = options?.conversationId
    ? { conversationId: options.conversationId }
    : resolveInboundConversation(
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

  if (!row || !row.messageId) {
    return null;
  }
  return { messageId: row.messageId, conversationId: row.conversationId };
}

/**
 * Reference to the most recent inbound channel event for a conversation:
 * the external chat plus the channel-native message identifiers needed to
 * point back at the triggering message (for Slack, `sourceMessageId` is the
 * message `ts` and `externalMessageId` is the dedupe id, which may also be
 * a `ts`).
 */
export interface LatestInboundEventReference {
  externalChatId: string;
  externalMessageId: string;
  sourceMessageId: string | null;
}

/**
 * Find the most recent inbound event for a conversation on a channel.
 * Used to anchor guardian-facing approval cards to the channel message
 * that triggered the request.
 *
 * Orders by `rowid` rather than `created_at`: rows are insert-only so the
 * two orderings agree, and the conversation-id index stores equal keys in
 * rowid order — a backward index scan finds the newest row without sorting
 * the conversation's full event history.
 */
export function getLatestInboundEventReference(
  conversationId: string,
  sourceChannel: string,
): LatestInboundEventReference | null {
  const db = getDb();
  const row = db
    .select({
      externalChatId: channelInboundEvents.externalChatId,
      externalMessageId: channelInboundEvents.externalMessageId,
      sourceMessageId: channelInboundEvents.sourceMessageId,
    })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.conversationId, conversationId),
        eq(channelInboundEvents.sourceChannel, sourceChannel),
      ),
    )
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get();
  return row ?? null;
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
 * Parse a stored `rawPayload` string into a plain object, or `undefined` when
 * it is absent, malformed, or not a JSON object.
 */
function parseRawPayloadObject(
  rawPayload: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!rawPayload) {
    return undefined;
  }
  const parsed = parseJsonSafe(rawPayload);
  return isPlainObject(parsed) ? parsed : undefined;
}

/**
 * Merge a patch into an inbound event's stored payload, preserving existing
 * keys. No-ops when the event has no payload or the stored value is not a JSON
 * object.
 */
function mergeRawPayload(
  eventId: string,
  patch: Record<string, unknown>,
): void {
  const db = getDb();
  const row = db
    .select({ rawPayload: channelInboundEvents.rawPayload })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();
  const payload = parseRawPayloadObject(row?.rawPayload);
  if (!payload) {
    return;
  }

  db.update(channelInboundEvents)
    .set({
      rawPayload: JSON.stringify({ ...payload, ...patch }),
      updatedAt: Date.now(),
    })
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
  mergeRawPayload(eventId, { replyMessageId });
}

/**
 * Persist the `ts` of a Slack message already streamed for an inbound event.
 * A processing retry reconciles its durable delivery into this message instead
 * of opening a second stream, preventing a duplicate reply.
 */
export function storeStreamedReplyTs(eventId: string, streamTs: string): void {
  mergeRawPayload(eventId, { slackStreamMessageTs: streamTs });
}

/**
 * Persist the Slack inbound metadata captured at ingress onto the stored
 * payload, so the retry sweep replays the turn with the SAME `slackInbound` the
 * live path used rather than reconstructing a partial one. This keeps the
 * derived idempotency key (`deriveIngressIdempotencyKey`) byte-identical across
 * the live and replay paths — so a replay of an already-persisted turn dedups —
 * and carries full `slackMeta` onto the replayed message row. No-ops when the
 * payload was cleared (e.g. a secret-bearing ingress), so cleared secrets are
 * never resurrected.
 */
export function storeInboundSlackMetadata(
  eventId: string,
  slackInbound: SlackInboundMessageMetadata,
): void {
  mergeRawPayload(eventId, { slackInbound });
}

/**
 * Return the `slackStreamMessageTs` durably recorded by any sibling inbound
 * event linked to the given user message (excluding `excludeEventId`).
 *
 * A deduplicated redelivery is `linkMessage`d to the original turn's
 * `messageId`, so the two events share it. When the original attempt streamed
 * its reply live into Slack but crashed before finalizing delivery, its `ts`
 * survives on the sibling row — the redelivery reads it here to edit that
 * message in place instead of posting the persisted reply a second time.
 */
export function getSiblingStreamedReplyTs(
  messageId: string,
  excludeEventId: string,
): string | undefined {
  const db = getDb();
  const rows = db
    .select({ rawPayload: channelInboundEvents.rawPayload })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.messageId, messageId),
        ne(channelInboundEvents.id, excludeEventId),
      ),
    )
    .all();

  for (const row of rows) {
    const ts = parseRawPayloadObject(row.rawPayload)?.slackStreamMessageTs;
    if (typeof ts === "string" && ts.length > 0) {
      return ts;
    }
  }
  return undefined;
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

/**
 * Channel inbound idempotency + delivery state tracking.
 *
 * Ensures duplicate channel messages (e.g. Telegram webhook retries)
 * don't produce duplicate replies. Tracks delivery acknowledgement
 * so the runtime owns the full lifecycle instead of web Postgres.
 *
 * Dead-letter support: when processMessage fails, the event is marked
 * with processing_status='failed' (retryable) or 'dead_letter' (fatal
 * or max attempts exceeded). A periodic sweep retries failed events,
 * and a replay endpoint allows manual recovery of dead-lettered ones.
 */

import { eq, and, lte, isNotNull } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { channelInboundEvents, conversations } from './schema.js';
import { getOrCreateConversation } from './conversation-key-store.js';
import {
  classifyError,
  retryDelayForAttempt,
  RETRY_MAX_ATTEMPTS,
} from './job-utils.js';

export interface InboundResult {
  accepted: boolean;
  eventId: string;
  conversationId: string;
  duplicate: boolean;
}

export interface RecordInboundOptions {
  sourceMessageId?: string;
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

  const conversationKey = `${sourceChannel}:${externalChatId}`;
  const mapping = getOrCreateConversation(conversationKey);
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
        deliveryStatus: 'pending',
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
 * Link an inbound event to the user message it created, so edits can
 * later find the correct message by source_message_id → message_id.
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
 * Acknowledge delivery of an outbound message for a channel event.
 */
export function acknowledgeDelivery(
  sourceChannel: string,
  externalChatId: string,
  externalMessageId: string,
): boolean {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select({ id: channelInboundEvents.id })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.sourceChannel, sourceChannel),
        eq(channelInboundEvents.externalChatId, externalChatId),
        eq(channelInboundEvents.externalMessageId, externalMessageId),
      ),
    )
    .get();

  if (!existing) return false;

  db.update(channelInboundEvents)
    .set({
      deliveryStatus: 'delivered',
      updatedAt: now,
    })
    .where(eq(channelInboundEvents.id, existing.id))
    .run();

  return true;
}

// ── Dead-letter queue helpers ───────────────────────────────────────

/**
 * Store the raw request payload on an inbound event so it can be
 * replayed later if processing fails.
 */
export function storePayload(eventId: string, payload: Record<string, unknown>): void {
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

/** Mark an event as successfully processed. */
export function markProcessed(eventId: string): void {
  const db = getDb();
  db.update(channelInboundEvents)
    .set({ processingStatus: 'processed', updatedAt: Date.now() })
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}

/**
 * Record a processing failure. Classifies the error to decide whether
 * the event should be retried (status='failed') or dead-lettered
 * (status='dead_letter') when the error is fatal or max attempts
 * are exhausted.
 */
export function recordProcessingFailure(eventId: string, err: unknown): void {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select({ attempts: channelInboundEvents.processingAttempts })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();

  const attempts = (row?.attempts ?? 0) + 1;
  const category = classifyError(err);
  const errorMsg = err instanceof Error ? err.message : String(err);

  if (category === 'fatal' || attempts >= RETRY_MAX_ATTEMPTS) {
    db.update(channelInboundEvents)
      .set({
        processingStatus: 'dead_letter',
        processingAttempts: attempts,
        lastProcessingError: errorMsg,
        retryAfter: null,
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId))
      .run();
  } else {
    const delay = retryDelayForAttempt(attempts);
    db.update(channelInboundEvents)
      .set({
        processingStatus: 'failed',
        processingAttempts: attempts,
        lastProcessingError: errorMsg,
        retryAfter: now + delay,
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId))
      .run();
  }
}

/** Fetch events eligible for automatic retry (failed + past their backoff). */
export function getRetryableEvents(limit = 20): Array<{
  id: string;
  conversationId: string;
  processingAttempts: number;
  rawPayload: string | null;
}> {
  const db = getDb();
  const now = Date.now();
  return db
    .select({
      id: channelInboundEvents.id,
      conversationId: channelInboundEvents.conversationId,
      processingAttempts: channelInboundEvents.processingAttempts,
      rawPayload: channelInboundEvents.rawPayload,
    })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.processingStatus, 'failed'),
        lte(channelInboundEvents.retryAfter, now),
      ),
    )
    .limit(limit)
    .all();
}

/** Fetch dead-lettered events. */
export function getDeadLetterEvents(): Array<{
  id: string;
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
  conversationId: string;
  processingAttempts: number;
  lastProcessingError: string | null;
  createdAt: number;
}> {
  const db = getDb();
  return db
    .select({
      id: channelInboundEvents.id,
      sourceChannel: channelInboundEvents.sourceChannel,
      externalChatId: channelInboundEvents.externalChatId,
      externalMessageId: channelInboundEvents.externalMessageId,
      conversationId: channelInboundEvents.conversationId,
      processingAttempts: channelInboundEvents.processingAttempts,
      lastProcessingError: channelInboundEvents.lastProcessingError,
      createdAt: channelInboundEvents.createdAt,
    })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.processingStatus, 'dead_letter'))
    .all();
}

// ── Deliver-once guard for terminal reply idempotency ────────────────
//
// When both the main poll (processChannelMessageWithApprovals) and the
// post-decision poll (schedulePostDecisionDelivery) race to deliver the
// final assistant reply for the same run, this guard ensures only one
// of them actually sends the message. The guard is run-scoped so old
// assistant messages from previous runs are not affected.

const deliveredRuns = new Set<string>();

/** TTL for delivery claims — 10 minutes, well beyond the poll max-wait. */
const CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * Atomically claim the right to deliver the final reply for a run.
 * Returns `true` if this caller won the claim (and should proceed with
 * delivery). Returns `false` if another caller already claimed it.
 *
 * This is an in-memory guard — sufficient because both racing pollers
 * execute within the same process. The Set is never persisted; on restart
 * there are no in-flight pollers to race.
 *
 * Claims are automatically evicted after CLAIM_TTL_MS to prevent
 * unbounded Set growth over the lifetime of the process.
 */
export function claimRunDelivery(runId: string): boolean {
  if (deliveredRuns.has(runId)) return false;
  deliveredRuns.add(runId);
  setTimeout(() => deliveredRuns.delete(runId), CLAIM_TTL_MS);
  return true;
}

/**
 * Reset the deliver-once guard for a run. Used to release a claim when
 * delivery fails (so the other racing poller can retry) and in tests
 * for isolation between test cases.
 */
export function resetRunDeliveryClaim(runId: string): void {
  deliveredRuns.delete(runId);
}

/**
 * Clear all delivery claims. Used in tests for full isolation.
 */
export function resetAllRunDeliveryClaims(): void {
  deliveredRuns.clear();
}

/**
 * Reset dead-lettered events back to 'failed' so the sweep can retry
 * them. Resets attempt counter and sets an immediate retry_after.
 */
export function replayDeadLetters(eventIds: string[]): number {
  const db = getDb();
  const now = Date.now();
  let count = 0;
  for (const id of eventIds) {
    const existing = db
      .select({ id: channelInboundEvents.id })
      .from(channelInboundEvents)
      .where(
        and(
          eq(channelInboundEvents.id, id),
          eq(channelInboundEvents.processingStatus, 'dead_letter'),
        ),
      )
      .get();
    if (!existing) continue;

    db.update(channelInboundEvents)
      .set({
        processingStatus: 'failed',
        processingAttempts: 0,
        lastProcessingError: null,
        retryAfter: now,
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, id))
      .run();
    count++;
  }
  return count;
}

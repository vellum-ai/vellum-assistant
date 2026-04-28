/**
 * Processing status tracking and dead-letter queue management for
 * channel inbound events.
 *
 * Handles marking events as processed/failed/dead-lettered, fetching
 * retryable and dead-lettered events, and replaying dead letters.
 */

import { and, eq, lte } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import {
  classifyError,
  RETRY_MAX_ATTEMPTS,
  retryDelayForAttempt,
} from "./job-utils.js";
import { channelInboundEvents } from "./schema.js";

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
      deliveryStatus: "delivered",
      updatedAt: now,
    })
    .where(eq(channelInboundEvents.id, existing.id))
    .run();

  return true;
}

/** Mark an event as successfully processed. */
export function markProcessed(eventId: string): void {
  const db = getDb();
  db.update(channelInboundEvents)
    .set({ processingStatus: "processed", updatedAt: Date.now() })
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

  if (category === "fatal" || attempts >= RETRY_MAX_ATTEMPTS) {
    db.update(channelInboundEvents)
      .set({
        processingStatus: "dead_letter",
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
        processingStatus: "failed",
        processingAttempts: attempts,
        lastProcessingError: errorMsg,
        retryAfter: now + delay,
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId))
      .run();
  }
}

/**
 * Mark an event as failed with a specific error message, bypassing error
 * classification. Use this when the failure reason is known and the event
 * should remain retryable (up to max attempts).
 */
export function markRetryableFailure(
  eventId: string,
  errorMessage: string,
): void {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select({ attempts: channelInboundEvents.processingAttempts })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();

  const attempts = (row?.attempts ?? 0) + 1;

  if (attempts >= RETRY_MAX_ATTEMPTS) {
    db.update(channelInboundEvents)
      .set({
        processingStatus: "dead_letter",
        processingAttempts: attempts,
        lastProcessingError: errorMessage,
        retryAfter: null,
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId))
      .run();
  } else {
    const delay = retryDelayForAttempt(attempts);
    db.update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: attempts,
        lastProcessingError: errorMessage,
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
        eq(channelInboundEvents.processingStatus, "failed"),
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
    .where(eq(channelInboundEvents.processingStatus, "dead_letter"))
    .all();
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
          eq(channelInboundEvents.processingStatus, "dead_letter"),
        ),
      )
      .get();
    if (!existing) continue;

    db.update(channelInboundEvents)
      .set({
        processingStatus: "failed",
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

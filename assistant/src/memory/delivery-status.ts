/**
 * Processing status tracking and dead-letter queue management for
 * channel inbound events.
 *
 * Handles marking events as processed/failed/dead-lettered, fetching
 * retryable and dead-lettered events, and replaying dead letters.
 */

import { and, eq, lte, or } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import {
  classifyError,
  RETRY_MAX_ATTEMPTS,
  retryDelayForAttempt,
} from "./job-utils.js";
import { channelInboundEvents } from "./schema.js";

type RetryClass = "processing_retry" | "delivery_retry";
type ReplayMode = "regenerate_reply" | "redeliver_existing_reply";
type ReplayFailureStage =
  | "reply_generation"
  | "callback_delivery"
  | "provider_validation";

export interface ReplayFailureContext {
  sourceChannel?: string;
  retryClass?: RetryClass;
  replayMode?: ReplayMode;
  stage?: Exclude<ReplayFailureStage, "provider_validation">;
  externalChatId?: string;
  replyCallbackUrl?: string;
  slackThreadTs?: string;
  slackMessageTs?: string;
}

const LAST_REPLAY_FAILURE_KEY = "lastReplayFailure";

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
      retryAfter: null,
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

/** Mark an event's outbound callback delivery as complete. */
export function markDeliveryDelivered(eventId: string): void {
  const db = getDb();
  db.update(channelInboundEvents)
    .set({
      deliveryStatus: "delivered",
      retryAfter: null,
      updatedAt: Date.now(),
    })
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    err != null &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

function extractHttpStatus(err: unknown): number | undefined {
  if (err != null && typeof err === "object" && "status" in err) {
    const status = (err as { status?: number }).status;
    if (typeof status === "number") return status;
  }

  if (err instanceof Error) {
    const statusMatch = err.message.match(/\((\d{3})\)/);
    if (!statusMatch) return undefined;
    const status = Number.parseInt(statusMatch[1], 10);
    return Number.isFinite(status) ? status : undefined;
  }

  return undefined;
}

function resolveReplayFailureStage(
  err: unknown,
  context: ReplayFailureContext | undefined,
): ReplayFailureStage | undefined {
  if (!context?.stage) return undefined;
  const status = extractHttpStatus(err);
  if (
    context.stage === "reply_generation" &&
    status !== undefined &&
    status >= 400 &&
    status < 500
  ) {
    return "provider_validation";
  }
  return context.stage;
}

function parseRawPayload(
  rawPayload: string | null,
): Record<string, unknown> | undefined {
  if (!rawPayload) return undefined;
  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function buildDeadLetterErrorMessage(
  errorMsg: string,
  err: unknown,
  context: ReplayFailureContext | undefined,
): string {
  const stage = resolveReplayFailureStage(err, context);
  const labels = [stage, context?.retryClass, context?.replayMode].filter(
    (
      value,
    ): value is Exclude<
      ReplayFailureContext["stage"] | RetryClass | ReplayMode,
      undefined
    > => typeof value === "string" && value.length > 0,
  );
  if (labels.length === 0) return errorMsg;

  const suffix = [
    context?.externalChatId
      ? `externalChatId=${context.externalChatId}`
      : undefined,
    context?.slackThreadTs ? `threadTs=${context.slackThreadTs}` : undefined,
    context?.slackMessageTs
      ? `messageTs=${context.slackMessageTs}`
      : undefined,
  ].filter((value): value is string => typeof value === "string");

  return `${labels.join("/")}: ${errorMsg}${
    suffix.length > 0 ? ` [${suffix.join(" ")}]` : ""
  }`;
}

function buildReplayFailurePayload(
  errorMsg: string,
  err: unknown,
  context: ReplayFailureContext | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;

  const stage = resolveReplayFailureStage(err, context);
  const payload: Record<string, unknown> = {
    reason: errorMsg,
    ...(stage ? { stage } : {}),
    ...(context.sourceChannel ? { sourceChannel: context.sourceChannel } : {}),
    ...(context.retryClass ? { retryClass: context.retryClass } : {}),
    ...(context.replayMode ? { replayMode: context.replayMode } : {}),
    ...(context.externalChatId
      ? { externalChatId: context.externalChatId }
      : {}),
    ...(context.replyCallbackUrl
      ? { replyCallbackUrl: context.replyCallbackUrl }
      : {}),
    ...(context.slackThreadTs ? { threadTs: context.slackThreadTs } : {}),
    ...(context.slackMessageTs ? { messageTs: context.slackMessageTs } : {}),
  };

  return Object.keys(payload).length > 0 ? payload : undefined;
}

function withReplayFailurePayload(
  rawPayload: string | null,
  replayFailure: Record<string, unknown> | undefined,
): string | undefined {
  if (!replayFailure) return undefined;
  const payload = parseRawPayload(rawPayload);
  if (!payload) return undefined;
  return JSON.stringify({
    ...payload,
    [LAST_REPLAY_FAILURE_KEY]: replayFailure,
  });
}

function clearReplayFailurePayload(
  rawPayload: string | null,
): string | undefined {
  const payload = parseRawPayload(rawPayload);
  if (!payload || !(LAST_REPLAY_FAILURE_KEY in payload)) return undefined;
  const { [LAST_REPLAY_FAILURE_KEY]: _ignored, ...rest } = payload;
  return JSON.stringify(rest);
}

/**
 * Record a processing failure. Classifies the error to decide whether
 * the event should be retried (status='failed') or dead-lettered
 * (status='dead_letter') when the error is fatal or max attempts
 * are exhausted.
 */
export function recordProcessingFailure(
  eventId: string,
  err: unknown,
  context?: ReplayFailureContext,
): void {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select({
      attempts: channelInboundEvents.processingAttempts,
      rawPayload: channelInboundEvents.rawPayload,
    })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();

  const attempts = (row?.attempts ?? 0) + 1;
  const category = classifyError(err);
  const errorMsg = errorMessage(err);

  if (category === "fatal" || attempts >= RETRY_MAX_ATTEMPTS) {
    const replayFailurePayload = withReplayFailurePayload(
      row?.rawPayload ?? null,
      buildReplayFailurePayload(errorMsg, err, context),
    );
    db.update(channelInboundEvents)
      .set({
        processingStatus: "dead_letter",
        processingAttempts: attempts,
        lastProcessingError: buildDeadLetterErrorMessage(
          errorMsg,
          err,
          context,
        ),
        retryAfter: null,
        ...(replayFailurePayload ? { rawPayload: replayFailurePayload } : {}),
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
 * Record an outbound callback delivery failure without changing the processing
 * status. Delivery uses its own retry budget so a turn that needed processing
 * retries still gets a full delivery retry window.
 */
export function recordDeliveryFailure(
  eventId: string,
  err: unknown,
  context?: ReplayFailureContext,
): void {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select({
      attempts: channelInboundEvents.deliveryAttempts,
      rawPayload: channelInboundEvents.rawPayload,
    })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();

  const attempts = (row?.attempts ?? 0) + 1;
  const category = classifyError(err);
  const errorMsg = errorMessage(err);

  if (category === "fatal" || attempts >= RETRY_MAX_ATTEMPTS) {
    const replayFailurePayload = withReplayFailurePayload(
      row?.rawPayload ?? null,
      buildReplayFailurePayload(errorMsg, err, context),
    );
    db.update(channelInboundEvents)
      .set({
        deliveryStatus: "dead_letter",
        deliveryAttempts: attempts,
        lastProcessingError: buildDeadLetterErrorMessage(
          errorMsg,
          err,
          context,
        ),
        retryAfter: null,
        ...(replayFailurePayload ? { rawPayload: replayFailurePayload } : {}),
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId))
      .run();
  } else {
    const delay = retryDelayForAttempt(attempts);
    db.update(channelInboundEvents)
      .set({
        deliveryStatus: "failed",
        deliveryAttempts: attempts,
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
  context?: ReplayFailureContext,
): void {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select({
      attempts: channelInboundEvents.processingAttempts,
      rawPayload: channelInboundEvents.rawPayload,
    })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();

  const attempts = (row?.attempts ?? 0) + 1;

  if (attempts >= RETRY_MAX_ATTEMPTS) {
    const replayFailurePayload = withReplayFailurePayload(
      row?.rawPayload ?? null,
      buildReplayFailurePayload(errorMessage, errorMessage, context),
    );
    db.update(channelInboundEvents)
      .set({
        processingStatus: "dead_letter",
        processingAttempts: attempts,
        lastProcessingError: buildDeadLetterErrorMessage(
          errorMessage,
          errorMessage,
          context,
        ),
        retryAfter: null,
        ...(replayFailurePayload ? { rawPayload: replayFailurePayload } : {}),
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

/** Fetch callback deliveries eligible for retry without rerunning processing. */
export function getRetryableDeliveryEvents(limit = 20): Array<{
  id: string;
  conversationId: string;
  messageId: string | null;
  processingAttempts: number;
  rawPayload: string | null;
  deliveredSegmentCount: number;
}> {
  const db = getDb();
  const now = Date.now();
  return db
    .select({
      id: channelInboundEvents.id,
      conversationId: channelInboundEvents.conversationId,
      messageId: channelInboundEvents.messageId,
      processingAttempts: channelInboundEvents.processingAttempts,
      rawPayload: channelInboundEvents.rawPayload,
      deliveredSegmentCount: channelInboundEvents.deliveredSegmentCount,
    })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.processingStatus, "processed"),
        eq(channelInboundEvents.deliveryStatus, "failed"),
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
    .where(
      or(
        eq(channelInboundEvents.processingStatus, "dead_letter"),
        and(
          eq(channelInboundEvents.processingStatus, "processed"),
          eq(channelInboundEvents.deliveryStatus, "dead_letter"),
        ),
      ),
    )
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
      .select({
        id: channelInboundEvents.id,
        processingStatus: channelInboundEvents.processingStatus,
        deliveryStatus: channelInboundEvents.deliveryStatus,
        rawPayload: channelInboundEvents.rawPayload,
      })
      .from(channelInboundEvents)
      .where(
        and(
          eq(channelInboundEvents.id, id),
          or(
            eq(channelInboundEvents.processingStatus, "dead_letter"),
            and(
              eq(channelInboundEvents.processingStatus, "processed"),
              eq(channelInboundEvents.deliveryStatus, "dead_letter"),
            ),
          ),
        ),
      )
      .get();
    if (!existing) continue;

    const clearedReplayFailurePayload = clearReplayFailurePayload(
      existing.rawPayload ?? null,
    );
    if (existing.processingStatus === "dead_letter") {
      db.update(channelInboundEvents)
        .set({
          processingStatus: "failed",
          processingAttempts: 0,
          lastProcessingError: null,
          retryAfter: now,
          ...(clearedReplayFailurePayload
            ? { rawPayload: clearedReplayFailurePayload }
            : {}),
          updatedAt: now,
        })
        .where(eq(channelInboundEvents.id, id))
        .run();
    } else {
      db.update(channelInboundEvents)
        .set({
          deliveryStatus: "failed",
          deliveryAttempts: 0,
          lastProcessingError: null,
          retryAfter: now,
          ...(clearedReplayFailurePayload
            ? { rawPayload: clearedReplayFailurePayload }
            : {}),
          updatedAt: now,
        })
        .where(eq(channelInboundEvents.id, id))
        .run();
    }
    count++;
  }
  return count;
}

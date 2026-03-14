/**
 * Delivery audit records for notifications.
 *
 * Each row represents a single attempt to deliver a notification decision
 * to a specific channel and destination. Multiple attempts for the same
 * (decision, channel, destination) are tracked via the `attempt` counter.
 */

import { and, eq } from "drizzle-orm";

import { getDb, rawChanges } from "../memory/db.js";
import { notificationDeliveries } from "../memory/schema.js";
import type {
  NotificationChannel,
  NotificationDeliveryStatus,
} from "./types.js";

export interface NotificationDeliveryRow {
  id: string;
  notificationDecisionId: string;
  channel: string;
  destination: string;
  status: string;
  attempt: number;
  renderedTitle: string | null;
  renderedBody: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: number | null;
  conversationId: string | null;
  messageId: string | null;
  conversationStrategy: string | null;
  threadAction: string | null;
  threadTargetConversationId: string | null;
  threadDecisionFallbackUsed: number | null;
  clientDeliveryStatus: string | null;
  clientDeliveryError: string | null;
  clientDeliveryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function rowToDelivery(
  row: typeof notificationDeliveries.$inferSelect,
): NotificationDeliveryRow {
  return {
    id: row.id,
    notificationDecisionId: row.notificationDecisionId,
    channel: row.channel,
    destination: row.destination,
    status: row.status,
    attempt: row.attempt,
    renderedTitle: row.renderedTitle,
    renderedBody: row.renderedBody,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    sentAt: row.sentAt,
    conversationId: row.conversationId,
    messageId: row.messageId,
    conversationStrategy: row.conversationStrategy,
    threadAction: row.threadAction,
    threadTargetConversationId: row.threadTargetConversationId,
    threadDecisionFallbackUsed: row.threadDecisionFallbackUsed,
    clientDeliveryStatus: row.clientDeliveryStatus,
    clientDeliveryError: row.clientDeliveryError,
    clientDeliveryAt: row.clientDeliveryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateDeliveryParams {
  id: string;
  notificationDecisionId: string;
  channel: NotificationChannel;
  destination: string;
  status: NotificationDeliveryStatus;
  attempt: number;
  renderedTitle?: string;
  renderedBody?: string;
  errorCode?: string;
  errorMessage?: string;
  sentAt?: number;
  conversationId?: string;
  messageId?: string;
  conversationStrategy?: string;
  threadAction?: string;
  threadTargetConversationId?: string;
  threadDecisionFallbackUsed?: boolean;
}

/** Create a new delivery audit record. */
export function createDelivery(
  params: CreateDeliveryParams,
): NotificationDeliveryRow {
  const db = getDb();
  const now = Date.now();

  const row = {
    id: params.id,
    notificationDecisionId: params.notificationDecisionId,
    channel: params.channel,
    destination: params.destination,
    status: params.status,
    attempt: params.attempt,
    renderedTitle: params.renderedTitle ?? null,
    renderedBody: params.renderedBody ?? null,
    errorCode: params.errorCode ?? null,
    errorMessage: params.errorMessage ?? null,
    sentAt: params.sentAt ?? null,
    conversationId: params.conversationId ?? null,
    messageId: params.messageId ?? null,
    conversationStrategy: params.conversationStrategy ?? null,
    threadAction: params.threadAction ?? null,
    threadTargetConversationId: params.threadTargetConversationId ?? null,
    threadDecisionFallbackUsed:
      params.threadDecisionFallbackUsed != null
        ? params.threadDecisionFallbackUsed
          ? 1
          : 0
        : null,
    clientDeliveryStatus: null,
    clientDeliveryError: null,
    clientDeliveryAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(notificationDeliveries).values(row).run();

  return row;
}

/** Update the status of an existing delivery record. */
export function updateDeliveryStatus(
  id: string,
  status: NotificationDeliveryStatus,
  error?: { code?: string; message?: string },
): boolean {
  const db = getDb();
  const now = Date.now();

  const updates: Record<string, unknown> = { status, updatedAt: now };
  if (status === "sent") {
    updates.sentAt = now;
  }
  if (error?.code) {
    updates.errorCode = error.code;
  }
  if (error?.message) {
    updates.errorMessage = error.message;
  }

  db.update(notificationDeliveries)
    .set(updates)
    .where(eq(notificationDeliveries.id, id))
    .run();

  return rawChanges() > 0;
}

/** Check whether a delivery already exists for a given decision+channel pair. */
export function findDeliveryByDecisionAndChannel(
  decisionId: string,
  channel: NotificationChannel,
): NotificationDeliveryRow | undefined {
  const db = getDb();
  const row = db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.notificationDecisionId, decisionId),
        eq(notificationDeliveries.channel, channel),
      ),
    )
    .get();
  return row ? rowToDelivery(row) : undefined;
}

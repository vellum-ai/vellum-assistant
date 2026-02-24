/**
 * Store for cross-channel guardian action requests and deliveries.
 *
 * Guardian action requests are created when a voice call's ASK_GUARDIAN
 * marker fires, and deliveries track per-channel dispatch (telegram, sms, mac).
 * Resolution uses first-response-wins semantics: the first channel to
 * answer resolves the request and all other deliveries are marked answered.
 */

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import {
  guardianActionRequests,
  guardianActionDeliveries,
} from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardianActionRequestStatus = 'pending' | 'answered' | 'expired' | 'cancelled';
export type GuardianActionDeliveryStatus = 'pending' | 'sent' | 'failed' | 'answered' | 'expired' | 'cancelled';

export interface GuardianActionRequest {
  id: string;
  assistantId: string;
  kind: string;
  sourceChannel: string;
  sourceConversationId: string;
  callSessionId: string;
  pendingQuestionId: string;
  questionText: string;
  requestCode: string;
  status: GuardianActionRequestStatus;
  answerText: string | null;
  answeredByChannel: string | null;
  answeredByExternalUserId: string | null;
  answeredAt: number | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface GuardianActionDelivery {
  id: string;
  requestId: string;
  destinationChannel: string;
  destinationConversationId: string | null;
  destinationChatId: string | null;
  destinationExternalUserId: string | null;
  status: GuardianActionDeliveryStatus;
  sentAt: number | null;
  respondedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRequest(row: typeof guardianActionRequests.$inferSelect): GuardianActionRequest {
  return {
    id: row.id,
    assistantId: row.assistantId,
    kind: row.kind,
    sourceChannel: row.sourceChannel,
    sourceConversationId: row.sourceConversationId,
    callSessionId: row.callSessionId,
    pendingQuestionId: row.pendingQuestionId,
    questionText: row.questionText,
    requestCode: row.requestCode,
    status: row.status as GuardianActionRequestStatus,
    answerText: row.answerText,
    answeredByChannel: row.answeredByChannel,
    answeredByExternalUserId: row.answeredByExternalUserId,
    answeredAt: row.answeredAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDelivery(row: typeof guardianActionDeliveries.$inferSelect): GuardianActionDelivery {
  return {
    id: row.id,
    requestId: row.requestId,
    destinationChannel: row.destinationChannel,
    destinationConversationId: row.destinationConversationId,
    destinationChatId: row.destinationChatId,
    destinationExternalUserId: row.destinationExternalUserId,
    status: row.status as GuardianActionDeliveryStatus,
    sentAt: row.sentAt,
    respondedAt: row.respondedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Generate a short human-readable request code (6 hex chars). */
function generateRequestCode(): string {
  return uuid().replace(/-/g, '').slice(0, 6).toUpperCase();
}

// ---------------------------------------------------------------------------
// Guardian Action Requests
// ---------------------------------------------------------------------------

export function createGuardianActionRequest(params: {
  assistantId?: string;
  kind: string;
  sourceChannel: string;
  sourceConversationId: string;
  callSessionId: string;
  pendingQuestionId: string;
  questionText: string;
  expiresAt: number;
}): GuardianActionRequest {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    assistantId: params.assistantId ?? 'self',
    kind: params.kind,
    sourceChannel: params.sourceChannel,
    sourceConversationId: params.sourceConversationId,
    callSessionId: params.callSessionId,
    pendingQuestionId: params.pendingQuestionId,
    questionText: params.questionText,
    requestCode: generateRequestCode(),
    status: 'pending' as const,
    answerText: null,
    answeredByChannel: null,
    answeredByExternalUserId: null,
    answeredAt: null,
    expiresAt: params.expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(guardianActionRequests).values(row).run();
  return rowToRequest(row);
}

export function getGuardianActionRequest(id: string): GuardianActionRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(guardianActionRequests)
    .where(eq(guardianActionRequests.id, id))
    .get();
  return row ? rowToRequest(row) : null;
}

export function getByPendingQuestionId(questionId: string): GuardianActionRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(guardianActionRequests)
    .where(eq(guardianActionRequests.pendingQuestionId, questionId))
    .get();
  return row ? rowToRequest(row) : null;
}

/**
 * First-response-wins resolution. Checks that the request is still
 * 'pending' before updating; returns the updated request on success
 * or null if the request was already resolved.
 */
export function resolveGuardianActionRequest(
  id: string,
  answerText: string,
  answeredByChannel: string,
  answeredByExternalUserId?: string,
): GuardianActionRequest | null {
  const db = getDb();
  const now = Date.now();

  // Atomically check-and-update: only update if status is still 'pending'
  db.update(guardianActionRequests)
    .set({
      status: 'answered',
      answerText,
      answeredByChannel,
      answeredByExternalUserId: answeredByExternalUserId ?? null,
      answeredAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(guardianActionRequests.id, id),
        eq(guardianActionRequests.status, 'pending'),
      ),
    )
    .run();

  // Check if the update took effect
  const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
  const changes = raw.query('SELECT changes() as c').get() as { c: number };
  if (changes.c === 0) return null;

  // Mark all deliveries as 'answered'
  db.update(guardianActionDeliveries)
    .set({ status: 'answered', respondedAt: now, updatedAt: now })
    .where(eq(guardianActionDeliveries.requestId, id))
    .run();

  return getGuardianActionRequest(id);
}

/**
 * Expire a guardian action request and all its deliveries.
 */
export function expireGuardianActionRequest(id: string): void {
  const db = getDb();
  const now = Date.now();

  db.update(guardianActionRequests)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(guardianActionRequests.id, id),
        eq(guardianActionRequests.status, 'pending'),
      ),
    )
    .run();

  db.update(guardianActionDeliveries)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(guardianActionDeliveries.requestId, id),
        eq(guardianActionDeliveries.status, 'pending'),
      ),
    )
    .run();
}

/**
 * Cancel a guardian action request and all its deliveries.
 */
export function cancelGuardianActionRequest(id: string): void {
  const db = getDb();
  const now = Date.now();

  db.update(guardianActionRequests)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(guardianActionRequests.id, id),
        eq(guardianActionRequests.status, 'pending'),
      ),
    )
    .run();

  db.update(guardianActionDeliveries)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(guardianActionDeliveries.requestId, id),
        eq(guardianActionDeliveries.status, 'pending'),
      ),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Guardian Action Deliveries
// ---------------------------------------------------------------------------

export function createGuardianActionDelivery(params: {
  requestId: string;
  destinationChannel: string;
  destinationConversationId?: string;
  destinationChatId?: string;
  destinationExternalUserId?: string;
}): GuardianActionDelivery {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    requestId: params.requestId,
    destinationChannel: params.destinationChannel,
    destinationConversationId: params.destinationConversationId ?? null,
    destinationChatId: params.destinationChatId ?? null,
    destinationExternalUserId: params.destinationExternalUserId ?? null,
    status: 'pending' as const,
    sentAt: null,
    respondedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(guardianActionDeliveries).values(row).run();
  return rowToDelivery(row);
}

/**
 * Look up pending deliveries for a specific destination.
 * Used by inbound message routing to match incoming answers to deliveries.
 */
export function getPendingDeliveriesByDestination(
  assistantId: string,
  channel: string,
  chatId: string,
): GuardianActionDelivery[] {
  const db = getDb();

  // Join deliveries with requests to filter by assistantId
  const rows = db
    .select({
      delivery: guardianActionDeliveries,
    })
    .from(guardianActionDeliveries)
    .innerJoin(
      guardianActionRequests,
      eq(guardianActionDeliveries.requestId, guardianActionRequests.id),
    )
    .where(
      and(
        eq(guardianActionRequests.assistantId, assistantId),
        eq(guardianActionRequests.status, 'pending'),
        eq(guardianActionDeliveries.destinationChannel, channel),
        eq(guardianActionDeliveries.destinationChatId, chatId),
        eq(guardianActionDeliveries.status, 'sent'),
      ),
    )
    .all();

  return rows.map((r) => rowToDelivery(r.delivery));
}

export function updateDeliveryStatus(
  deliveryId: string,
  status: GuardianActionDeliveryStatus,
  error?: string,
): void {
  const db = getDb();
  const now = Date.now();

  const updates: Record<string, unknown> = { status, updatedAt: now };
  if (status === 'sent') updates.sentAt = now;
  if (status === 'answered') updates.respondedAt = now;
  if (error !== undefined) updates.lastError = error;

  db.update(guardianActionDeliveries)
    .set(updates)
    .where(eq(guardianActionDeliveries.id, deliveryId))
    .run();
}

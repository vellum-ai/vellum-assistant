/**
 * Store for cross-channel guardian action requests and deliveries.
 *
 * Guardian action requests are created when a voice call's ASK_GUARDIAN
 * marker fires, and deliveries track per-channel dispatch (telegram, mac).
 * Resolution uses first-response-wins semantics: the first channel to
 * answer resolves the request and all other deliveries are marked answered.
 */

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db-connection.js";
import { rawChanges } from "./raw-query.js";
import { guardianActionDeliveries, guardianActionRequests } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardianActionRequestStatus =
  | "pending"
  | "answered"
  | "expired"
  | "cancelled";
export type GuardianActionDeliveryStatus =
  | "pending"
  | "sent"
  | "failed"
  | "answered"
  | "expired"
  | "cancelled";
export type ExpiredReason =
  | "call_timeout"
  | "sweep_timeout"
  | "cancelled"
  | "superseded";
export type FollowupState =
  | "none"
  | "awaiting_guardian_choice"
  | "dispatching"
  | "completed"
  | "declined"
  | "failed";
/** Follow-up action recorded on a request row (column retained). */
export type FollowupAction = "call_back" | "decline";

export interface GuardianActionRequest {
  id: string;
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
  expiredReason: ExpiredReason | null;
  followupState: FollowupState;
  lateAnswerText: string | null;
  lateAnsweredAt: number | null;
  followupAction: FollowupAction | null;
  followupCompletedAt: number | null;
  toolName: string | null;
  inputDigest: string | null;
  supersededByRequestId: string | null;
  supersededAt: number | null;
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

function rowToRequest(
  row: typeof guardianActionRequests.$inferSelect,
): GuardianActionRequest {
  return {
    id: row.id,
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
    expiredReason: (row.expiredReason as ExpiredReason) ?? null,
    followupState: (row.followupState as FollowupState) ?? "none",
    lateAnswerText: row.lateAnswerText ?? null,
    lateAnsweredAt: row.lateAnsweredAt ?? null,
    followupAction: (row.followupAction as FollowupAction) ?? null,
    followupCompletedAt: row.followupCompletedAt ?? null,
    toolName: row.toolName ?? null,
    inputDigest: row.inputDigest ?? null,
    supersededByRequestId: row.supersededByRequestId ?? null,
    supersededAt: row.supersededAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDelivery(
  row: typeof guardianActionDeliveries.$inferSelect,
): GuardianActionDelivery {
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
  return uuid().replace(/-/g, "").slice(0, 6).toUpperCase();
}

// ---------------------------------------------------------------------------
// Guardian Action Requests
// ---------------------------------------------------------------------------

/**
 * @internal Test-only helper. Production code should create guardian requests
 * via `createCanonicalGuardianRequest` in canonical-guardian-store.ts.
 * This function is retained solely so that existing test fixtures that seed
 * legacy guardian action rows continue to compile.
 */
export function createGuardianActionRequest(params: {
  kind: string;
  sourceChannel: string;
  sourceConversationId: string;
  callSessionId: string;
  pendingQuestionId: string;
  questionText: string;
  expiresAt: number;
  toolName?: string;
  inputDigest?: string;
}): GuardianActionRequest {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    kind: params.kind,
    sourceChannel: params.sourceChannel,
    sourceConversationId: params.sourceConversationId,
    callSessionId: params.callSessionId,
    pendingQuestionId: params.pendingQuestionId,
    questionText: params.questionText,
    requestCode: generateRequestCode(),
    status: "pending" as const,
    answerText: null,
    answeredByChannel: null,
    answeredByExternalUserId: null,
    answeredAt: null,
    expiresAt: params.expiresAt,
    expiredReason: null,
    followupState: "none" as const,
    lateAnswerText: null,
    lateAnsweredAt: null,
    followupAction: null,
    followupCompletedAt: null,
    toolName: params.toolName ?? null,
    inputDigest: params.inputDigest ?? null,
    supersededByRequestId: null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(guardianActionRequests).values(row).run();
  return rowToRequest(row);
}

export function getGuardianActionRequest(
  id: string,
): GuardianActionRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(guardianActionRequests)
    .where(eq(guardianActionRequests.id, id))
    .get();
  return row ? rowToRequest(row) : null;
}

/**
 * Find the most recent pending guardian action request for a given call session.
 * Used by the consultation timeout handler to mark the linked request as timed out.
 */
export function getPendingRequestByCallSessionId(
  callSessionId: string,
): GuardianActionRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(guardianActionRequests)
    .where(
      and(
        eq(guardianActionRequests.callSessionId, callSessionId),
        eq(guardianActionRequests.status, "pending"),
      ),
    )
    .orderBy(desc(guardianActionRequests.createdAt))
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
      status: "answered",
      answerText,
      answeredByChannel,
      answeredByExternalUserId: answeredByExternalUserId ?? null,
      answeredAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(guardianActionRequests.id, id),
        eq(guardianActionRequests.status, "pending"),
      ),
    )
    .run();

  // Check if the update took effect
  if (rawChanges() === 0) return null;

  // Mark all deliveries as 'answered'
  db.update(guardianActionDeliveries)
    .set({ status: "answered", respondedAt: now, updatedAt: now })
    .where(eq(guardianActionDeliveries.requestId, id))
    .run();

  return getGuardianActionRequest(id);
}

/**
 * Expire a guardian action request and all its deliveries.
 */
export function expireGuardianActionRequest(
  id: string,
  reason: ExpiredReason,
): void {
  const db = getDb();
  const now = Date.now();

  db.update(guardianActionRequests)
    .set({
      status: "expired",
      expiredReason: reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(guardianActionRequests.id, id),
        eq(guardianActionRequests.status, "pending"),
      ),
    )
    .run();

  db.update(guardianActionDeliveries)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(guardianActionDeliveries.requestId, id),
        inArray(guardianActionDeliveries.status, ["pending", "sent"]),
      ),
    )
    .run();
}

/**
 * Supersede a pending guardian action request: mark it expired with
 * reason='superseded', record the replacement request ID and timestamp,
 * and expire its active deliveries.
 *
 * Returns the updated request on success, or null if the request was
 * not in 'pending' status (first-writer-wins).
 */
export function supersedeGuardianActionRequest(
  id: string,
  supersededByRequestId: string,
): GuardianActionRequest | null {
  const db = getDb();
  const now = Date.now();

  db.update(guardianActionRequests)
    .set({
      status: "expired",
      expiredReason: "superseded",
      supersededByRequestId,
      supersededAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(guardianActionRequests.id, id),
        eq(guardianActionRequests.status, "pending"),
      ),
    )
    .run();

  if (rawChanges() === 0) return null;

  // Also expire active deliveries
  db.update(guardianActionDeliveries)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(guardianActionDeliveries.requestId, id),
        inArray(guardianActionDeliveries.status, ["pending", "sent"]),
      ),
    )
    .run();

  return getGuardianActionRequest(id);
}

/**
 * Get all pending guardian action requests that have expired.
 */
export function getExpiredGuardianActionRequests(): GuardianActionRequest[] {
  const db = getDb();
  const now = Date.now();
  return db
    .select()
    .from(guardianActionRequests)
    .where(
      and(
        eq(guardianActionRequests.status, "pending"),
        lt(guardianActionRequests.expiresAt, now),
      ),
    )
    .all()
    .map(rowToRequest);
}

/**
 * Get all deliveries for a specific request.
 */
export function getDeliveriesByRequestId(
  requestId: string,
): GuardianActionDelivery[] {
  const db = getDb();
  return db
    .select()
    .from(guardianActionDeliveries)
    .where(eq(guardianActionDeliveries.requestId, requestId))
    .all()
    .map(rowToDelivery);
}

/**
 * Cancel a guardian action request and all its deliveries.
 */
export function cancelGuardianActionRequest(id: string): void {
  const db = getDb();
  const now = Date.now();

  db.update(guardianActionRequests)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(guardianActionRequests.id, id),
        eq(guardianActionRequests.status, "pending"),
      ),
    )
    .run();

  db.update(guardianActionDeliveries)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(guardianActionDeliveries.requestId, id),
        inArray(guardianActionDeliveries.status, ["pending", "sent"]),
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
    status: "pending" as const,
    sentAt: null,
    respondedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(guardianActionDeliveries).values(row).run();
  return rowToDelivery(row);
}

export function updateDeliveryStatus(
  deliveryId: string,
  status: GuardianActionDeliveryStatus,
  error?: string,
): void {
  const db = getDb();
  const now = Date.now();

  const updates: Record<string, unknown> = { status, updatedAt: now };
  if (status === "sent") updates.sentAt = now;
  if (status === "answered") updates.respondedAt = now;
  if (error !== undefined) updates.lastError = error;

  db.update(guardianActionDeliveries)
    .set(updates)
    .where(eq(guardianActionDeliveries.id, deliveryId))
    .run();
}

/**
 * Store for canonical guardian requests and deliveries.
 *
 * Unifies voice guardian action requests/deliveries and channel guardian
 * approval requests into a single persistence model.  Resolution uses
 * compare-and-swap (CAS) semantics: the first writer to transition a
 * request from the expected status wins.
 */

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import { getDb, rawChanges } from './db.js';
import {
  canonicalGuardianDeliveries,
  canonicalGuardianRequests,
} from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanonicalRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface CanonicalGuardianRequest {
  id: string;
  kind: string;
  sourceType: string;
  sourceChannel: string | null;
  conversationId: string | null;
  requesterExternalUserId: string | null;
  guardianExternalUserId: string | null;
  callSessionId: string | null;
  pendingQuestionId: string | null;
  questionText: string | null;
  requestCode: string | null;
  toolName: string | null;
  inputDigest: string | null;
  status: CanonicalRequestStatus;
  answerText: string | null;
  decidedByExternalUserId: string | null;
  followupState: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalGuardianDelivery {
  id: string;
  requestId: string;
  destinationChannel: string;
  destinationConversationId: string | null;
  destinationChatId: string | null;
  destinationMessageId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Request code generation
// ---------------------------------------------------------------------------

/** Generate a short human-readable request code (6 hex chars, uppercase). */
export function generateCanonicalRequestCode(): string {
  return uuid().replace(/-/g, '').slice(0, 6).toUpperCase();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRequest(row: typeof canonicalGuardianRequests.$inferSelect): CanonicalGuardianRequest {
  return {
    id: row.id,
    kind: row.kind,
    sourceType: row.sourceType,
    sourceChannel: row.sourceChannel,
    conversationId: row.conversationId,
    requesterExternalUserId: row.requesterExternalUserId,
    guardianExternalUserId: row.guardianExternalUserId,
    callSessionId: row.callSessionId,
    pendingQuestionId: row.pendingQuestionId,
    questionText: row.questionText,
    requestCode: row.requestCode,
    toolName: row.toolName,
    inputDigest: row.inputDigest,
    status: row.status as CanonicalRequestStatus,
    answerText: row.answerText,
    decidedByExternalUserId: row.decidedByExternalUserId,
    followupState: row.followupState,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDelivery(row: typeof canonicalGuardianDeliveries.$inferSelect): CanonicalGuardianDelivery {
  return {
    id: row.id,
    requestId: row.requestId,
    destinationChannel: row.destinationChannel,
    destinationConversationId: row.destinationConversationId,
    destinationChatId: row.destinationChatId,
    destinationMessageId: row.destinationMessageId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Canonical Guardian Requests
// ---------------------------------------------------------------------------

export interface CreateCanonicalGuardianRequestParams {
  id?: string;
  kind: string;
  sourceType: string;
  sourceChannel?: string;
  conversationId?: string;
  requesterExternalUserId?: string;
  guardianExternalUserId?: string;
  callSessionId?: string;
  pendingQuestionId?: string;
  questionText?: string;
  requestCode?: string;
  toolName?: string;
  inputDigest?: string;
  status?: CanonicalRequestStatus;
  answerText?: string;
  decidedByExternalUserId?: string;
  followupState?: string;
  expiresAt?: string;
}

export function createCanonicalGuardianRequest(params: CreateCanonicalGuardianRequestParams): CanonicalGuardianRequest {
  const db = getDb();
  const now = new Date().toISOString();
  const id = params.id ?? uuid();

  const row = {
    id,
    kind: params.kind,
    sourceType: params.sourceType,
    sourceChannel: params.sourceChannel ?? null,
    conversationId: params.conversationId ?? null,
    requesterExternalUserId: params.requesterExternalUserId ?? null,
    guardianExternalUserId: params.guardianExternalUserId ?? null,
    callSessionId: params.callSessionId ?? null,
    pendingQuestionId: params.pendingQuestionId ?? null,
    questionText: params.questionText ?? null,
    requestCode: params.requestCode ?? generateCanonicalRequestCode(),
    toolName: params.toolName ?? null,
    inputDigest: params.inputDigest ?? null,
    status: params.status ?? ('pending' as const),
    answerText: params.answerText ?? null,
    decidedByExternalUserId: params.decidedByExternalUserId ?? null,
    followupState: params.followupState ?? null,
    expiresAt: params.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(canonicalGuardianRequests).values(row).run();
  return rowToRequest(row);
}

export function getCanonicalGuardianRequest(id: string): CanonicalGuardianRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(canonicalGuardianRequests)
    .where(eq(canonicalGuardianRequests.id, id))
    .get();
  return row ? rowToRequest(row) : null;
}

/**
 * Look up a canonical guardian request by its short request code.
 * Scoped to pending (unresolved) requests so that codes recycled by older,
 * already-resolved requests do not collide with the active one.
 */
export function getCanonicalGuardianRequestByCode(code: string): CanonicalGuardianRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(canonicalGuardianRequests)
    .where(
      and(
        eq(canonicalGuardianRequests.requestCode, code),
        eq(canonicalGuardianRequests.status, 'pending'),
      ),
    )
    .get();
  return row ? rowToRequest(row) : null;
}

export interface ListCanonicalGuardianRequestsFilters {
  status?: CanonicalRequestStatus;
  guardianExternalUserId?: string;
  conversationId?: string;
  sourceType?: string;
  kind?: string;
}

export function listCanonicalGuardianRequests(filters?: ListCanonicalGuardianRequestsFilters): CanonicalGuardianRequest[] {
  const db = getDb();

  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(canonicalGuardianRequests.status, filters.status));
  }
  if (filters?.guardianExternalUserId) {
    conditions.push(eq(canonicalGuardianRequests.guardianExternalUserId, filters.guardianExternalUserId));
  }
  if (filters?.conversationId) {
    conditions.push(eq(canonicalGuardianRequests.conversationId, filters.conversationId));
  }
  if (filters?.sourceType) {
    conditions.push(eq(canonicalGuardianRequests.sourceType, filters.sourceType));
  }
  if (filters?.kind) {
    conditions.push(eq(canonicalGuardianRequests.kind, filters.kind));
  }

  if (conditions.length === 0) {
    return db.select().from(canonicalGuardianRequests).all().map(rowToRequest);
  }

  return db
    .select()
    .from(canonicalGuardianRequests)
    .where(and(...conditions))
    .all()
    .map(rowToRequest);
}

export interface UpdateCanonicalGuardianRequestParams {
  status?: CanonicalRequestStatus;
  answerText?: string;
  decidedByExternalUserId?: string;
  followupState?: string;
  expiresAt?: string;
}

export function updateCanonicalGuardianRequest(
  id: string,
  updates: UpdateCanonicalGuardianRequestParams,
): CanonicalGuardianRequest | null {
  const db = getDb();
  const now = new Date().toISOString();

  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.status !== undefined) setValues.status = updates.status;
  if (updates.answerText !== undefined) setValues.answerText = updates.answerText;
  if (updates.decidedByExternalUserId !== undefined) setValues.decidedByExternalUserId = updates.decidedByExternalUserId;
  if (updates.followupState !== undefined) setValues.followupState = updates.followupState;
  if (updates.expiresAt !== undefined) setValues.expiresAt = updates.expiresAt;

  db.update(canonicalGuardianRequests)
    .set(setValues)
    .where(eq(canonicalGuardianRequests.id, id))
    .run();

  return getCanonicalGuardianRequest(id);
}

export interface ResolveDecision {
  status: CanonicalRequestStatus;
  answerText?: string;
  decidedByExternalUserId?: string;
}

/**
 * Compare-and-swap resolve: only transitions the request from `expectedStatus`
 * to the new status atomically. Returns the updated request on success, or
 * null if the current status did not match `expectedStatus` (first-writer-wins).
 */
export function resolveCanonicalGuardianRequest(
  id: string,
  expectedStatus: CanonicalRequestStatus,
  decision: ResolveDecision,
): CanonicalGuardianRequest | null {
  const db = getDb();
  const now = new Date().toISOString();

  const setValues: Record<string, unknown> = {
    status: decision.status,
    updatedAt: now,
  };
  if (decision.answerText !== undefined) setValues.answerText = decision.answerText;
  if (decision.decidedByExternalUserId !== undefined) setValues.decidedByExternalUserId = decision.decidedByExternalUserId;

  db.update(canonicalGuardianRequests)
    .set(setValues)
    .where(
      and(
        eq(canonicalGuardianRequests.id, id),
        eq(canonicalGuardianRequests.status, expectedStatus),
      ),
    )
    .run();

  if (rawChanges() === 0) return null;

  return getCanonicalGuardianRequest(id);
}

// ---------------------------------------------------------------------------
// Canonical Guardian Deliveries
// ---------------------------------------------------------------------------

export interface CreateCanonicalGuardianDeliveryParams {
  id?: string;
  requestId: string;
  destinationChannel: string;
  destinationConversationId?: string;
  destinationChatId?: string;
  destinationMessageId?: string;
  status?: string;
}

export function createCanonicalGuardianDelivery(params: CreateCanonicalGuardianDeliveryParams): CanonicalGuardianDelivery {
  const db = getDb();
  const now = new Date().toISOString();
  const id = params.id ?? uuid();

  const row = {
    id,
    requestId: params.requestId,
    destinationChannel: params.destinationChannel,
    destinationConversationId: params.destinationConversationId ?? null,
    destinationChatId: params.destinationChatId ?? null,
    destinationMessageId: params.destinationMessageId ?? null,
    status: params.status ?? ('pending' as const),
    createdAt: now,
    updatedAt: now,
  };

  db.insert(canonicalGuardianDeliveries).values(row).run();
  return rowToDelivery(row);
}

export function listCanonicalGuardianDeliveries(requestId: string): CanonicalGuardianDelivery[] {
  const db = getDb();
  return db
    .select()
    .from(canonicalGuardianDeliveries)
    .where(eq(canonicalGuardianDeliveries.requestId, requestId))
    .all()
    .map(rowToDelivery);
}

export interface UpdateCanonicalGuardianDeliveryParams {
  status?: string;
  destinationMessageId?: string;
}

export function updateCanonicalGuardianDelivery(
  id: string,
  updates: UpdateCanonicalGuardianDeliveryParams,
): CanonicalGuardianDelivery | null {
  const db = getDb();
  const now = new Date().toISOString();

  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.status !== undefined) setValues.status = updates.status;
  if (updates.destinationMessageId !== undefined) setValues.destinationMessageId = updates.destinationMessageId;

  db.update(canonicalGuardianDeliveries)
    .set(setValues)
    .where(eq(canonicalGuardianDeliveries.id, id))
    .run();

  const row = db
    .select()
    .from(canonicalGuardianDeliveries)
    .where(eq(canonicalGuardianDeliveries.id, id))
    .get();

  return row ? rowToDelivery(row) : null;
}

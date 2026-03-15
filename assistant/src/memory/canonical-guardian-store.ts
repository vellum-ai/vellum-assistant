/**
 * Store for canonical guardian requests and deliveries.
 *
 * Unifies voice guardian action requests/deliveries and channel guardian
 * approval requests into a single persistence model.  Resolution uses
 * compare-and-swap (CAS) semantics: the first writer to transition a
 * request from the expected status wins.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { IntegrityError } from "../util/errors.js";
import { getDb, rawChanges } from "./db.js";
import {
  canonicalGuardianDeliveries,
  canonicalGuardianRequests,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Expiry helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a canonical request has passed its `expiresAt` deadline.
 * Requests without an `expiresAt` are never considered expired by this check.
 */
export function isRequestExpired(
  request: Pick<CanonicalGuardianRequest, "expiresAt">,
): boolean {
  if (!request.expiresAt) return false;
  return request.expiresAt < Date.now();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanonicalRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export interface CanonicalGuardianRequest {
  id: string;
  kind: string;
  sourceType: string;
  sourceChannel: string | null;
  conversationId: string | null;
  requesterExternalUserId: string | null;
  requesterChatId: string | null;
  guardianExternalUserId: string | null;
  guardianPrincipalId: string | null;
  callSessionId: string | null;
  pendingQuestionId: string | null;
  questionText: string | null;
  requestCode: string | null;
  toolName: string | null;
  inputDigest: string | null;
  status: CanonicalRequestStatus;
  answerText: string | null;
  decidedByExternalUserId: string | null;
  decidedByPrincipalId: string | null;
  followupState: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CanonicalGuardianDelivery {
  id: string;
  requestId: string;
  destinationChannel: string;
  destinationConversationId: string | null;
  destinationChatId: string | null;
  destinationMessageId: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Request code generation
// ---------------------------------------------------------------------------

/**
 * Generate a short human-readable request code (6 hex chars, uppercase).
 *
 * Checks for collisions against existing PENDING canonical requests and
 * retries up to 5 times to avoid code reuse among active requests.
 */
export function generateCanonicalRequestCode(): string {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = uuid().replace(/-/g, "").slice(0, 6).toUpperCase();
    // Only check for collisions among pending requests — resolved requests
    // with the same code are harmless since getCanonicalGuardianRequestByCode
    // already filters by status='pending'.
    const existing = getCanonicalGuardianRequestByCodeInternal(code);
    if (!existing) return code;
  }
  // Last resort: return the code even if it collides (extremely unlikely
  // with 16^6 = ~16.7M possible codes).
  return uuid().replace(/-/g, "").slice(0, 6).toUpperCase();
}

/**
 * Internal code lookup used by the collision checker. Avoids circular
 * dependency with the public getCanonicalGuardianRequestByCode by
 * inlining the same query logic.
 */
function getCanonicalGuardianRequestByCodeInternal(code: string): boolean {
  const db = getDb();
  const row = db
    .select()
    .from(canonicalGuardianRequests)
    .where(
      and(
        eq(canonicalGuardianRequests.requestCode, code),
        eq(canonicalGuardianRequests.status, "pending"),
      ),
    )
    .get();
  return !!row;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRequest(
  row: typeof canonicalGuardianRequests.$inferSelect,
): CanonicalGuardianRequest {
  return {
    id: row.id,
    kind: row.kind,
    sourceType: row.sourceType,
    sourceChannel: row.sourceChannel,
    conversationId: row.conversationId,
    requesterExternalUserId: row.requesterExternalUserId,
    requesterChatId: row.requesterChatId,
    guardianExternalUserId: row.guardianExternalUserId,
    guardianPrincipalId: row.guardianPrincipalId,
    callSessionId: row.callSessionId,
    pendingQuestionId: row.pendingQuestionId,
    questionText: row.questionText,
    requestCode: row.requestCode,
    toolName: row.toolName,
    inputDigest: row.inputDigest,
    status: row.status as CanonicalRequestStatus,
    answerText: row.answerText,
    decidedByExternalUserId: row.decidedByExternalUserId,
    decidedByPrincipalId: row.decidedByPrincipalId,
    followupState: row.followupState,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDelivery(
  row: typeof canonicalGuardianDeliveries.$inferSelect,
): CanonicalGuardianDelivery {
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
  requesterChatId?: string;
  guardianExternalUserId?: string;
  guardianPrincipalId?: string;
  callSessionId?: string;
  pendingQuestionId?: string;
  questionText?: string;
  requestCode?: string;
  toolName?: string;
  inputDigest?: string;
  status?: CanonicalRequestStatus;
  answerText?: string;
  decidedByExternalUserId?: string;
  decidedByPrincipalId?: string;
  followupState?: string;
  expiresAt?: number;
}

/**
 * Request kinds that require a guardian decision (approve/deny). These kinds
 * MUST have a `guardianPrincipalId` bound at creation time so the decision
 * can be attributed to a specific principal. Informational kinds (e.g. status
 * updates) are exempt from this requirement.
 */
const DECISIONABLE_KINDS = new Set([
  "tool_approval",
  "tool_grant_request",
  "pending_question",
  "access_request",
]);

export function createCanonicalGuardianRequest(
  params: CreateCanonicalGuardianRequestParams,
): CanonicalGuardianRequest {
  // Guard: decisionable request kinds must have a principal bound at creation
  // time. This ensures every request that will eventually require a guardian
  // decision is attributable to a specific identity. Informational kinds are
  // exempt — they don't participate in the approval flow.
  if (DECISIONABLE_KINDS.has(params.kind) && !params.guardianPrincipalId) {
    throw new IntegrityError(
      `Cannot create decisionable canonical request of kind '${params.kind}' without guardianPrincipalId`,
    );
  }

  const db = getDb();
  const now = Date.now();
  const id = params.id ?? uuid();

  const row = {
    id,
    kind: params.kind,
    sourceType: params.sourceType,
    sourceChannel: params.sourceChannel ?? null,
    conversationId: params.conversationId ?? null,
    requesterExternalUserId: params.requesterExternalUserId ?? null,
    requesterChatId: params.requesterChatId ?? null,
    guardianExternalUserId: params.guardianExternalUserId ?? null,
    guardianPrincipalId: params.guardianPrincipalId ?? null,
    callSessionId: params.callSessionId ?? null,
    pendingQuestionId: params.pendingQuestionId ?? null,
    questionText: params.questionText ?? null,
    requestCode: params.requestCode ?? generateCanonicalRequestCode(),
    toolName: params.toolName ?? null,
    inputDigest: params.inputDigest ?? null,
    status: params.status ?? ("pending" as const),
    answerText: params.answerText ?? null,
    decidedByExternalUserId: params.decidedByExternalUserId ?? null,
    decidedByPrincipalId: params.decidedByPrincipalId ?? null,
    followupState: params.followupState ?? null,
    expiresAt: params.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(canonicalGuardianRequests).values(row).run();
  return rowToRequest(row);
}

export function getCanonicalGuardianRequest(
  id: string,
): CanonicalGuardianRequest | null {
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
export function getCanonicalGuardianRequestByCode(
  code: string,
): CanonicalGuardianRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(canonicalGuardianRequests)
    .where(
      and(
        eq(canonicalGuardianRequests.requestCode, code),
        eq(canonicalGuardianRequests.status, "pending"),
      ),
    )
    .get();
  return row ? rowToRequest(row) : null;
}

export interface ListCanonicalGuardianRequestsFilters {
  status?: CanonicalRequestStatus;
  guardianExternalUserId?: string;
  guardianPrincipalId?: string;
  requesterExternalUserId?: string;
  conversationId?: string;
  sourceType?: string;
  sourceChannel?: string;
  kind?: string;
  toolName?: string;
}

export function listCanonicalGuardianRequests(
  filters?: ListCanonicalGuardianRequestsFilters,
): CanonicalGuardianRequest[] {
  const db = getDb();

  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(canonicalGuardianRequests.status, filters.status));
  }
  if (filters?.guardianExternalUserId) {
    conditions.push(
      eq(
        canonicalGuardianRequests.guardianExternalUserId,
        filters.guardianExternalUserId,
      ),
    );
  }
  if (filters?.guardianPrincipalId) {
    conditions.push(
      eq(
        canonicalGuardianRequests.guardianPrincipalId,
        filters.guardianPrincipalId,
      ),
    );
  }
  if (filters?.conversationId) {
    conditions.push(
      eq(canonicalGuardianRequests.conversationId, filters.conversationId),
    );
  }
  if (filters?.requesterExternalUserId) {
    conditions.push(
      eq(
        canonicalGuardianRequests.requesterExternalUserId,
        filters.requesterExternalUserId,
      ),
    );
  }
  if (filters?.sourceType) {
    conditions.push(
      eq(canonicalGuardianRequests.sourceType, filters.sourceType),
    );
  }
  if (filters?.sourceChannel) {
    conditions.push(
      eq(canonicalGuardianRequests.sourceChannel, filters.sourceChannel),
    );
  }
  if (filters?.kind) {
    conditions.push(eq(canonicalGuardianRequests.kind, filters.kind));
  }
  if (filters?.toolName) {
    conditions.push(eq(canonicalGuardianRequests.toolName, filters.toolName));
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
  decidedByPrincipalId?: string;
  followupState?: string | null;
  expiresAt?: number;
}

export function updateCanonicalGuardianRequest(
  id: string,
  updates: UpdateCanonicalGuardianRequestParams,
): CanonicalGuardianRequest | null {
  const db = getDb();
  const now = Date.now();

  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.status !== undefined) setValues.status = updates.status;
  if (updates.answerText !== undefined)
    setValues.answerText = updates.answerText;
  if (updates.decidedByExternalUserId !== undefined)
    setValues.decidedByExternalUserId = updates.decidedByExternalUserId;
  if (updates.decidedByPrincipalId !== undefined)
    setValues.decidedByPrincipalId = updates.decidedByPrincipalId;
  if (updates.followupState !== undefined)
    setValues.followupState = updates.followupState;
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
  decidedByPrincipalId?: string;
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
  const now = Date.now();

  const setValues: Record<string, unknown> = {
    status: decision.status,
    updatedAt: now,
  };
  if (decision.answerText !== undefined)
    setValues.answerText = decision.answerText;
  if (decision.decidedByExternalUserId !== undefined)
    setValues.decidedByExternalUserId = decision.decidedByExternalUserId;
  if (decision.decidedByPrincipalId !== undefined)
    setValues.decidedByPrincipalId = decision.decidedByPrincipalId;

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

/**
 * Request kinds whose resolution depends on the in-memory
 * `pendingInteractions` Map. These kinds become unresolvable after a daemon
 * restart because the Map is wiped, so they should be expired on startup.
 *
 * Persistent kinds (`access_request`, `tool_grant_request`) resolve without
 * pending interactions and remain valid across restarts — they must NOT be
 * expired here.
 */
const INTERACTION_BOUND_KINDS = ["tool_approval", "pending_question"];

/**
 * Expire pending interaction-bound canonical guardian requests in a single
 * bulk update.
 *
 * Called at daemon startup to clean up requests that can never be completed
 * because the in-memory pending-interactions Map (which holds session
 * references needed by resolvers) was wiped on restart.
 *
 * Only expires request kinds that depend on in-memory pending interactions
 * (`tool_approval`, `pending_question`). Persistent kinds like
 * `access_request` and `tool_grant_request` resolve without pending
 * interactions and remain valid across restarts.
 *
 * Returns the number of requests transitioned from pending → expired.
 */
export function expireAllPendingCanonicalRequests(): number {
  const db = getDb();
  const now = Date.now();

  db.update(canonicalGuardianRequests)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(canonicalGuardianRequests.status, "pending"),
        inArray(canonicalGuardianRequests.kind, INTERACTION_BOUND_KINDS),
      ),
    )
    .run();

  return rawChanges();
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

export function createCanonicalGuardianDelivery(
  params: CreateCanonicalGuardianDeliveryParams,
): CanonicalGuardianDelivery {
  const db = getDb();
  const now = Date.now();
  const id = params.id ?? uuid();

  const row = {
    id,
    requestId: params.requestId,
    destinationChannel: params.destinationChannel,
    destinationConversationId: params.destinationConversationId ?? null,
    destinationChatId: params.destinationChatId ?? null,
    destinationMessageId: params.destinationMessageId ?? null,
    status: params.status ?? ("pending" as const),
    createdAt: now,
    updatedAt: now,
  };

  db.insert(canonicalGuardianDeliveries).values(row).run();
  return rowToDelivery(row);
}

export function listCanonicalGuardianDeliveries(
  requestId: string,
): CanonicalGuardianDelivery[] {
  const db = getDb();
  return db
    .select()
    .from(canonicalGuardianDeliveries)
    .where(eq(canonicalGuardianDeliveries.requestId, requestId))
    .all()
    .map(rowToDelivery);
}

/**
 * List pending canonical requests that were delivered to a specific
 * destination conversation.
 *
 * This bridges inbound guardian replies (which arrive on the destination
 * conversation) back to their canonical request records. The caller can
 * optionally scope by destination channel when the same conversation ID
 * namespace could exist across channels.
 */
export function listPendingCanonicalGuardianRequestsByDestinationConversation(
  destinationConversationId: string,
  destinationChannel?: string,
): CanonicalGuardianRequest[] {
  const db = getDb();

  const deliveryConditions = [
    eq(
      canonicalGuardianDeliveries.destinationConversationId,
      destinationConversationId,
    ),
  ];
  if (destinationChannel) {
    deliveryConditions.push(
      eq(canonicalGuardianDeliveries.destinationChannel, destinationChannel),
    );
  }

  const deliveries = db
    .select()
    .from(canonicalGuardianDeliveries)
    .where(and(...deliveryConditions))
    .all();

  if (deliveries.length === 0) return [];

  const seenRequestIds = new Set<string>();
  const pendingRequests: CanonicalGuardianRequest[] = [];

  for (const delivery of deliveries) {
    if (seenRequestIds.has(delivery.requestId)) continue;
    seenRequestIds.add(delivery.requestId);

    const request = getCanonicalGuardianRequest(delivery.requestId);
    if (request && request.status === "pending") {
      pendingRequests.push(request);
    }
  }

  return pendingRequests;
}

/**
 * List pending canonical requests that were delivered to a specific
 * destination chat (channel + chatId pair).
 *
 * This bridges inbound guardian replies (which arrive on a specific chat)
 * back to their canonical request records. Unlike the conversation-based
 * variant, this uses the chat-level addressing that channel transports
 * (Telegram) natively provide — critical for voice-originated
 * `pending_question` requests that lack `guardianExternalUserId`.
 */
export function listPendingCanonicalGuardianRequestsByDestinationChat(
  destinationChannel: string,
  destinationChatId: string,
): CanonicalGuardianRequest[] {
  const db = getDb();

  const deliveries = db
    .select()
    .from(canonicalGuardianDeliveries)
    .where(
      and(
        eq(canonicalGuardianDeliveries.destinationChannel, destinationChannel),
        eq(canonicalGuardianDeliveries.destinationChatId, destinationChatId),
      ),
    )
    .all();

  if (deliveries.length === 0) return [];

  const seenRequestIds = new Set<string>();
  const pendingRequests: CanonicalGuardianRequest[] = [];

  for (const delivery of deliveries) {
    if (seenRequestIds.has(delivery.requestId)) continue;
    seenRequestIds.add(delivery.requestId);

    const request = getCanonicalGuardianRequest(delivery.requestId);
    if (request && request.status === "pending") {
      pendingRequests.push(request);
    }
  }

  return pendingRequests;
}

// ---------------------------------------------------------------------------
// Conversation scope helpers
// ---------------------------------------------------------------------------

/**
 * List pending canonical requests in scope for a conversation, unioning:
 *   1. Requests whose source `conversationId` matches the queried conversation.
 *   2. Requests that have a delivery whose `destinationConversationId` matches.
 *
 * When `channel` is provided the delivery-scoped lookup is narrowed to that
 * channel, preventing cross-channel leakage when conversation ID namespaces
 * overlap across channels.
 *
 * Deduplicates by request ID so a request that was both sourced from and
 * delivered to the same conversation only appears once.
 */
export function listPendingRequestsByConversationScope(
  conversationId: string,
  channel?: string,
): CanonicalGuardianRequest[] {
  const bySource = listCanonicalGuardianRequests({
    conversationId,
    status: "pending",
  });

  const byDestination =
    listPendingCanonicalGuardianRequestsByDestinationConversation(
      conversationId,
      channel,
    );

  const seen = new Set<string>();
  const result: CanonicalGuardianRequest[] = [];

  for (const req of bySource) {
    if (!seen.has(req.id) && !isRequestExpired(req)) {
      seen.add(req.id);
      result.push(req);
    }
  }

  for (const req of byDestination) {
    if (!seen.has(req.id) && !isRequestExpired(req)) {
      seen.add(req.id);
      result.push(req);
    }
  }

  return result;
}

/**
 * Check whether a guardian decision's `conversationId` is in scope for a
 * canonical request. A decision is in scope when:
 *   - The request's source `conversationId` matches, OR
 *   - Any recorded delivery has `destinationConversationId` matching
 *     (optionally scoped by `channel` to prevent cross-channel approval
 *     when conversation ID namespaces overlap across channels).
 *
 * Returns `true` when the decision is allowed from the given conversation.
 */
export function isRequestInConversationScope(
  requestId: string,
  conversationId: string,
  channel?: string,
): boolean {
  const request = getCanonicalGuardianRequest(requestId);
  if (!request) return false;

  // Source conversation match
  if (request.conversationId === conversationId) return true;

  // Destination delivery match, optionally scoped by channel
  const deliveries = listCanonicalGuardianDeliveries(requestId);
  return deliveries.some(
    (d) =>
      d.destinationConversationId === conversationId &&
      (!channel || d.destinationChannel === channel),
  );
}

export interface UpdateCanonicalGuardianDeliveryParams {
  status?: string;
  destinationMessageId?: string;
}

// ---------------------------------------------------------------------------
// Call-controller convenience functions
// ---------------------------------------------------------------------------

/**
 * Find the most recent pending canonical guardian request for a given call session.
 * Used by the call-controller's consultation timeout handler.
 */
export function getPendingCanonicalRequestByCallSessionId(
  callSessionId: string,
): CanonicalGuardianRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(canonicalGuardianRequests)
    .where(
      and(
        eq(canonicalGuardianRequests.callSessionId, callSessionId),
        eq(canonicalGuardianRequests.status, "pending"),
      ),
    )
    .orderBy(desc(canonicalGuardianRequests.createdAt))
    .get();
  return row ? rowToRequest(row) : null;
}

/**
 * Find a canonical guardian request by its linked pending question ID.
 * Used after async dispatch completes to locate the newly created request.
 */
export function getCanonicalRequestByPendingQuestionId(
  questionId: string,
): CanonicalGuardianRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(canonicalGuardianRequests)
    .where(eq(canonicalGuardianRequests.pendingQuestionId, questionId))
    .get();
  return row ? rowToRequest(row) : null;
}

/**
 * Expire a canonical guardian request and all its deliveries.
 * Atomically transitions the request from 'pending' to 'expired'.
 */
export function expireCanonicalGuardianRequest(id: string): void {
  const db = getDb();
  const now = Date.now();

  db.update(canonicalGuardianRequests)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(canonicalGuardianRequests.id, id),
        eq(canonicalGuardianRequests.status, "pending"),
      ),
    )
    .run();

  db.update(canonicalGuardianDeliveries)
    .set({ status: "expired", updatedAt: now })
    .where(eq(canonicalGuardianDeliveries.requestId, id))
    .run();
}

export function updateCanonicalGuardianDelivery(
  id: string,
  updates: UpdateCanonicalGuardianDeliveryParams,
): CanonicalGuardianDelivery | null {
  const db = getDb();
  const now = Date.now();

  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.status !== undefined) setValues.status = updates.status;
  if (updates.destinationMessageId !== undefined)
    setValues.destinationMessageId = updates.destinationMessageId;

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

/**
 * Gateway-owned guardian request store.
 *
 * Sole access layer for guardian_requests + guardian_request_deliveries.
 * Resolution uses compare-and-swap (CAS): the first writer to transition a
 * request from the expected status wins.
 */

import type { Database } from "bun:sqlite";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
} from "drizzle-orm";

import { getGatewayDb } from "./connection.js";
import { guardianRequestDeliveries, guardianRequests } from "./schema.js";

/**
 * Raw bun:sqlite client — needed where drizzle's run() hides the changes
 * count (CAS guards, bulk-expiry counts).
 */
function rawClient(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardianRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export type GuardianRequestSourceType = "voice" | "desktop" | "channel";

export interface GuardianRequest {
  id: string;
  kind: string;
  sourceChannel: string | null;
  sourceConversationId: string | null;
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
  commandPreview: string | null;
  riskLevel: string | null;
  activityText: string | null;
  executionTarget: string | null;
  /** JSON-encoded requester identity signals. */
  requesterSignals: string | null;
  /** What prompted an access request: `denied` (default) or `admitted`. */
  requestTrigger: string | null;
  status: GuardianRequestStatus;
  answerText: string | null;
  decidedByExternalUserId: string | null;
  decidedByPrincipalId: string | null;
  followupState: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface GuardianRequestDelivery {
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

/**
 * Thrown when a create violates a store integrity invariant. Carries a
 * stable machine-readable `code` so the IPC layer can map it onto the wire.
 */
export class GuardianRequestIntegrityError extends Error {
  readonly code = "guardian_principal_required";

  constructor(message: string) {
    super(message);
    this.name = "GuardianRequestIntegrityError";
  }
}

// ---------------------------------------------------------------------------
// Expiry / source-type helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a request has passed its `expiresAt` deadline.
 * Requests without an `expiresAt` are never considered expired by this check.
 */
export function isRequestExpired(
  request: Pick<GuardianRequest, "expiresAt">,
): boolean {
  if (!request.expiresAt) {
    return false;
  }
  return request.expiresAt < Date.now();
}

/**
 * Derive the presentation-level source type from the provenance channel.
 * The gateway table does not store source_type — it is mechanical:
 * phone → voice, vellum → desktop, everything else (incl. null) → channel.
 */
export function deriveSourceType(
  sourceChannel: string | null,
): GuardianRequestSourceType {
  if (sourceChannel === "phone") {
    return "voice";
  }
  if (sourceChannel === "vellum") {
    return "desktop";
  }
  return "channel";
}

function sourceTypeCondition(sourceType: string) {
  if (sourceType === "voice") {
    return eq(guardianRequests.sourceChannel, "phone");
  }
  if (sourceType === "desktop") {
    return eq(guardianRequests.sourceChannel, "vellum");
  }
  return or(
    isNull(guardianRequests.sourceChannel),
    notInArray(guardianRequests.sourceChannel, ["phone", "vellum"]),
  );
}

// ---------------------------------------------------------------------------
// Request code generation
// ---------------------------------------------------------------------------

/**
 * Generate a short human-readable request code (6 hex chars, uppercase).
 *
 * Checks for collisions against existing PENDING requests and retries up to
 * 5 times to avoid code reuse among active requests. Resolved requests with
 * the same code are harmless since getGuardianRequestByCode filters by
 * status='pending'.
 */
export function generateRequestCode(): string {
  const MAX_RETRIES = 5;
  const newCode = () =>
    crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = newCode();
    if (!getGuardianRequestByCode(code)) {
      return code;
    }
  }
  // Last resort: return the code even if it collides (extremely unlikely
  // with 16^6 = ~16.7M possible codes).
  return newCode();
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToRequest(
  row: typeof guardianRequests.$inferSelect,
): GuardianRequest {
  return {
    id: row.id,
    kind: row.kind,
    sourceChannel: row.sourceChannel,
    sourceConversationId: row.sourceConversationId,
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
    commandPreview: row.commandPreview,
    riskLevel: row.riskLevel,
    activityText: row.activityText,
    executionTarget: row.executionTarget,
    requesterSignals: row.requesterSignals,
    requestTrigger: row.requestTrigger,
    status: row.status as GuardianRequestStatus,
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
  row: typeof guardianRequestDeliveries.$inferSelect,
): GuardianRequestDelivery {
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
// Guardian requests
// ---------------------------------------------------------------------------

export interface CreateGuardianRequestParams {
  /**
   * Caller-supplied ids are honored — they are load-bearing (deterministic
   * `access-req-...` ids, pending-interaction requestIds reused as PK).
   */
  id?: string;
  kind: string;
  sourceChannel?: string;
  sourceConversationId?: string;
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
  commandPreview?: string;
  riskLevel?: string;
  activityText?: string;
  executionTarget?: string;
  requesterSignals?: string;
  requestTrigger?: string;
  status?: GuardianRequestStatus;
  answerText?: string;
  decidedByExternalUserId?: string;
  decidedByPrincipalId?: string;
  followupState?: string;
  expiresAt?: number;
}

/**
 * Request kinds that require a guardian decision (approve/deny). These kinds
 * MUST have a `guardianPrincipalId` bound at creation time so the decision
 * can be attributed to a specific principal. Informational kinds are exempt.
 */
const DECISIONABLE_KINDS = new Set([
  "tool_approval",
  "tool_grant_request",
  "pending_question",
  "access_request",
]);

export function createGuardianRequest(
  params: CreateGuardianRequestParams,
): GuardianRequest {
  if (DECISIONABLE_KINDS.has(params.kind) && !params.guardianPrincipalId) {
    throw new GuardianRequestIntegrityError(
      `Cannot create decisionable guardian request of kind '${params.kind}' without guardianPrincipalId`,
    );
  }

  const db = getGatewayDb();
  const now = Date.now();

  const row = {
    id: params.id ?? crypto.randomUUID(),
    kind: params.kind,
    sourceChannel: params.sourceChannel ?? null,
    sourceConversationId: params.sourceConversationId ?? null,
    requesterExternalUserId: params.requesterExternalUserId ?? null,
    requesterChatId: params.requesterChatId ?? null,
    guardianExternalUserId: params.guardianExternalUserId ?? null,
    guardianPrincipalId: params.guardianPrincipalId ?? null,
    callSessionId: params.callSessionId ?? null,
    pendingQuestionId: params.pendingQuestionId ?? null,
    questionText: params.questionText ?? null,
    requestCode: params.requestCode ?? generateRequestCode(),
    toolName: params.toolName ?? null,
    inputDigest: params.inputDigest ?? null,
    commandPreview: params.commandPreview ?? null,
    riskLevel: params.riskLevel ?? null,
    activityText: params.activityText ?? null,
    executionTarget: params.executionTarget ?? null,
    requesterSignals: params.requesterSignals ?? null,
    requestTrigger: params.requestTrigger ?? null,
    status: params.status ?? ("pending" as const),
    answerText: params.answerText ?? null,
    decidedByExternalUserId: params.decidedByExternalUserId ?? null,
    decidedByPrincipalId: params.decidedByPrincipalId ?? null,
    followupState: params.followupState ?? null,
    expiresAt: params.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(guardianRequests).values(row).run();
  return rowToRequest(row);
}

export function getGuardianRequest(id: string): GuardianRequest | null {
  const db = getGatewayDb();
  const row = db
    .select()
    .from(guardianRequests)
    .where(eq(guardianRequests.id, id))
    .get();
  return row ? rowToRequest(row) : null;
}

/**
 * Look up a guardian request by its short request code. Scoped to pending
 * (unresolved) requests so that codes recycled by older, already-resolved
 * requests do not collide with the active one.
 */
export function getGuardianRequestByCode(code: string): GuardianRequest | null {
  const db = getGatewayDb();
  const row = db
    .select()
    .from(guardianRequests)
    .where(
      and(
        eq(guardianRequests.requestCode, code),
        eq(guardianRequests.status, "pending"),
      ),
    )
    .get();
  return row ? rowToRequest(row) : null;
}

export interface ListGuardianRequestsFilters {
  status?: GuardianRequestStatus;
  guardianExternalUserId?: string;
  guardianPrincipalId?: string;
  requesterExternalUserId?: string;
  sourceConversationId?: string;
  /** Derived filter — translated to a source_channel predicate. */
  sourceType?: string;
  sourceChannel?: string;
  kind?: string;
  toolName?: string;
}

export function listGuardianRequests(
  filters?: ListGuardianRequestsFilters,
): GuardianRequest[] {
  const db = getGatewayDb();

  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(guardianRequests.status, filters.status));
  }
  if (filters?.guardianExternalUserId) {
    conditions.push(
      eq(
        guardianRequests.guardianExternalUserId,
        filters.guardianExternalUserId,
      ),
    );
  }
  if (filters?.guardianPrincipalId) {
    conditions.push(
      eq(guardianRequests.guardianPrincipalId, filters.guardianPrincipalId),
    );
  }
  if (filters?.requesterExternalUserId) {
    conditions.push(
      eq(
        guardianRequests.requesterExternalUserId,
        filters.requesterExternalUserId,
      ),
    );
  }
  if (filters?.sourceConversationId) {
    conditions.push(
      eq(guardianRequests.sourceConversationId, filters.sourceConversationId),
    );
  }
  if (filters?.sourceType) {
    conditions.push(sourceTypeCondition(filters.sourceType));
  }
  if (filters?.sourceChannel) {
    conditions.push(eq(guardianRequests.sourceChannel, filters.sourceChannel));
  }
  if (filters?.kind) {
    conditions.push(eq(guardianRequests.kind, filters.kind));
  }
  if (filters?.toolName) {
    conditions.push(eq(guardianRequests.toolName, filters.toolName));
  }

  if (conditions.length === 0) {
    return db.select().from(guardianRequests).all().map(rowToRequest);
  }

  return db
    .select()
    .from(guardianRequests)
    .where(and(...conditions))
    .all()
    .map(rowToRequest);
}

export interface UpdateGuardianRequestParams {
  status?: GuardianRequestStatus;
  answerText?: string;
  decidedByExternalUserId?: string;
  decidedByPrincipalId?: string;
  followupState?: string | null;
  expiresAt?: number;
}

export function updateGuardianRequest(
  id: string,
  updates: UpdateGuardianRequestParams,
): GuardianRequest | null {
  const db = getGatewayDb();
  const now = Date.now();

  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.status !== undefined) {
    setValues.status = updates.status;
  }
  if (updates.answerText !== undefined) {
    setValues.answerText = updates.answerText;
  }
  if (updates.decidedByExternalUserId !== undefined) {
    setValues.decidedByExternalUserId = updates.decidedByExternalUserId;
  }
  if (updates.decidedByPrincipalId !== undefined) {
    setValues.decidedByPrincipalId = updates.decidedByPrincipalId;
  }
  if (updates.followupState !== undefined) {
    setValues.followupState = updates.followupState;
  }
  if (updates.expiresAt !== undefined) {
    setValues.expiresAt = updates.expiresAt;
  }

  db.update(guardianRequests)
    .set(setValues)
    .where(eq(guardianRequests.id, id))
    .run();

  return getGuardianRequest(id);
}

export interface ResolveGuardianRequestDecision {
  status: GuardianRequestStatus;
  answerText?: string;
  decidedByExternalUserId?: string;
  decidedByPrincipalId?: string;
}

export type ResolveGuardianRequestResult =
  | { applied: true; request: GuardianRequest }
  | { applied: false };

/**
 * Compare-and-swap resolve: only transitions the request from
 * `expectedStatus` to the decision's status atomically — first writer wins.
 * Supports pending → terminal decisions and terminal → pending reopens.
 *
 * Uses the raw bun:sqlite client because drizzle's run() does not surface
 * the changes count needed for the first-writer-wins guarantee.
 */
export function resolveGuardianRequest(
  id: string,
  expectedStatus: GuardianRequestStatus,
  decision: ResolveGuardianRequestDecision,
): ResolveGuardianRequestResult {
  const raw = rawClient();
  const now = Date.now();

  const sets = ["status = ?", "updated_at = ?"];
  const args: (string | number)[] = [decision.status, now];
  if (decision.answerText !== undefined) {
    sets.push("answer_text = ?");
    args.push(decision.answerText);
  }
  if (decision.decidedByExternalUserId !== undefined) {
    sets.push("decided_by_external_user_id = ?");
    args.push(decision.decidedByExternalUserId);
  }
  if (decision.decidedByPrincipalId !== undefined) {
    sets.push("decided_by_principal_id = ?");
    args.push(decision.decidedByPrincipalId);
  }

  const changes = raw
    .prepare(
      `UPDATE guardian_requests
       SET ${sets.join(", ")}
       WHERE id = ? AND status = ?`,
    )
    .run(...args, id, expectedStatus).changes;

  if (changes === 0) {
    return { applied: false };
  }

  const request = getGuardianRequest(id);
  if (!request) {
    throw new Error(`Guardian request ${id} missing after resolve`);
  }
  return { applied: true, request };
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Request kinds whose resolution depends on the daemon's in-memory
 * `pendingInteractions` Map. These kinds become unresolvable after a daemon
 * restart because the Map is wiped, so the daemon expires them at boot.
 *
 * Persistent kinds (`access_request`, `tool_grant_request`) resolve without
 * pending interactions and remain valid across restarts — they must NOT be
 * expired unconditionally here.
 */
const INTERACTION_BOUND_KINDS = ["tool_approval", "pending_question"];

/**
 * Bulk-expire stale pending guardian requests. Called via IPC at daemon
 * startup (daemon-keyed — the gateway never runs this on its own restart):
 *
 * 1. Interaction-bound kinds (`tool_approval`, `pending_question`) expire
 *    unconditionally — they can never complete after a daemon restart.
 * 2. Persistent kinds expire only when already past their `expiresAt`
 *    deadline, so dedup logic sees fresh rows instead of dead pending ones.
 *
 * Returns the number of requests transitioned from pending → expired.
 */
export function expireAllPendingInteractionBound(): number {
  const raw = rawClient();
  const now = Date.now();

  const placeholders = INTERACTION_BOUND_KINDS.map(() => "?").join(", ");
  return raw
    .prepare(
      `UPDATE guardian_requests
       SET status = 'expired', updated_at = ?
       WHERE status = 'pending'
         AND (kind IN (${placeholders})
              OR (expires_at IS NOT NULL AND expires_at < ?))`,
    )
    .run(now, ...INTERACTION_BOUND_KINDS, now).changes;
}

/**
 * Sweep-expire pending requests whose `expiresAt` deadline has passed.
 * Returns the expired request ids so the daemon can fan out card
 * withdrawals and expiry notifications.
 */
export function sweepExpiredGuardianRequests(now = Date.now()): string[] {
  const db = getGatewayDb();

  return db.transaction(() => {
    const stale = db
      .select({ id: guardianRequests.id })
      .from(guardianRequests)
      .where(
        and(
          eq(guardianRequests.status, "pending"),
          isNotNull(guardianRequests.expiresAt),
          lt(guardianRequests.expiresAt, now),
        ),
      )
      .all()
      .map((row) => row.id);

    if (stale.length === 0) {
      return [];
    }

    db.update(guardianRequests)
      .set({ status: "expired", updatedAt: Date.now() })
      .where(
        and(
          inArray(guardianRequests.id, stale),
          eq(guardianRequests.status, "pending"),
        ),
      )
      .run();

    return stale;
  });
}

/**
 * Expire a single guardian request and all its deliveries in one
 * transaction. CAS-transitions the request from 'pending' to 'expired';
 * its deliveries are bulk-expired regardless of the request's status.
 */
export function expireGuardianRequest(id: string): void {
  const db = getGatewayDb();
  const now = Date.now();

  db.transaction(() => {
    db.update(guardianRequests)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(guardianRequests.id, id),
          eq(guardianRequests.status, "pending"),
        ),
      )
      .run();

    db.update(guardianRequestDeliveries)
      .set({ status: "expired", updatedAt: now })
      .where(eq(guardianRequestDeliveries.requestId, id))
      .run();
  });
}

// ---------------------------------------------------------------------------
// Guardian request deliveries
// ---------------------------------------------------------------------------

export interface CreateDeliveryParams {
  id?: string;
  requestId: string;
  destinationChannel: string;
  destinationConversationId?: string;
  destinationChatId?: string;
  destinationMessageId?: string;
  status?: string;
}

export function createDelivery(
  params: CreateDeliveryParams,
): GuardianRequestDelivery {
  const db = getGatewayDb();
  const now = Date.now();

  const row = {
    id: params.id ?? crypto.randomUUID(),
    requestId: params.requestId,
    destinationChannel: params.destinationChannel,
    destinationConversationId: params.destinationConversationId ?? null,
    destinationChatId: params.destinationChatId ?? null,
    destinationMessageId: params.destinationMessageId ?? null,
    status: params.status ?? "pending",
    createdAt: now,
    updatedAt: now,
  };

  db.insert(guardianRequestDeliveries).values(row).run();
  return rowToDelivery(row);
}

export function listDeliveries(requestId: string): GuardianRequestDelivery[] {
  const db = getGatewayDb();
  return db
    .select()
    .from(guardianRequestDeliveries)
    .where(eq(guardianRequestDeliveries.requestId, requestId))
    .all()
    .map(rowToDelivery);
}

export interface UpdateDeliveryParams {
  status?: string;
  destinationMessageId?: string;
}

export function updateDelivery(
  id: string,
  updates: UpdateDeliveryParams,
): GuardianRequestDelivery | null {
  const db = getGatewayDb();
  const now = Date.now();

  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.status !== undefined) {
    setValues.status = updates.status;
  }
  if (updates.destinationMessageId !== undefined) {
    setValues.destinationMessageId = updates.destinationMessageId;
  }

  db.update(guardianRequestDeliveries)
    .set(setValues)
    .where(eq(guardianRequestDeliveries.id, id))
    .run();

  const row = db
    .select()
    .from(guardianRequestDeliveries)
    .where(eq(guardianRequestDeliveries.id, id))
    .get();

  return row ? rowToDelivery(row) : null;
}

// ---------------------------------------------------------------------------
// By-destination reads (reply / reaction routing)
// ---------------------------------------------------------------------------

function pendingRequestsForDeliveries(
  deliveries: Array<{ requestId: string }>,
): GuardianRequest[] {
  const seenRequestIds = new Set<string>();
  const pendingRequests: GuardianRequest[] = [];

  for (const delivery of deliveries) {
    if (seenRequestIds.has(delivery.requestId)) {
      continue;
    }
    seenRequestIds.add(delivery.requestId);

    const request = getGuardianRequest(delivery.requestId);
    if (request && request.status === "pending") {
      pendingRequests.push(request);
    }
  }

  return pendingRequests;
}

/**
 * Find the pending request whose guardian-facing delivery landed on a
 * specific channel message (channel + chat + message id) — the addressing
 * key for emoji-reaction decisions. Returns null when no delivery matches
 * or the matched request is no longer pending.
 */
export function getPendingByDestinationMessage(
  destinationChannel: string,
  destinationChatId: string,
  destinationMessageId: string,
): GuardianRequest | null {
  const db = getGatewayDb();

  const delivery = db
    .select()
    .from(guardianRequestDeliveries)
    .where(
      and(
        eq(guardianRequestDeliveries.destinationChannel, destinationChannel),
        eq(guardianRequestDeliveries.destinationChatId, destinationChatId),
        eq(
          guardianRequestDeliveries.destinationMessageId,
          destinationMessageId,
        ),
      ),
    )
    .get();

  if (!delivery) {
    return null;
  }

  const request = getGuardianRequest(delivery.requestId);
  return request && request.status === "pending" ? request : null;
}

/**
 * List pending requests that were delivered to a specific destination chat
 * (channel + chatId pair) — the chat-level addressing channel transports
 * natively provide, critical for voice-originated `pending_question`
 * requests that lack `guardianExternalUserId`.
 */
export function listPendingByDestinationChat(
  destinationChannel: string,
  destinationChatId: string,
): GuardianRequest[] {
  const db = getGatewayDb();

  const deliveries = db
    .select()
    .from(guardianRequestDeliveries)
    .where(
      and(
        eq(guardianRequestDeliveries.destinationChannel, destinationChannel),
        eq(guardianRequestDeliveries.destinationChatId, destinationChatId),
      ),
    )
    .all();

  return pendingRequestsForDeliveries(deliveries);
}

/**
 * List pending requests that were delivered to a specific destination
 * conversation, optionally scoped by destination channel when the same
 * conversation ID namespace could exist across channels.
 */
export function listPendingByDestinationConversation(
  destinationConversationId: string,
  destinationChannel?: string,
): GuardianRequest[] {
  const db = getGatewayDb();

  const deliveryConditions = [
    eq(
      guardianRequestDeliveries.destinationConversationId,
      destinationConversationId,
    ),
  ];
  if (destinationChannel) {
    deliveryConditions.push(
      eq(guardianRequestDeliveries.destinationChannel, destinationChannel),
    );
  }

  const deliveries = db
    .select()
    .from(guardianRequestDeliveries)
    .where(and(...deliveryConditions))
    .all();

  return pendingRequestsForDeliveries(deliveries);
}

// ---------------------------------------------------------------------------
// Conversation scope helpers
// ---------------------------------------------------------------------------

/**
 * List pending requests in scope for a conversation, unioning:
 *   1. Requests whose `sourceConversationId` matches.
 *   2. Requests that have a delivery whose `destinationConversationId`
 *      matches (narrowed to `channel` when provided, preventing
 *      cross-channel leakage when conversation ID namespaces overlap).
 *
 * Deduplicates by request ID and filters past-deadline requests out.
 */
export function listPendingByConversationScope(
  conversationId: string,
  channel?: string,
): GuardianRequest[] {
  const bySource = listGuardianRequests({
    sourceConversationId: conversationId,
    status: "pending",
  });

  const byDestination = listPendingByDestinationConversation(
    conversationId,
    channel,
  );

  const seen = new Set<string>();
  const result: GuardianRequest[] = [];

  for (const req of [...bySource, ...byDestination]) {
    if (!seen.has(req.id) && !isRequestExpired(req)) {
      seen.add(req.id);
      result.push(req);
    }
  }

  return result;
}

/**
 * Check whether a guardian decision's conversation is in scope for a
 * request: either the request's `sourceConversationId` matches, or any
 * recorded delivery has a matching `destinationConversationId` (optionally
 * scoped by `channel`). Returns true when the decision is allowed from the
 * given conversation.
 */
export function isRequestInConversationScope(
  requestId: string,
  conversationId: string,
  channel?: string,
): boolean {
  const request = getGuardianRequest(requestId);
  if (!request) {
    return false;
  }

  if (request.sourceConversationId === conversationId) {
    return true;
  }

  const deliveries = listDeliveries(requestId);
  return deliveries.some(
    (d) =>
      d.destinationConversationId === conversationId &&
      (!channel || d.destinationChannel === channel),
  );
}

// ---------------------------------------------------------------------------
// Call-controller convenience reads
// ---------------------------------------------------------------------------

/**
 * Find the most recent pending guardian request for a given call session.
 * Used by the call-controller's consultation timeout handler.
 */
export function getPendingByCallSessionId(
  callSessionId: string,
): GuardianRequest | null {
  const db = getGatewayDb();
  const row = db
    .select()
    .from(guardianRequests)
    .where(
      and(
        eq(guardianRequests.callSessionId, callSessionId),
        eq(guardianRequests.status, "pending"),
      ),
    )
    .orderBy(desc(guardianRequests.createdAt))
    .get();
  return row ? rowToRequest(row) : null;
}

/**
 * Find a guardian request by its linked pending question ID. Used after
 * async dispatch completes to locate the newly created request.
 */
export function getByPendingQuestionId(
  questionId: string,
): GuardianRequest | null {
  const db = getGatewayDb();
  const row = db
    .select()
    .from(guardianRequests)
    .where(eq(guardianRequests.pendingQuestionId, questionId))
    .get();
  return row ? rowToRequest(row) : null;
}

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
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
} from "drizzle-orm";

import {
  DELIVERY_STATUS,
  type GuardianRequestDeliveryWire,
  type GuardianRequestStatus,
  type GuardianRequestWire,
  isGuardianRequestExpired,
} from "@vellumai/gateway-client";

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
// Types (single-sourced from the shared contract)
// ---------------------------------------------------------------------------

/**
 * Request row as the store returns it — the wire DTO minus `sourceType`,
 * which is computed by the service mapper (the column is not stored).
 */
export type GuardianRequest = Omit<GuardianRequestWire, "sourceType">;

/** Delivery row as the store returns it — identical to the wire DTO. */
export type GuardianRequestDelivery = GuardianRequestDeliveryWire;

/**
 * Thrown when a create violates a store integrity invariant. Carries a
 * stable machine-readable `code` and a 4xx `statusCode` so the IPC error
 * envelope surfaces it as a client error.
 */
export class GuardianRequestIntegrityError extends Error {
  readonly statusCode = 400;
  readonly code = "guardian_principal_required";

  constructor(message: string) {
    super(message);
    this.name = "GuardianRequestIntegrityError";
  }
}

// ---------------------------------------------------------------------------
// Source-type filter translation
// ---------------------------------------------------------------------------

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
 * can be attributed to a specific principal. The contract already requires
 * the principal for every admitted kind — this guard is a second layer of
 * defense for callers that reach the store without IPC-schema validation.
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
  /** Maximum rows to return. Results are ordered newest-first (createdAt DESC, id ASC). */
  limit?: number;
  /** Keyset cursor — epoch-ms createdAt of the last item on the previous page. */
  before?: number;
  /** Keyset cursor — id of the last item (tiebreaker for equal createdAt). */
  beforeId?: string;
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
  if (filters?.before !== undefined) {
    const beforeMs = filters.before;
    const beforeId = filters.beforeId;
    conditions.push(
      beforeId !== undefined
        ? or(
            lt(guardianRequests.createdAt, beforeMs),
            and(
              eq(guardianRequests.createdAt, beforeMs),
              gt(guardianRequests.id, beforeId),
            ),
          )!
        : lt(guardianRequests.createdAt, beforeMs),
    );
  }

  const query = db
    .select()
    .from(guardianRequests)
    .orderBy(desc(guardianRequests.createdAt), asc(guardianRequests.id));

  const withWhere =
    conditions.length > 0 ? query.where(and(...conditions)) : query;

  const rows =
    filters?.limit !== undefined
      ? withWhere.limit(filters.limit).all()
      : withWhere.all();

  return rows.map(rowToRequest);
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
 * Direction-agnostic on purpose; production only drives pending → terminal.
 *
 * Uses the raw bun:sqlite client because drizzle's run() does not surface
 * the changes count needed for the first-writer-wins guarantee.
 */
export function resolveGuardianRequest(
  id: string,
  expectedStatus: GuardianRequestStatus,
  decision: ResolveGuardianRequestDecision,
  options?: {
    /**
     * Make the deadline part of the CAS: the transition applies only while
     * `expires_at` is null or still in the future. The decide path sets
     * this so a decision in flight across the deadline boundary loses the
     * arbitration atomically, instead of committing while the expiry sweep
     * is already withdrawing the request's cards.
     */
    requireUnexpired?: boolean;
  },
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

  const guards = ["id = ?", "status = ?"];
  const guardArgs: (string | number)[] = [id, expectedStatus];
  if (options?.requireUnexpired) {
    guards.push("(expires_at IS NULL OR expires_at >= ?)");
    guardArgs.push(now);
  }

  const changes = raw
    .prepare(
      `UPDATE guardian_requests
       SET ${sets.join(", ")}
       WHERE ${guards.join(" AND ")}`,
    )
    .run(...args, ...guardArgs).changes;

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
 * Bulk-expire interaction-bound pending guardian requests. Called via IPC
 * at daemon startup (daemon-keyed; the gateway never runs this on its own
 * restart): `tool_approval` and `pending_question` die with the daemon's
 * in-memory pendingInteractions map, so they can never complete after a
 * restart.
 *
 * Persistent kinds are deliberately untouched, whatever their deadline:
 * their expiry belongs to the sweep, whose per-request confirmation is what
 * keeps the card-withdrawal and requester-notice fan-out recoverable, and
 * an unconditional flip here would strand exactly the side effects a
 * pre-restart crash left owed. Dedup reads are time-based
 * (`isGuardianRequestExpired`), so a past-deadline row waiting for the
 * sweep suppresses nothing.
 *
 * Returns the number of requests transitioned from pending to expired.
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
         AND kind IN (${placeholders})`,
    )
    .run(now, ...INTERACTION_BOUND_KINDS).changes;
}

/** Ceiling on one expiry batch, whatever the caller asks for. */
const MAX_EXPIRED_PENDING_BATCH = 200;

/**
 * List pending requests whose `expiresAt` deadline has passed, oldest
 * deadline first, bounded. Read-only: the status flip is the caller's
 * per-request confirmation (`expireGuardianRequest`) after that request's
 * expiry side effects have run, so a row's work stays discoverable here
 * until it is actually done. The bound keeps a round's IPC payload and the
 * caller's fan-out finite however large a backlog grows.
 */
export function listExpiredPendingGuardianRequests(
  now = Date.now(),
  limit = 50,
): GuardianRequest[] {
  const db = getGatewayDb();
  return db
    .select()
    .from(guardianRequests)
    .where(
      and(
        eq(guardianRequests.status, "pending"),
        isNotNull(guardianRequests.expiresAt),
        lt(guardianRequests.expiresAt, now),
      ),
    )
    .orderBy(guardianRequests.expiresAt)
    .limit(Math.min(Math.max(1, limit), MAX_EXPIRED_PENDING_BATCH))
    .all()
    .map(rowToRequest);
}

/**
 * Expire a single guardian request and all its deliveries in one
 * transaction. CAS-transitions the request from 'pending' to 'expired';
 * the deliveries expire only when that CAS applies, so a request a
 * decision already resolved never has its delivery rows restamped as
 * expired.
 */
export function expireGuardianRequest(id: string): void {
  const db = getGatewayDb();
  const now = Date.now();

  db.transaction(() => {
    // The read and both writes share one synchronous SQLite transaction,
    // so the status probe is the CAS.
    const row = db
      .select({ status: guardianRequests.status })
      .from(guardianRequests)
      .where(eq(guardianRequests.id, id))
      .get();
    if (row?.status !== "pending") {
      return;
    }

    db.update(guardianRequests)
      .set({ status: "expired", updatedAt: now })
      .where(eq(guardianRequests.id, id))
      .run();

    // A `withdrawn` row is the daemon's receipt that the surface edit
    // durably ran; restamping it would erase which surfaces were actually
    // cleaned. Rows in any other state expire with the request.
    db.update(guardianRequestDeliveries)
      .set({ status: DELIVERY_STATUS.expired, updatedAt: now })
      .where(
        and(
          eq(guardianRequestDeliveries.requestId, id),
          ne(guardianRequestDeliveries.status, DELIVERY_STATUS.withdrawn),
        ),
      )
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
    status: params.status ?? DELIVERY_STATUS.pending,
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

/**
 * Every delivery row addressed to one channel-native chat, across all
 * requests. Serves transcript importers deciding whether a channel
 * message is a guardian card (a delivery projection) rather than
 * conversation content, so no status filter: a withdrawn card is still
 * a card.
 */
export function listDeliveriesByChat(
  channel: string,
  chatId: string,
): GuardianRequestDelivery[] {
  const db = getGatewayDb();
  return db
    .select()
    .from(guardianRequestDeliveries)
    .where(
      and(
        eq(guardianRequestDeliveries.destinationChannel, channel),
        eq(guardianRequestDeliveries.destinationChatId, chatId),
      ),
    )
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
  if (updates.destinationMessageId !== undefined) {
    setValues.destinationMessageId = updates.destinationMessageId;
  }

  db.update(guardianRequestDeliveries)
    .set(setValues)
    .where(eq(guardianRequestDeliveries.id, id))
    .run();

  // `withdrawn` is the terminal per-surface receipt that a card was durably
  // withdrawn, preserved here the same way the per-request expire preserves
  // it: delivery recording lands its sent/failed status patch after the
  // broadcast settles, so a decision racing that window would otherwise
  // overwrite the receipt and re-describe an already-withdrawn card as live.
  if (updates.status !== undefined) {
    db.update(guardianRequestDeliveries)
      .set({ status: updates.status, updatedAt: now })
      .where(
        and(
          eq(guardianRequestDeliveries.id, id),
          ne(guardianRequestDeliveries.status, DELIVERY_STATUS.withdrawn),
        ),
      )
      .run();
  }

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
    if (!seen.has(req.id) && !isGuardianRequestExpired(req)) {
      seen.add(req.id);
      result.push(req);
    }
  }

  return result;
}

/**
 * Check whether a guardian decision's conversation is in scope for a
 * request: either the request's `sourceConversationId` matches, or any
 * recorded delivery has a matching `destinationConversationId`. Returns true
 * when the decision is allowed from the given conversation. Deliberately not
 * narrowed by delivery channel: `destinationConversationId` is always an
 * internal conversation id, and every delivery's paired conversation renders
 * the same actionable in-app card.
 */
export function isRequestInConversationScope(
  requestId: string,
  conversationId: string,
): boolean {
  const request = getGuardianRequest(requestId);
  if (!request) {
    return false;
  }

  if (request.sourceConversationId === conversationId) {
    return true;
  }

  const deliveries = listDeliveries(requestId);
  return deliveries.some((d) => d.destinationConversationId === conversationId);
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

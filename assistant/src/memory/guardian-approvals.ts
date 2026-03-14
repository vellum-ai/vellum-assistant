/**
 * Guardian approval request tracking.
 *
 * Approval requests track per-run guardian approval decisions — whether
 * a guardian has approved or denied a tool invocation on behalf of a
 * channel requester.
 */

import { and, desc, eq, gt, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db.js";
import { channelGuardianApprovalRequests } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export interface GuardianApprovalRequest {
  id: string;
  runId: string;
  requestId: string;
  conversationId: string;
  channel: string;
  requesterExternalUserId: string;
  requesterChatId: string;
  guardianExternalUserId: string;
  guardianChatId: string;
  toolName: string;
  riskLevel: string | null;
  reason: string | null;
  status: ApprovalRequestStatus;
  decidedByExternalUserId: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToApprovalRequest(
  row: typeof channelGuardianApprovalRequests.$inferSelect,
): GuardianApprovalRequest {
  return {
    id: row.id,
    runId: row.runId,
    requestId: row.requestId ?? row.runId,
    conversationId: row.conversationId,
    channel: row.channel,
    requesterExternalUserId: row.requesterExternalUserId,
    requesterChatId: row.requesterChatId,
    guardianExternalUserId: row.guardianExternalUserId,
    guardianChatId: row.guardianChatId,
    toolName: row.toolName,
    riskLevel: row.riskLevel,
    reason: row.reason,
    status: row.status as ApprovalRequestStatus,
    decidedByExternalUserId: row.decidedByExternalUserId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * @internal Test-only helper. Production code should create guardian requests
 * via `createCanonicalGuardianRequest` in canonical-guardian-store.ts.
 * This function is retained solely so that existing test fixtures that seed
 * legacy approval rows continue to compile.
 */
export function createApprovalRequest(params: {
  runId: string;
  requestId?: string;
  conversationId: string;
  channel: string;
  requesterExternalUserId: string;
  requesterChatId: string;
  guardianExternalUserId: string;
  guardianChatId: string;
  toolName: string;
  riskLevel?: string;
  reason?: string;
  expiresAt: number;
}): GuardianApprovalRequest {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    runId: params.runId,
    requestId: params.requestId ?? null,
    conversationId: params.conversationId,
    channel: params.channel,
    requesterExternalUserId: params.requesterExternalUserId,
    requesterChatId: params.requesterChatId,
    guardianExternalUserId: params.guardianExternalUserId,
    guardianChatId: params.guardianChatId,
    toolName: params.toolName,
    riskLevel: params.riskLevel ?? null,
    reason: params.reason ?? null,
    status: "pending" as const,
    decidedByExternalUserId: null,
    expiresAt: params.expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianApprovalRequests).values(row).run();

  return rowToApprovalRequest(row);
}

export function getPendingApprovalForRequest(
  requestId: string,
): GuardianApprovalRequest | null {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.requestId, requestId),
        eq(channelGuardianApprovalRequests.status, "pending"),
        gt(channelGuardianApprovalRequests.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

export function getUnresolvedApprovalForRequest(
  requestId: string,
): GuardianApprovalRequest | null {
  const db = getDb();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.requestId, requestId),
        eq(channelGuardianApprovalRequests.status, "pending"),
      ),
    )
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Find a pending guardian approval request by the guardian's chat ID.
 * Used when the guardian sends a decision from their chat.
 */
export function getPendingApprovalByGuardianChat(
  channel: string,
  guardianChatId: string,
): GuardianApprovalRequest | null {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.channel, channel),
        eq(channelGuardianApprovalRequests.guardianChatId, guardianChatId),
        eq(channelGuardianApprovalRequests.status, "pending"),
        gt(channelGuardianApprovalRequests.expiresAt, now),
      ),
    )
    .orderBy(desc(channelGuardianApprovalRequests.createdAt))
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Find a pending guardian approval request scoped to a specific requestId,
 * guardian chat, and channel. Used when a callback button provides a requestId,
 * so the decision is applied to exactly the right approval even when
 * multiple approvals target the same guardian chat.
 */
export function getPendingApprovalByRequestAndGuardianChat(
  requestId: string,
  channel: string,
  guardianChatId: string,
): GuardianApprovalRequest | null {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.requestId, requestId),
        eq(channelGuardianApprovalRequests.channel, channel),
        eq(channelGuardianApprovalRequests.guardianChatId, guardianChatId),
        eq(channelGuardianApprovalRequests.status, "pending"),
        gt(channelGuardianApprovalRequests.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Return all pending (non-expired) guardian approval requests for a given
 * guardian chat and channel. Used to detect ambiguity when a guardian sends
 * a plain-text decision while multiple approvals are pending.
 */
export function getAllPendingApprovalsByGuardianChat(
  channel: string,
  guardianChatId: string,
): GuardianApprovalRequest[] {
  const db = getDb();
  const now = Date.now();

  const rows = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.channel, channel),
        eq(channelGuardianApprovalRequests.guardianChatId, guardianChatId),
        eq(channelGuardianApprovalRequests.status, "pending"),
        gt(channelGuardianApprovalRequests.expiresAt, now),
      ),
    )
    .orderBy(desc(channelGuardianApprovalRequests.createdAt))
    .all();

  return rows.map(rowToApprovalRequest);
}

/**
 * Return all pending approval requests whose expiresAt has passed.
 * Used by the proactive expiry sweep to auto-deny expired approvals
 * without waiting for requester follow-up traffic.
 */
export function getExpiredPendingApprovals(): GuardianApprovalRequest[] {
  const db = getDb();
  const now = Date.now();

  const rows = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.status, "pending"),
        lte(channelGuardianApprovalRequests.expiresAt, now),
      ),
    )
    .all();

  return rows.map(rowToApprovalRequest);
}

export function updateApprovalDecision(
  id: string,
  decision: { status: ApprovalRequestStatus; decidedByExternalUserId?: string },
): void {
  const db = getDb();
  const now = Date.now();

  db.update(channelGuardianApprovalRequests)
    .set({
      status: decision.status,
      decidedByExternalUserId: decision.decidedByExternalUserId ?? null,
      updatedAt: now,
    })
    .where(eq(channelGuardianApprovalRequests.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Escalation Query Helpers
// ---------------------------------------------------------------------------

/**
 * List approval requests optionally filtered by channel, conversation, and
 * status. Returns a paginated list of escalations.
 */
export function listPendingApprovalRequests(params: {
  channel?: string;
  conversationId?: string;
  status?: ApprovalRequestStatus;
  limit?: number;
  offset?: number;
}): GuardianApprovalRequest[] {
  const db = getDb();

  const conditions: ReturnType<typeof eq>[] = [];
  if (params.channel) {
    conditions.push(
      eq(channelGuardianApprovalRequests.channel, params.channel),
    );
  }
  if (params.conversationId) {
    conditions.push(
      eq(channelGuardianApprovalRequests.conversationId, params.conversationId),
    );
  }
  conditions.push(
    eq(channelGuardianApprovalRequests.status, params.status ?? "pending"),
  );

  let query = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(and(...conditions))
    .orderBy(desc(channelGuardianApprovalRequests.createdAt));

  if (params.limit !== undefined) {
    query = query.limit(params.limit) as typeof query;
  }
  if (params.offset !== undefined) {
    query = query.offset(params.offset) as typeof query;
  }

  return query.all().map(rowToApprovalRequest);
}

/**
 * Fetch a single approval request by its primary key.
 */
export function getApprovalRequestById(
  id: string,
): GuardianApprovalRequest | null {
  const db = getDb();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(eq(channelGuardianApprovalRequests.id, id))
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Resolve a pending approval request with a decision.
 *
 * Idempotent: if the request is already resolved with the same decision,
 * the existing record is returned unchanged. Returns null if the request
 * does not exist or was resolved with a *different* decision.
 */
export function resolveApprovalRequest(
  id: string,
  decision: "approved" | "denied",
  decidedByExternalUserId?: string,
): GuardianApprovalRequest | null {
  const db = getDb();

  const existing = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(eq(channelGuardianApprovalRequests.id, id))
    .get();

  if (!existing) return null;

  // Idempotent: already resolved with the same decision
  if (existing.status === decision) {
    return rowToApprovalRequest(existing);
  }

  // Only resolve if currently pending
  if (existing.status !== "pending") {
    return null;
  }

  const now = Date.now();

  db.update(channelGuardianApprovalRequests)
    .set({
      status: decision,
      decidedByExternalUserId: decidedByExternalUserId ?? null,
      updatedAt: now,
    })
    .where(eq(channelGuardianApprovalRequests.id, id))
    .run();

  return rowToApprovalRequest({
    ...existing,
    status: decision,
    decidedByExternalUserId: decidedByExternalUserId ?? null,
    updatedAt: now,
  });
}

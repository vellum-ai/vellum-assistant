/**
 * CRUD store for channel guardian bindings, verification challenges,
 * and guardian approval requests.
 *
 * Guardian bindings record which external user is the designated guardian
 * for a given (assistantId, channel) pair. Verification challenges track
 * the cryptographic handshake used to prove guardian identity. Approval
 * requests track per-run guardian approval decisions.
 */

import { and, count, desc, eq, gt, gte, inArray, lte, or, sum } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import { getDb } from './db.js';
import {
  channelGuardianApprovalRequests,
  channelGuardianBindings,
  channelGuardianRateLimits,
  channelGuardianVerificationChallenges,
} from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BindingStatus = 'active' | 'revoked';
export type ChallengeStatus = 'pending' | 'consumed' | 'expired' | 'revoked';
export type SessionStatus = 'pending' | 'consumed' | 'pending_bootstrap' | 'awaiting_response' | 'verified' | 'expired' | 'revoked' | 'locked';
export type IdentityBindingStatus = 'pending_bootstrap' | 'bound';
export type ApprovalRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface GuardianBinding {
  id: string;
  assistantId: string;
  channel: string;
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
  status: BindingStatus;
  verifiedAt: number;
  verifiedVia: string;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface VerificationChallenge {
  id: string;
  assistantId: string;
  channel: string;
  challengeHash: string;
  expiresAt: number;
  status: ChallengeStatus;
  createdBySessionId: string | null;
  consumedByExternalUserId: string | null;
  consumedByChatId: string | null;
  // Outbound session: expected-identity binding
  expectedExternalUserId: string | null;
  expectedChatId: string | null;
  expectedPhoneE164: string | null;
  identityBindingStatus: IdentityBindingStatus | null;
  // Outbound session: delivery tracking
  destinationAddress: string | null;
  lastSentAt: number | null;
  sendCount: number;
  nextResendAt: number | null;
  // Session configuration
  codeDigits: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface GuardianApprovalRequest {
  id: string;
  runId: string;
  conversationId: string;
  assistantId: string;
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

function rowToBinding(row: typeof channelGuardianBindings.$inferSelect): GuardianBinding {
  return {
    id: row.id,
    assistantId: row.assistantId,
    channel: row.channel,
    guardianExternalUserId: row.guardianExternalUserId,
    guardianDeliveryChatId: row.guardianDeliveryChatId,
    status: row.status as BindingStatus,
    verifiedAt: row.verifiedAt,
    verifiedVia: row.verifiedVia,
    metadataJson: row.metadataJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToChallenge(row: typeof channelGuardianVerificationChallenges.$inferSelect): VerificationChallenge {
  return {
    id: row.id,
    assistantId: row.assistantId,
    channel: row.channel,
    challengeHash: row.challengeHash,
    expiresAt: row.expiresAt,
    status: row.status as ChallengeStatus,
    createdBySessionId: row.createdBySessionId,
    consumedByExternalUserId: row.consumedByExternalUserId,
    consumedByChatId: row.consumedByChatId,
    expectedExternalUserId: row.expectedExternalUserId ?? null,
    expectedChatId: row.expectedChatId ?? null,
    expectedPhoneE164: row.expectedPhoneE164 ?? null,
    identityBindingStatus: (row.identityBindingStatus as IdentityBindingStatus) ?? null,
    destinationAddress: row.destinationAddress ?? null,
    lastSentAt: row.lastSentAt ?? null,
    sendCount: row.sendCount ?? 0,
    nextResendAt: row.nextResendAt ?? null,
    codeDigits: row.codeDigits ?? 6,
    maxAttempts: row.maxAttempts ?? 3,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToApprovalRequest(row: typeof channelGuardianApprovalRequests.$inferSelect): GuardianApprovalRequest {
  return {
    id: row.id,
    runId: row.runId,
    conversationId: row.conversationId,
    assistantId: row.assistantId,
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
// Guardian Bindings
// ---------------------------------------------------------------------------

export function createBinding(params: {
  assistantId: string;
  channel: string;
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
  verifiedVia?: string;
  metadataJson?: string | null;
}): GuardianBinding {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    assistantId: params.assistantId,
    channel: params.channel,
    guardianExternalUserId: params.guardianExternalUserId,
    guardianDeliveryChatId: params.guardianDeliveryChatId,
    status: 'active' as const,
    verifiedAt: now,
    verifiedVia: params.verifiedVia ?? 'challenge',
    metadataJson: params.metadataJson ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianBindings).values(row).run();

  return rowToBinding(row);
}

export function getActiveBinding(assistantId: string, channel: string): GuardianBinding | null {
  const db = getDb();
  const row = db
    .select()
    .from(channelGuardianBindings)
    .where(
      and(
        eq(channelGuardianBindings.assistantId, assistantId),
        eq(channelGuardianBindings.channel, channel),
        eq(channelGuardianBindings.status, 'active'),
      ),
    )
    .get();

  return row ? rowToBinding(row) : null;
}

export function revokeBinding(assistantId: string, channel: string): boolean {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select({ id: channelGuardianBindings.id })
    .from(channelGuardianBindings)
    .where(
      and(
        eq(channelGuardianBindings.assistantId, assistantId),
        eq(channelGuardianBindings.channel, channel),
        eq(channelGuardianBindings.status, 'active'),
      ),
    )
    .get();

  if (!existing) return false;

  db.update(channelGuardianBindings)
    .set({ status: 'revoked', updatedAt: now })
    .where(eq(channelGuardianBindings.id, existing.id))
    .run();

  return true;
}

// ---------------------------------------------------------------------------
// Verification Challenges
// ---------------------------------------------------------------------------

export function createChallenge(params: {
  id: string;
  assistantId: string;
  channel: string;
  challengeHash: string;
  expiresAt: number;
  createdBySessionId?: string;
}): VerificationChallenge {
  const db = getDb();
  const now = Date.now();

  // Revoke any prior pending challenges for the same (assistantId, channel)
  // to close the replay window — only the latest challenge should be valid.
  db.update(channelGuardianVerificationChallenges)
    .set({ status: 'revoked', updatedAt: now })
    .where(
      and(
        eq(channelGuardianVerificationChallenges.assistantId, params.assistantId),
        eq(channelGuardianVerificationChallenges.channel, params.channel),
        eq(channelGuardianVerificationChallenges.status, 'pending'),
      ),
    )
    .run();

  const row = {
    id: params.id,
    assistantId: params.assistantId,
    channel: params.channel,
    challengeHash: params.challengeHash,
    expiresAt: params.expiresAt,
    status: 'pending' as const,
    createdBySessionId: params.createdBySessionId ?? null,
    consumedByExternalUserId: null,
    consumedByChatId: null,
    expectedExternalUserId: null,
    expectedChatId: null,
    expectedPhoneE164: null,
    identityBindingStatus: 'bound' as const,
    destinationAddress: null,
    lastSentAt: null,
    sendCount: 0,
    nextResendAt: null,
    codeDigits: 6,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianVerificationChallenges).values(row).run();

  return rowToChallenge(row);
}

export function revokePendingChallenges(assistantId: string, channel: string): void {
  const db = getDb();
  db.update(channelGuardianVerificationChallenges)
    .set({ status: 'revoked', updatedAt: Date.now() })
    .where(
      and(
        eq(channelGuardianVerificationChallenges.assistantId, assistantId),
        eq(channelGuardianVerificationChallenges.channel, channel),
        eq(channelGuardianVerificationChallenges.status, 'pending'),
      ),
    )
    .run();
}

export function findPendingChallengeByHash(
  assistantId: string,
  channel: string,
  challengeHash: string,
): VerificationChallenge | null {
  const db = getDb();
  const now = Date.now();

  // Match any consumable status: 'pending' (inbound), 'pending_bootstrap', 'awaiting_response' (outbound)
  const row = db
    .select()
    .from(channelGuardianVerificationChallenges)
    .where(
      and(
        eq(channelGuardianVerificationChallenges.assistantId, assistantId),
        eq(channelGuardianVerificationChallenges.channel, channel),
        eq(channelGuardianVerificationChallenges.challengeHash, challengeHash),
        inArray(channelGuardianVerificationChallenges.status, ['pending', 'pending_bootstrap', 'awaiting_response']),
        gt(channelGuardianVerificationChallenges.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToChallenge(row) : null;
}

/**
 * Find any pending (non-expired) challenge for a given (assistantId, channel).
 * Used by relay setup to detect whether a voice verification session is active.
 */
export function findPendingChallengeForChannel(
  assistantId: string,
  channel: string,
): VerificationChallenge | null {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelGuardianVerificationChallenges)
    .where(
      and(
        eq(channelGuardianVerificationChallenges.assistantId, assistantId),
        eq(channelGuardianVerificationChallenges.channel, channel),
        eq(channelGuardianVerificationChallenges.status, 'pending'),
        gt(channelGuardianVerificationChallenges.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToChallenge(row) : null;
}

export function consumeChallenge(
  id: string,
  consumedByExternalUserId: string,
  consumedByChatId: string,
): void {
  const db = getDb();
  const now = Date.now();

  db.update(channelGuardianVerificationChallenges)
    .set({
      status: 'consumed',
      consumedByExternalUserId,
      consumedByChatId,
      updatedAt: now,
    })
    .where(eq(channelGuardianVerificationChallenges.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Verification Sessions (outbound identity-bound)
// ---------------------------------------------------------------------------

/**
 * Create an outbound verification session with expected-identity binding.
 * Auto-revokes prior pending/awaiting_response sessions for the same
 * (assistantId, channel) to close the replay window.
 */
export function createVerificationSession(params: {
  id: string;
  assistantId: string;
  channel: string;
  challengeHash: string;
  expiresAt: number;
  status: SessionStatus;
  createdBySessionId?: string;
  expectedExternalUserId?: string | null;
  expectedChatId?: string | null;
  expectedPhoneE164?: string | null;
  identityBindingStatus?: IdentityBindingStatus;
  destinationAddress?: string | null;
  codeDigits?: number;
  maxAttempts?: number;
}): VerificationChallenge {
  const db = getDb();
  const now = Date.now();

  // Revoke any prior pending/awaiting_response sessions for the same (assistantId, channel)
  db.update(channelGuardianVerificationChallenges)
    .set({ status: 'revoked', updatedAt: now })
    .where(
      and(
        eq(channelGuardianVerificationChallenges.assistantId, params.assistantId),
        eq(channelGuardianVerificationChallenges.channel, params.channel),
        inArray(channelGuardianVerificationChallenges.status, ['pending', 'pending_bootstrap', 'awaiting_response']),
      ),
    )
    .run();

  const row = {
    id: params.id,
    assistantId: params.assistantId,
    channel: params.channel,
    challengeHash: params.challengeHash,
    expiresAt: params.expiresAt,
    status: params.status as string,
    createdBySessionId: params.createdBySessionId ?? null,
    consumedByExternalUserId: null,
    consumedByChatId: null,
    expectedExternalUserId: params.expectedExternalUserId ?? null,
    expectedChatId: params.expectedChatId ?? null,
    expectedPhoneE164: params.expectedPhoneE164 ?? null,
    identityBindingStatus: params.identityBindingStatus ?? 'bound',
    destinationAddress: params.destinationAddress ?? null,
    lastSentAt: null,
    sendCount: 0,
    nextResendAt: null,
    codeDigits: params.codeDigits ?? 6,
    maxAttempts: params.maxAttempts ?? 3,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianVerificationChallenges).values(row).run();

  return rowToChallenge(row);
}

/**
 * Find the most recent pending_bootstrap or awaiting_response session
 * for a given (assistantId, channel).
 */
export function findActiveSession(
  assistantId: string,
  channel: string,
): VerificationChallenge | null {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelGuardianVerificationChallenges)
    .where(
      and(
        eq(channelGuardianVerificationChallenges.assistantId, assistantId),
        eq(channelGuardianVerificationChallenges.channel, channel),
        inArray(channelGuardianVerificationChallenges.status, ['pending_bootstrap', 'awaiting_response']),
        gt(channelGuardianVerificationChallenges.expiresAt, now),
      ),
    )
    .orderBy(desc(channelGuardianVerificationChallenges.createdAt))
    .get();

  return row ? rowToChallenge(row) : null;
}

/**
 * Identity-bound lookup for the consume path. Finds a session matching the
 * given identity fields with an active status.
 */
export function findSessionByIdentity(
  assistantId: string,
  channel: string,
  externalUserId?: string,
  chatId?: string,
  phoneE164?: string,
): VerificationChallenge | null {
  // Require at least one identity parameter to avoid accidentally matching
  // an unrelated session when the caller has no parsed identity fields.
  if (!externalUserId && !chatId && !phoneE164) {
    return null;
  }

  const db = getDb();
  const now = Date.now();

  const conditions = [
    eq(channelGuardianVerificationChallenges.assistantId, assistantId),
    eq(channelGuardianVerificationChallenges.channel, channel),
    inArray(channelGuardianVerificationChallenges.status, ['pending_bootstrap', 'awaiting_response']),
    gt(channelGuardianVerificationChallenges.expiresAt, now),
  ];

  // Build identity match conditions
  const identityConditions = [];
  if (externalUserId) {
    identityConditions.push(eq(channelGuardianVerificationChallenges.expectedExternalUserId, externalUserId));
  }
  if (chatId) {
    identityConditions.push(eq(channelGuardianVerificationChallenges.expectedChatId, chatId));
  }
  if (phoneE164) {
    identityConditions.push(eq(channelGuardianVerificationChallenges.expectedPhoneE164, phoneE164));
  }

  if (identityConditions.length > 0) {
    conditions.push(or(...identityConditions)!);
  }

  const row = db
    .select()
    .from(channelGuardianVerificationChallenges)
    .where(and(...conditions))
    .orderBy(desc(channelGuardianVerificationChallenges.createdAt))
    .get();

  return row ? rowToChallenge(row) : null;
}

/**
 * Transition a session's status with optional extra field updates.
 */
export function updateSessionStatus(
  id: string,
  status: SessionStatus,
  extraFields?: Partial<{
    consumedByExternalUserId: string;
    consumedByChatId: string;
  }>,
): void {
  const db = getDb();
  const now = Date.now();

  db.update(channelGuardianVerificationChallenges)
    .set({
      status,
      updatedAt: now,
      ...(extraFields?.consumedByExternalUserId !== undefined
        ? { consumedByExternalUserId: extraFields.consumedByExternalUserId }
        : {}),
      ...(extraFields?.consumedByChatId !== undefined
        ? { consumedByChatId: extraFields.consumedByChatId }
        : {}),
    })
    .where(eq(channelGuardianVerificationChallenges.id, id))
    .run();
}

/**
 * Update outbound delivery tracking fields on a session.
 */
export function updateSessionDelivery(
  id: string,
  lastSentAt: number,
  sendCount: number,
  nextResendAt: number | null,
): void {
  const db = getDb();
  const now = Date.now();

  db.update(channelGuardianVerificationChallenges)
    .set({
      lastSentAt,
      sendCount,
      nextResendAt,
      updatedAt: now,
    })
    .where(eq(channelGuardianVerificationChallenges.id, id))
    .run();
}

/**
 * Count SMS sends to a specific destination across all sessions within a
 * rolling time window. Used to enforce per-destination rate limits that
 * span across sessions, preventing circumvention via repeated
 * start_outbound calls.
 */
export function countRecentSendsToDestination(
  channel: string,
  destinationAddress: string,
  windowMs: number,
): number {
  const db = getDb();
  const cutoff = Date.now() - windowMs;

  const result = db
    .select({ total: sum(channelGuardianVerificationChallenges.sendCount) })
    .from(channelGuardianVerificationChallenges)
    .where(
      and(
        eq(channelGuardianVerificationChallenges.channel, channel),
        eq(channelGuardianVerificationChallenges.destinationAddress, destinationAddress),
        gte(channelGuardianVerificationChallenges.createdAt, cutoff),
      ),
    )
    .get();

  return result?.total != null ? Number(result.total) : 0;
}

/**
 * Telegram bootstrap completion: bind the expected identity fields and
 * transition identity_binding_status from pending_bootstrap to bound.
 */
export function bindSessionIdentity(
  id: string,
  externalUserId: string,
  chatId: string,
): void {
  const db = getDb();
  const now = Date.now();

  db.update(channelGuardianVerificationChallenges)
    .set({
      expectedExternalUserId: externalUserId,
      expectedChatId: chatId,
      identityBindingStatus: 'bound',
      updatedAt: now,
    })
    .where(eq(channelGuardianVerificationChallenges.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Guardian Approval Requests
// ---------------------------------------------------------------------------

export function createApprovalRequest(params: {
  runId: string;
  conversationId: string;
  assistantId?: string;
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
    conversationId: params.conversationId,
    assistantId: params.assistantId ?? 'self',
    channel: params.channel,
    requesterExternalUserId: params.requesterExternalUserId,
    requesterChatId: params.requesterChatId,
    guardianExternalUserId: params.guardianExternalUserId,
    guardianChatId: params.guardianChatId,
    toolName: params.toolName,
    riskLevel: params.riskLevel ?? null,
    reason: params.reason ?? null,
    status: 'pending' as const,
    decidedByExternalUserId: null,
    expiresAt: params.expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianApprovalRequests).values(row).run();

  return rowToApprovalRequest(row);
}

export function getPendingApprovalForRun(runId: string): GuardianApprovalRequest | null {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.runId, runId),
        eq(channelGuardianApprovalRequests.status, 'pending'),
        gt(channelGuardianApprovalRequests.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Find a pending (status = 'pending') guardian approval request for a run
 * regardless of whether it has expired. Used by the non-guardian gate to
 * detect expired-but-unresolved approvals that should still block the
 * requester from self-approving.
 */
export function getUnresolvedApprovalForRun(runId: string): GuardianApprovalRequest | null {
  const db = getDb();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.runId, runId),
        eq(channelGuardianApprovalRequests.status, 'pending'),
      ),
    )
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Find a pending guardian approval request by the guardian's chat ID.
 * Used when the guardian sends a decision from their chat.
 *
 * When `assistantId` is provided, the lookup is scoped to that assistant,
 * preventing cross-assistant approval consumption in shared guardian chats.
 */
export function getPendingApprovalByGuardianChat(
  channel: string,
  guardianChatId: string,
  assistantId?: string,
): GuardianApprovalRequest | null {
  const db = getDb();
  const now = Date.now();

  const conditions = [
    eq(channelGuardianApprovalRequests.channel, channel),
    eq(channelGuardianApprovalRequests.guardianChatId, guardianChatId),
    eq(channelGuardianApprovalRequests.status, 'pending'),
    gt(channelGuardianApprovalRequests.expiresAt, now),
  ];
  if (assistantId) {
    conditions.push(eq(channelGuardianApprovalRequests.assistantId, assistantId));
  }

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(and(...conditions))
    .orderBy(desc(channelGuardianApprovalRequests.createdAt))
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Find a pending guardian approval request scoped to a specific run,
 * guardian chat, and channel. Used when a callback button provides a run ID,
 * so the decision is applied to exactly the right approval even when
 * multiple approvals target the same guardian chat.
 *
 * When `assistantId` is provided, the lookup is further scoped to that
 * assistant to prevent cross-assistant approval consumption.
 */
export function getPendingApprovalByRunAndGuardianChat(
  runId: string,
  channel: string,
  guardianChatId: string,
  assistantId?: string,
): GuardianApprovalRequest | null {
  const db = getDb();
  const now = Date.now();

  const conditions = [
    eq(channelGuardianApprovalRequests.runId, runId),
    eq(channelGuardianApprovalRequests.channel, channel),
    eq(channelGuardianApprovalRequests.guardianChatId, guardianChatId),
    eq(channelGuardianApprovalRequests.status, 'pending'),
    gt(channelGuardianApprovalRequests.expiresAt, now),
  ];
  if (assistantId) {
    conditions.push(eq(channelGuardianApprovalRequests.assistantId, assistantId));
  }

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(and(...conditions))
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Return all pending (non-expired) guardian approval requests for a given
 * guardian chat and channel. Used to detect ambiguity when a guardian sends
 * a plain-text decision while multiple approvals are pending.
 *
 * When `assistantId` is provided, the results are scoped to that assistant
 * to prevent cross-assistant approval consumption.
 */
export function getAllPendingApprovalsByGuardianChat(
  channel: string,
  guardianChatId: string,
  assistantId?: string,
): GuardianApprovalRequest[] {
  const db = getDb();
  const now = Date.now();

  const conditions = [
    eq(channelGuardianApprovalRequests.channel, channel),
    eq(channelGuardianApprovalRequests.guardianChatId, guardianChatId),
    eq(channelGuardianApprovalRequests.status, 'pending'),
    gt(channelGuardianApprovalRequests.expiresAt, now),
  ];
  if (assistantId) {
    conditions.push(eq(channelGuardianApprovalRequests.assistantId, assistantId));
  }

  const rows = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(and(...conditions))
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
        eq(channelGuardianApprovalRequests.status, 'pending'),
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
// Inbox / Escalation Query Helpers
// ---------------------------------------------------------------------------

/**
 * List approval requests filtered by assistant, and optionally by channel,
 * conversation, and status. Designed for the inbox UI to show a paginated
 * list of escalations.
 */
export function listPendingApprovalRequests(params: {
  assistantId?: string;
  channel?: string;
  conversationId?: string;
  status?: ApprovalRequestStatus;
  limit?: number;
  offset?: number;
}): GuardianApprovalRequest[] {
  const db = getDb();

  const conditions = [
    eq(channelGuardianApprovalRequests.assistantId, params.assistantId ?? 'self'),
  ];
  if (params.channel) {
    conditions.push(eq(channelGuardianApprovalRequests.channel, params.channel));
  }
  if (params.conversationId) {
    conditions.push(eq(channelGuardianApprovalRequests.conversationId, params.conversationId));
  }
  conditions.push(
    eq(channelGuardianApprovalRequests.status, params.status ?? 'pending'),
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
export function getApprovalRequestById(id: string): GuardianApprovalRequest | null {
  const db = getDb();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(eq(channelGuardianApprovalRequests.id, id))
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Fetch a single approval request by run ID (any status).
 * Useful for checking whether a run has an associated approval request.
 */
export function getApprovalRequestByRunId(runId: string): GuardianApprovalRequest | null {
  const db = getDb();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(eq(channelGuardianApprovalRequests.runId, runId))
    .orderBy(desc(channelGuardianApprovalRequests.createdAt))
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
  decision: 'approved' | 'denied',
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
  if (existing.status !== 'pending') {
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

/**
 * Count pending approval requests for a given conversation.
 * Used by thread state projection to compute `pending_escalation_count`.
 */
export function countPendingByConversation(
  conversationId: string,
  assistantId?: string,
): number {
  const db = getDb();

  const conditions = [
    eq(channelGuardianApprovalRequests.conversationId, conversationId),
    eq(channelGuardianApprovalRequests.status, 'pending'),
  ];
  if (assistantId) {
    conditions.push(eq(channelGuardianApprovalRequests.assistantId, assistantId));
  }

  const result = db
    .select({ count: count() })
    .from(channelGuardianApprovalRequests)
    .where(and(...conditions))
    .get();

  return result?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Verification Rate Limits
// ---------------------------------------------------------------------------

export interface VerificationRateLimit {
  id: string;
  assistantId: string;
  channel: string;
  actorExternalUserId: string;
  actorChatId: string;
  /** Individual attempt timestamps (epoch-ms) within the sliding window. */
  attemptTimestamps: number[];
  /** Total stored attempt count (may include expired timestamps; use lockedUntil for enforcement decisions). */
  invalidAttempts: number;
  lockedUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

function parseTimestamps(json: string): number[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function rowToRateLimit(row: typeof channelGuardianRateLimits.$inferSelect): VerificationRateLimit {
  const timestamps = parseTimestamps(row.attemptTimestampsJson);
  return {
    id: row.id,
    assistantId: row.assistantId,
    channel: row.channel,
    actorExternalUserId: row.actorExternalUserId,
    actorChatId: row.actorChatId,
    attemptTimestamps: timestamps,
    invalidAttempts: timestamps.length,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Get the rate-limit record for a given actor on a specific channel.
 */
export function getRateLimit(
  assistantId: string,
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): VerificationRateLimit | null {
  const db = getDb();
  const row = db
    .select()
    .from(channelGuardianRateLimits)
    .where(
      and(
        eq(channelGuardianRateLimits.assistantId, assistantId),
        eq(channelGuardianRateLimits.channel, channel),
        eq(channelGuardianRateLimits.actorExternalUserId, actorExternalUserId),
        eq(channelGuardianRateLimits.actorChatId, actorChatId),
      ),
    )
    .get();

  return row ? rowToRateLimit(row) : null;
}

/**
 * Record an invalid verification attempt using a true sliding window.
 *
 * Each individual attempt timestamp is stored; on every new attempt we
 * discard timestamps older than `windowMs`, append the current one, and
 * check whether the count exceeds `maxAttempts`. This avoids the
 * inactivity-timeout pitfall where attempts spaced just under the window
 * accumulate indefinitely.
 */
export function recordInvalidAttempt(
  assistantId: string,
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
  windowMs: number,
  maxAttempts: number,
  lockoutMs: number,
): VerificationRateLimit {
  const db = getDb();
  const now = Date.now();
  const cutoff = now - windowMs;

  const existing = getRateLimit(assistantId, channel, actorExternalUserId, actorChatId);

  if (existing) {
    // Keep only timestamps within the sliding window, then add the new one
    const recentTimestamps = existing.attemptTimestamps.filter((ts) => ts > cutoff);
    recentTimestamps.push(now);

    const newLockedUntil =
      recentTimestamps.length >= maxAttempts ? now + lockoutMs : existing.lockedUntil;

    const timestampsJson = JSON.stringify(recentTimestamps);

    db.update(channelGuardianRateLimits)
      .set({
        attemptTimestampsJson: timestampsJson,
        lockedUntil: newLockedUntil,
        updatedAt: now,
      })
      .where(eq(channelGuardianRateLimits.id, existing.id))
      .run();

    return {
      ...existing,
      attemptTimestamps: recentTimestamps,
      invalidAttempts: recentTimestamps.length,
      lockedUntil: newLockedUntil,
      updatedAt: now,
    };
  }

  // First attempt — create the row
  const id = uuid();
  const timestamps = [now];
  const lockedUntil = 1 >= maxAttempts ? now + lockoutMs : null;
  const row = {
    id,
    assistantId,
    channel,
    actorExternalUserId,
    actorChatId,
    // Legacy columns kept for backward compatibility with upgraded databases
    invalidAttempts: 0,
    windowStartedAt: 0,
    attemptTimestampsJson: JSON.stringify(timestamps),
    lockedUntil,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianRateLimits).values(row).run();

  return rowToRateLimit(row);
}

/**
 * Reset the rate-limit counter for a given actor (e.g. after a
 * successful verification).
 */
export function resetRateLimit(
  assistantId: string,
  channel: string,
  actorExternalUserId: string,
  actorChatId: string,
): void {
  const db = getDb();
  const now = Date.now();

  db.update(channelGuardianRateLimits)
    .set({
      attemptTimestampsJson: '[]',
      lockedUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(channelGuardianRateLimits.assistantId, assistantId),
        eq(channelGuardianRateLimits.channel, channel),
        eq(channelGuardianRateLimits.actorExternalUserId, actorExternalUserId),
        eq(channelGuardianRateLimits.actorChatId, actorChatId),
      ),
    )
    .run();
}

/**
 * CRUD store for channel guardian bindings, verification challenges,
 * and guardian approval requests.
 *
 * Guardian bindings record which external user is the designated guardian
 * for a given (assistantId, channel) pair. Verification challenges track
 * the cryptographic handshake used to prove guardian identity. Approval
 * requests track per-run guardian approval decisions.
 */

import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import {
  channelGuardianBindings,
  channelGuardianVerificationChallenges,
  channelGuardianApprovalRequests,
  channelGuardianRateLimits,
} from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BindingStatus = 'active' | 'revoked';
export type ChallengeStatus = 'pending' | 'consumed' | 'expired' | 'revoked';
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
    metadataJson: null,
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
    createdAt: now,
    updatedAt: now,
  };

  db.insert(channelGuardianVerificationChallenges).values(row).run();

  return rowToChallenge(row);
}

export function findPendingChallengeByHash(
  assistantId: string,
  channel: string,
  challengeHash: string,
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
        eq(channelGuardianVerificationChallenges.challengeHash, challengeHash),
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
        eq(channelGuardianApprovalRequests.status, 'pending'),
        gt(channelGuardianApprovalRequests.expiresAt, now),
      ),
    )
    .orderBy(desc(channelGuardianApprovalRequests.createdAt))
    .get();

  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Find a pending guardian approval request scoped to a specific run,
 * guardian chat, and channel. Used when a callback button provides a run ID,
 * so the decision is applied to exactly the right approval even when
 * multiple approvals target the same guardian chat.
 */
export function getPendingApprovalByRunAndGuardianChat(
  runId: string,
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
        eq(channelGuardianApprovalRequests.runId, runId),
        eq(channelGuardianApprovalRequests.channel, channel),
        eq(channelGuardianApprovalRequests.guardianChatId, guardianChatId),
        eq(channelGuardianApprovalRequests.status, 'pending'),
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
        eq(channelGuardianApprovalRequests.status, 'pending'),
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

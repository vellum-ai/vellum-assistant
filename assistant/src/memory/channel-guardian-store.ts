/**
 * CRUD store for channel guardian bindings, verification challenges,
 * and guardian approval requests.
 *
 * Guardian bindings record which external user is the designated guardian
 * for a given (assistantId, channel) pair. Verification challenges track
 * the cryptographic handshake used to prove guardian identity. Approval
 * requests track per-run guardian approval decisions.
 */

import { and, eq, gt } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import {
  channelGuardianBindings,
  channelGuardianVerificationChallenges,
  channelGuardianApprovalRequests,
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
 * Find a pending guardian approval request by the guardian's chat ID.
 * Used when the guardian sends a decision from their chat.
 */
export function getPendingApprovalByGuardianChat(
  channel: string,
  guardianChatId: string,
): GuardianApprovalRequest | null {
  const db = getDb();

  const row = db
    .select()
    .from(channelGuardianApprovalRequests)
    .where(
      and(
        eq(channelGuardianApprovalRequests.channel, channel),
        eq(channelGuardianApprovalRequests.guardianChatId, guardianChatId),
        eq(channelGuardianApprovalRequests.status, 'pending'),
      ),
    )
    .get();

  return row ? rowToApprovalRequest(row) : null;
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

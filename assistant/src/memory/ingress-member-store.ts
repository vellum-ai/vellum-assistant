/**
 * CRUD store for assistant ingress members — external users who have been
 * granted (or denied) access to interact with the assistant via a specific
 * channel. Members are keyed by raw channel identity fields (sourceChannel +
 * externalUserId / externalChatId).
 */

import { and, desc, eq, or } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import type { ChannelId } from '../channels/types.js';
import { updateChannelLastSeenByExternalChatId, updateChannelLastSeenByExternalId } from '../contacts/contact-store.js';
import { syncSingleMember } from '../contacts/contact-sync.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from '../runtime/assistant-scope.js';
import { canonicalizeInboundIdentity } from '../util/canonicalize-identity.js';
import { getLogger } from '../util/logger.js';
import { getDb } from './db-connection.js';
import { assistantIngressMembers } from './schema.js';

const log = getLogger('ingress-member-store');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberStatus = 'pending' | 'active' | 'revoked' | 'blocked';
export type MemberPolicy = 'allow' | 'deny' | 'escalate';

export interface IngressMember {
  id: string;
  assistantId: string;
  sourceChannel: string;
  externalUserId: string | null;
  externalChatId: string | null;
  displayName: string | null;
  username: string | null;
  status: MemberStatus;
  policy: MemberPolicy;
  inviteId: string | null;
  createdBySessionId: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToMember(row: typeof assistantIngressMembers.$inferSelect): IngressMember {
  return {
    id: row.id,
    assistantId: row.assistantId,
    sourceChannel: row.sourceChannel,
    externalUserId: row.externalUserId,
    externalChatId: row.externalChatId,
    displayName: row.displayName,
    username: row.username,
    status: row.status as MemberStatus,
    policy: row.policy as MemberPolicy,
    inviteId: row.inviteId,
    createdBySessionId: row.createdBySessionId,
    revokedReason: row.revokedReason,
    blockedReason: row.blockedReason,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// upsertMember
// ---------------------------------------------------------------------------

export function upsertMember(params: {
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  policy?: MemberPolicy;
  status?: MemberStatus;
  inviteId?: string;
  createdBySessionId?: string;
  assistantId?: string;
}): IngressMember {
  const assistantId = params.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;

  if (!params.externalUserId && !params.externalChatId) {
    throw new Error('At least one of externalUserId or externalChatId must be provided');
  }

  const db = getDb();
  const now = Date.now();

  // Try to find an existing member by (assistantId, sourceChannel, externalUserId)
  // or (assistantId, sourceChannel, externalChatId)
  const matchConditions = [];
  if (params.externalUserId) {
    matchConditions.push(
      and(
        eq(assistantIngressMembers.assistantId, assistantId),
        eq(assistantIngressMembers.sourceChannel, params.sourceChannel),
        eq(assistantIngressMembers.externalUserId, params.externalUserId),
      ),
    );
  }
  if (params.externalChatId) {
    matchConditions.push(
      and(
        eq(assistantIngressMembers.assistantId, assistantId),
        eq(assistantIngressMembers.sourceChannel, params.sourceChannel),
        eq(assistantIngressMembers.externalChatId, params.externalChatId),
      ),
    );
  }

  const existing = db
    .select()
    .from(assistantIngressMembers)
    .where(matchConditions.length === 1 ? matchConditions[0] : or(...matchConditions))
    .get();

  if (existing) {
    // Update the existing member
    const updates: Record<string, unknown> = { updatedAt: now };
    if (params.externalUserId !== undefined) updates.externalUserId = params.externalUserId;
    if (params.externalChatId !== undefined) updates.externalChatId = params.externalChatId;
    if (params.displayName !== undefined) updates.displayName = params.displayName;
    if (params.username !== undefined) updates.username = params.username;
    if (params.policy !== undefined) updates.policy = params.policy;
    if (params.status !== undefined) updates.status = params.status;
    if (params.inviteId !== undefined) updates.inviteId = params.inviteId;
    if (params.createdBySessionId !== undefined) updates.createdBySessionId = params.createdBySessionId;

    db.update(assistantIngressMembers)
      .set(updates)
      .where(eq(assistantIngressMembers.id, existing.id))
      .run();

    // Re-read to return the updated row
    const updated = db
      .select()
      .from(assistantIngressMembers)
      .where(eq(assistantIngressMembers.id, existing.id))
      .get();

    const member = rowToMember(updated!);
    try {
      syncSingleMember(member);
    } catch (err) {
      log.warn({ err }, 'Contact sync failed for ingress member update');
    }
    return member;
  }

  // Create a new member
  const id = uuid();
  const row = {
    id,
    assistantId,
    sourceChannel: params.sourceChannel,
    externalUserId: params.externalUserId ?? null,
    externalChatId: params.externalChatId ?? null,
    displayName: params.displayName ?? null,
    username: params.username ?? null,
    status: params.status ?? 'pending',
    policy: params.policy ?? 'allow',
    inviteId: params.inviteId ?? null,
    createdBySessionId: params.createdBySessionId ?? null,
    revokedReason: null,
    blockedReason: null,
    lastSeenAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(assistantIngressMembers).values(row).run();

  const member = rowToMember(row);
  try {
    syncSingleMember(member);
  } catch (err) {
    log.warn({ err }, 'Contact sync failed for ingress member insert');
  }
  return member;
}

// ---------------------------------------------------------------------------
// listMembers
// ---------------------------------------------------------------------------

export function listMembers(params?: {
  assistantId?: string;
  sourceChannel?: string;
  status?: MemberStatus;
  policy?: MemberPolicy;
  limit?: number;
  offset?: number;
}): IngressMember[] {
  const db = getDb();
  const assistantId = params?.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;

  const conditions = [eq(assistantIngressMembers.assistantId, assistantId)];
  if (params?.sourceChannel) {
    conditions.push(eq(assistantIngressMembers.sourceChannel, params.sourceChannel));
  }
  if (params?.status) {
    conditions.push(eq(assistantIngressMembers.status, params.status));
  }
  if (params?.policy) {
    conditions.push(eq(assistantIngressMembers.policy, params.policy));
  }

  let query = db
    .select()
    .from(assistantIngressMembers)
    .where(and(...conditions))
    .orderBy(desc(assistantIngressMembers.updatedAt))
    .$dynamic();

  if (params?.limit !== undefined) {
    query = query.limit(params.limit);
  }
  if (params?.offset !== undefined) {
    query = query.offset(params.offset);
  }

  return query.all().map(rowToMember);
}

// ---------------------------------------------------------------------------
// revokeMember
// ---------------------------------------------------------------------------

export function revokeMember(memberId: string, reason?: string): IngressMember | null {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select()
    .from(assistantIngressMembers)
    .where(eq(assistantIngressMembers.id, memberId))
    .get();

  if (!existing) return null;

  // Only revoke from active or pending status
  if (existing.status !== 'active' && existing.status !== 'pending') {
    return null;
  }

  db.update(assistantIngressMembers)
    .set({
      status: 'revoked',
      revokedReason: reason ?? null,
      updatedAt: now,
    })
    .where(eq(assistantIngressMembers.id, memberId))
    .run();

  const updated = db
    .select()
    .from(assistantIngressMembers)
    .where(eq(assistantIngressMembers.id, memberId))
    .get();

  if (!updated) return null;
  const member = rowToMember(updated);
  try {
    syncSingleMember(member);
  } catch (err) {
    log.warn({ err }, 'Contact sync failed for ingress member revoke');
  }
  return member;
}

// ---------------------------------------------------------------------------
// blockMember
// ---------------------------------------------------------------------------

export function blockMember(memberId: string, reason?: string): IngressMember | null {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select()
    .from(assistantIngressMembers)
    .where(eq(assistantIngressMembers.id, memberId))
    .get();

  if (!existing) return null;

  // Can block from any non-blocked status
  if (existing.status === 'blocked') {
    return null;
  }

  db.update(assistantIngressMembers)
    .set({
      status: 'blocked',
      blockedReason: reason ?? null,
      updatedAt: now,
    })
    .where(eq(assistantIngressMembers.id, memberId))
    .run();

  const updated = db
    .select()
    .from(assistantIngressMembers)
    .where(eq(assistantIngressMembers.id, memberId))
    .get();

  if (!updated) return null;
  const member = rowToMember(updated);
  try {
    syncSingleMember(member);
  } catch (err) {
    log.warn({ err }, 'Contact sync failed for ingress member block');
  }
  return member;
}

// ---------------------------------------------------------------------------
// findMember
// ---------------------------------------------------------------------------

export function findMember(params: {
  assistantId?: string;
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
}): IngressMember | null {
  if (!params.externalUserId && !params.externalChatId) {
    return null;
  }

  const db = getDb();
  const assistantId = params.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;

  // Prefer lookup by externalUserId when available, fall back to externalChatId
  const matchConditions = [];
  if (params.externalUserId) {
    matchConditions.push(
      and(
        eq(assistantIngressMembers.assistantId, assistantId),
        eq(assistantIngressMembers.sourceChannel, params.sourceChannel),
        eq(assistantIngressMembers.externalUserId, params.externalUserId),
      ),
    );
  }
  if (params.externalChatId) {
    matchConditions.push(
      and(
        eq(assistantIngressMembers.assistantId, assistantId),
        eq(assistantIngressMembers.sourceChannel, params.sourceChannel),
        eq(assistantIngressMembers.externalChatId, params.externalChatId),
      ),
    );
  }

  const row = db
    .select()
    .from(assistantIngressMembers)
    .where(matchConditions.length === 1 ? matchConditions[0] : or(...matchConditions))
    .get();

  return row ? rowToMember(row) : null;
}

// ---------------------------------------------------------------------------
// updateLastSeen
// ---------------------------------------------------------------------------

export function updateLastSeen(memberId: string): void {
  const db = getDb();
  const now = Date.now();

  db.update(assistantIngressMembers)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(eq(assistantIngressMembers.id, memberId))
    .run();

  // Forward-sync lastSeenAt to contacts
  try {
    const member = db
      .select({
        sourceChannel: assistantIngressMembers.sourceChannel,
        externalUserId: assistantIngressMembers.externalUserId,
        externalChatId: assistantIngressMembers.externalChatId,
      })
      .from(assistantIngressMembers)
      .where(eq(assistantIngressMembers.id, memberId))
      .get();
    if (member?.externalUserId) {
      // Canonicalize to match the form stored in contactChannels (e.g. E.164 for phone channels)
      const canonicalId =
        canonicalizeInboundIdentity(member.sourceChannel as ChannelId, member.externalUserId)
        ?? member.externalUserId;
      updateChannelLastSeenByExternalId(member.sourceChannel, canonicalId);
    } else if (member?.externalChatId) {
      // Fallback for members created with only a chat ID (no externalUserId)
      updateChannelLastSeenByExternalChatId(member.sourceChannel, member.externalChatId);
    }
  } catch (err) {
    log.warn({ err }, 'Contact sync failed for last seen update');
  }
}

/**
 * CRUD store for assistant ingress invites.
 *
 * Invites allow external users to join an assistant's ingress (inbox) on a
 * specific channel. Each invite carries a SHA-256 hashed token — the raw
 * token is returned exactly once at creation time and never stored.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { getDb } from './db.js';
import { assistantIngressInvites, assistantIngressMembers } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InviteStatus = 'active' | 'redeemed' | 'revoked' | 'expired';

export interface IngressInvite {
  id: string;
  assistantId: string;
  sourceChannel: string;
  tokenHash: string;
  createdBySessionId: string | null;
  note: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: number;
  status: InviteStatus;
  redeemedByExternalUserId: string | null;
  redeemedByExternalChatId: string | null;
  redeemedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface IngressMember {
  id: string;
  assistantId: string;
  sourceChannel: string;
  externalUserId: string | null;
  externalChatId: string | null;
  displayName: string | null;
  username: string | null;
  status: string;
  policy: string;
  inviteId: string | null;
  createdBySessionId: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateToken(): string {
  // 32 bytes = 256 bits of entropy, base64url-encoded to a 43-character URL-safe string.
  return randomBytes(32).toString('base64url');
}

function rowToInvite(row: typeof assistantIngressInvites.$inferSelect): IngressInvite {
  return {
    id: row.id,
    assistantId: row.assistantId,
    sourceChannel: row.sourceChannel,
    tokenHash: row.tokenHash,
    createdBySessionId: row.createdBySessionId,
    note: row.note,
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt,
    status: row.status as InviteStatus,
    redeemedByExternalUserId: row.redeemedByExternalUserId,
    redeemedByExternalChatId: row.redeemedByExternalChatId,
    redeemedAt: row.redeemedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToMember(row: typeof assistantIngressMembers.$inferSelect): IngressMember {
  return {
    id: row.id,
    assistantId: row.assistantId,
    sourceChannel: row.sourceChannel,
    externalUserId: row.externalUserId,
    externalChatId: row.externalChatId,
    displayName: row.displayName,
    username: row.username,
    status: row.status,
    policy: row.policy,
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
// createInvite
// ---------------------------------------------------------------------------

export function createInvite(params: {
  assistantId?: string;
  sourceChannel: string;
  createdBySessionId?: string;
  note?: string;
  maxUses?: number;
  expiresInMs?: number;
}): { invite: IngressInvite; rawToken: string } {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const rawToken = generateToken();
  const tokenH = hashToken(rawToken);

  const row = {
    id,
    assistantId: params.assistantId ?? 'self',
    sourceChannel: params.sourceChannel,
    tokenHash: tokenH,
    createdBySessionId: params.createdBySessionId ?? null,
    note: params.note ?? null,
    maxUses: params.maxUses ?? 1,
    useCount: 0,
    expiresAt: now + (params.expiresInMs ?? DEFAULT_EXPIRY_MS),
    status: 'active' as const,
    redeemedByExternalUserId: null,
    redeemedByExternalChatId: null,
    redeemedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(assistantIngressInvites).values(row).run();

  return { invite: rowToInvite(row), rawToken };
}

// ---------------------------------------------------------------------------
// listInvites
// ---------------------------------------------------------------------------

export function listInvites(params: {
  assistantId?: string;
  sourceChannel?: string;
  status?: InviteStatus;
  limit?: number;
  offset?: number;
}): IngressInvite[] {
  const db = getDb();
  const assistantId = params.assistantId ?? 'self';

  const conditions = [eq(assistantIngressInvites.assistantId, assistantId)];

  if (params.sourceChannel) {
    conditions.push(eq(assistantIngressInvites.sourceChannel, params.sourceChannel));
  }
  if (params.status) {
    conditions.push(eq(assistantIngressInvites.status, params.status));
  }

  const rows = db
    .select()
    .from(assistantIngressInvites)
    .where(and(...conditions))
    .orderBy(desc(assistantIngressInvites.createdAt))
    .limit(params.limit ?? 100)
    .offset(params.offset ?? 0)
    .all();

  return rows.map(rowToInvite);
}

// ---------------------------------------------------------------------------
// revokeInvite
// ---------------------------------------------------------------------------

export function revokeInvite(inviteId: string): IngressInvite | null {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select()
    .from(assistantIngressInvites)
    .where(
      and(
        eq(assistantIngressInvites.id, inviteId),
        eq(assistantIngressInvites.status, 'active'),
      ),
    )
    .get();

  if (!existing) return null;

  db.update(assistantIngressInvites)
    .set({ status: 'revoked', updatedAt: now })
    .where(eq(assistantIngressInvites.id, inviteId))
    .run();

  return rowToInvite({ ...existing, status: 'revoked', updatedAt: now });
}

// ---------------------------------------------------------------------------
// redeemInvite
// ---------------------------------------------------------------------------

export interface RedeemError {
  error: string;
}

export function redeemInvite(params: {
  rawToken: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  sourceChannel?: string;
}): { invite: IngressInvite; member: IngressMember } | RedeemError {
  const db = getDb();
  const now = Date.now();
  const tokenH = hashToken(params.rawToken);

  const invite = db
    .select()
    .from(assistantIngressInvites)
    .where(eq(assistantIngressInvites.tokenHash, tokenH))
    .get();

  if (!invite) {
    return { error: 'invite_not_found' };
  }

  if (invite.status !== 'active') {
    return { error: `invite_${invite.status}` };
  }

  if (invite.expiresAt <= now) {
    // Mark as expired for future lookups
    db.update(assistantIngressInvites)
      .set({ status: 'expired', updatedAt: now })
      .where(eq(assistantIngressInvites.id, invite.id))
      .run();
    return { error: 'invite_expired' };
  }

  if (invite.useCount >= invite.maxUses) {
    return { error: 'invite_max_uses_reached' };
  }

  const newUseCount = invite.useCount + 1;
  const newStatus = newUseCount >= invite.maxUses ? 'redeemed' : 'active';

  // Update invite in a transaction with member creation
  const memberId = randomUUID();
  const sourceChannel = params.sourceChannel ?? invite.sourceChannel;

  const memberRow = {
    id: memberId,
    assistantId: invite.assistantId,
    sourceChannel,
    externalUserId: params.externalUserId ?? null,
    externalChatId: params.externalChatId ?? null,
    displayName: params.displayName ?? null,
    username: params.username ?? null,
    status: 'active' as const,
    policy: 'allow' as const,
    inviteId: invite.id,
    createdBySessionId: null,
    revokedReason: null,
    blockedReason: null,
    lastSeenAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.transaction((tx) => {
    tx.update(assistantIngressInvites)
      .set({
        useCount: newUseCount,
        status: newStatus,
        redeemedByExternalUserId: params.externalUserId ?? null,
        redeemedByExternalChatId: params.externalChatId ?? null,
        redeemedAt: now,
        updatedAt: now,
      })
      .where(eq(assistantIngressInvites.id, invite.id))
      .run();

    tx.insert(assistantIngressMembers).values(memberRow).run();
  });

  const updatedInvite: IngressInvite = {
    ...rowToInvite(invite),
    useCount: newUseCount,
    status: newStatus as InviteStatus,
    redeemedByExternalUserId: params.externalUserId ?? null,
    redeemedByExternalChatId: params.externalChatId ?? null,
    redeemedAt: now,
    updatedAt: now,
  };

  return { invite: updatedInvite, member: rowToMember(memberRow) };
}

// ---------------------------------------------------------------------------
// findByTokenHash
// ---------------------------------------------------------------------------

export function findByTokenHash(tokenHash: string): IngressInvite | null {
  const db = getDb();

  const row = db
    .select()
    .from(assistantIngressInvites)
    .where(eq(assistantIngressInvites.tokenHash, tokenHash))
    .get();

  return row ? rowToInvite(row) : null;
}

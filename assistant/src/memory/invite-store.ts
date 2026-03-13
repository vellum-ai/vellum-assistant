/**
 * CRUD store for assistant ingress invites.
 *
 * Invites allow external users to join an assistant's ingress (inbox) on a
 * specific channel. Each invite carries a SHA-256 hashed token — the raw
 * token is returned exactly once at creation time and never stored.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, desc, eq, gt } from "drizzle-orm";

import { getDb } from "./db.js";
import { assistantIngressInvites } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InviteStatus = "active" | "redeemed" | "revoked" | "expired";

export interface IngressInvite {
  id: string;
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
  // Voice invite fields (null for non-voice invites)
  expectedExternalUserId: string | null;
  voiceCodeHash: string | null;
  voiceCodeDigits: number | null;
  // 6-digit invite code hash (null for voice invites which use voiceCodeHash)
  inviteCodeHash: string | null;
  // Display metadata for personalized voice prompts (null for non-voice invites)
  friendName: string | null;
  guardianName: string | null;
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

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function generateToken(): string {
  // 32 bytes = 256 bits of entropy, base64url-encoded to a 43-character URL-safe string.
  return randomBytes(32).toString("base64url");
}

function rowToInvite(
  row: typeof assistantIngressInvites.$inferSelect,
): IngressInvite {
  return {
    id: row.id,
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
    expectedExternalUserId: row.expectedExternalUserId,
    voiceCodeHash: row.voiceCodeHash,
    voiceCodeDigits: row.voiceCodeDigits,
    inviteCodeHash: row.inviteCodeHash,
    friendName: row.friendName,
    guardianName: row.guardianName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// createInvite
// ---------------------------------------------------------------------------

export function createInvite(params: {
  sourceChannel: string;
  createdBySessionId?: string;
  note?: string;
  maxUses?: number;
  expiresInMs?: number;
  // Voice invite metadata (all optional — omitted for non-voice invites)
  expectedExternalUserId?: string;
  voiceCodeHash?: string;
  voiceCodeDigits?: number;
  // 6-digit invite code hash (for non-voice invites)
  inviteCodeHash?: string;
  friendName?: string;
  guardianName?: string;
}): { invite: IngressInvite; rawToken: string } {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const rawToken = generateToken();
  const tokenH = hashToken(rawToken);

  const row = {
    id,
    sourceChannel: params.sourceChannel,
    tokenHash: tokenH,
    createdBySessionId: params.createdBySessionId ?? null,
    note: params.note ?? null,
    maxUses: params.maxUses ?? 1,
    useCount: 0,
    expiresAt: now + (params.expiresInMs ?? DEFAULT_EXPIRY_MS),
    status: "active" as const,
    redeemedByExternalUserId: null,
    redeemedByExternalChatId: null,
    redeemedAt: null,
    expectedExternalUserId: params.expectedExternalUserId ?? null,
    voiceCodeHash: params.voiceCodeHash ?? null,
    voiceCodeDigits: params.voiceCodeDigits ?? null,
    inviteCodeHash: params.inviteCodeHash ?? null,
    friendName: params.friendName ?? null,
    guardianName: params.guardianName ?? null,
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
  sourceChannel?: string;
  status?: InviteStatus;
  limit?: number;
  offset?: number;
}): IngressInvite[] {
  const db = getDb();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];

  if (params.sourceChannel) {
    conditions.push(
      eq(assistantIngressInvites.sourceChannel, params.sourceChannel),
    );
  }
  if (params.status) {
    conditions.push(eq(assistantIngressInvites.status, params.status));
  }

  const query = db.select().from(assistantIngressInvites);

  const rows = (conditions.length > 0 ? query.where(and(...conditions)) : query)
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
        eq(assistantIngressInvites.status, "active"),
      ),
    )
    .get();

  if (!existing) return null;

  db.update(assistantIngressInvites)
    .set({ status: "revoked", updatedAt: now })
    .where(eq(assistantIngressInvites.id, inviteId))
    .run();

  return rowToInvite({ ...existing, status: "revoked", updatedAt: now });
}

// ---------------------------------------------------------------------------
// recordInviteUse — consume one use without creating a member row
// ---------------------------------------------------------------------------

/**
 * Increment an invite's use count and record redemption metadata without
 * inserting a new member row. Used when reactivating an existing inactive
 * member via invite — the member row already exists and just needs an
 * update, so the transactional INSERT in `redeemInvite` would hit a
 * unique-key constraint.
 *
 * Returns `true` if the use was recorded, or `false` if the invite was
 * concurrently revoked/expired (the WHERE clause constrains to
 * `status = 'active'` so a stale write is impossible).
 */
export function recordInviteUse(params: {
  inviteId: string;
  externalUserId?: string;
  externalChatId?: string;
}): boolean {
  const db = getDb();
  const now = Date.now();

  const invite = db
    .select()
    .from(assistantIngressInvites)
    .where(eq(assistantIngressInvites.id, params.inviteId))
    .get();

  if (!invite) return false;

  const newUseCount = invite.useCount + 1;
  const newStatus = newUseCount >= invite.maxUses ? "redeemed" : "active";

  // Constrain the update to active invites so a concurrent revoke/expire
  // prevents this write rather than silently overwriting the new status.
  db.update(assistantIngressInvites)
    .set({
      useCount: newUseCount,
      status: newStatus,
      redeemedByExternalUserId: params.externalUserId ?? null,
      redeemedByExternalChatId: params.externalChatId ?? null,
      redeemedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(assistantIngressInvites.id, invite.id),
        eq(assistantIngressInvites.status, "active"),
      ),
    )
    .run();

  // Re-read to confirm the update took effect (the WHERE clause constrains
  // to status = 'active', so a concurrent revoke/expire would prevent it).
  const updated = db
    .select({ useCount: assistantIngressInvites.useCount })
    .from(assistantIngressInvites)
    .where(eq(assistantIngressInvites.id, invite.id))
    .get();

  return !!updated && updated.useCount === newUseCount;
}

// ---------------------------------------------------------------------------
// markInviteExpired
// ---------------------------------------------------------------------------

/**
 * Transition an invite's status to 'expired' in storage. This is safe to call
 * even if the invite is already expired — the WHERE clause scopes the update
 * to 'active' rows so it becomes a no-op in that case.
 */
export function markInviteExpired(inviteId: string): void {
  const db = getDb();
  const now = Date.now();

  db.update(assistantIngressInvites)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(assistantIngressInvites.id, inviteId),
        eq(assistantIngressInvites.status, "active"),
      ),
    )
    .run();
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

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

export function findById(inviteId: string): IngressInvite | null {
  const db = getDb();
  const row = db
    .select()
    .from(assistantIngressInvites)
    .where(eq(assistantIngressInvites.id, inviteId))
    .get();
  return row ? rowToInvite(row) : null;
}

// ---------------------------------------------------------------------------
// findActiveVoiceInvites
// ---------------------------------------------------------------------------

/**
 * Find all active voice invites bound to a specific caller identity.
 * Used by the voice invite redemption flow to locate candidate invites
 * before code hash matching.
 */
export function findActiveVoiceInvites(params: {
  expectedExternalUserId: string;
}): IngressInvite[] {
  const db = getDb();

  const rows = db
    .select()
    .from(assistantIngressInvites)
    .where(
      and(
        eq(assistantIngressInvites.sourceChannel, "phone"),
        eq(assistantIngressInvites.status, "active"),
        eq(
          assistantIngressInvites.expectedExternalUserId,
          params.expectedExternalUserId,
        ),
      ),
    )
    .all();

  return rows.map(rowToInvite);
}

// ---------------------------------------------------------------------------
// findByInviteCodeHash
// ---------------------------------------------------------------------------

/**
 * Find an active invite by its 6-digit invite code hash, scoped to a specific
 * source channel. Channel scoping is required because 6-digit codes are drawn
 * from a small keyspace and can collide across channels — without it, `.get()`
 * could return an arbitrary match, leading to nondeterministic redemption or
 * false channel-mismatch failures downstream.
 */
export function findByInviteCodeHash(
  hash: string,
  sourceChannel: string,
): IngressInvite | null {
  const db = getDb();

  const row = db
    .select()
    .from(assistantIngressInvites)
    .where(
      and(
        eq(assistantIngressInvites.inviteCodeHash, hash),
        eq(assistantIngressInvites.sourceChannel, sourceChannel),
        eq(assistantIngressInvites.status, "active"),
      ),
    )
    .get();

  return row ? rowToInvite(row) : null;
}

// ---------------------------------------------------------------------------
// findByInviteCodeHashAnyChannel
// ---------------------------------------------------------------------------

/**
 * Find an active invite by its 6-digit invite code hash without channel
 * scoping. Used as a fallback after a channel-scoped lookup fails, to
 * distinguish "code doesn't exist" from "code exists but for a different
 * channel" — the latter should produce a channel_mismatch response instead
 * of silently falling through.
 */
export function findByInviteCodeHashAnyChannel(
  hash: string,
): IngressInvite | null {
  const db = getDb();
  const now = Date.now();

  const row = db
    .select()
    .from(assistantIngressInvites)
    .where(
      and(
        eq(assistantIngressInvites.inviteCodeHash, hash),
        eq(assistantIngressInvites.status, "active"),
        gt(assistantIngressInvites.expiresAt, now),
      ),
    )
    .get();

  return row ? rowToInvite(row) : null;
}

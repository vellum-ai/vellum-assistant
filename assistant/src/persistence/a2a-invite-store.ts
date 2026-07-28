/**
 * Store for daemon-local A2A invites.
 *
 * A2A invites bind a placeholder assistant contact to a shareable token used
 * for link-based peer-assistant connection. Each invite carries a SHA-256
 * hashed token — the raw token is returned exactly once at creation time and
 * never stored.
 */

import { randomUUID } from "node:crypto";

import {
  generateInviteToken,
  hashInviteToken,
} from "@vellumai/gateway-client";
import { and, eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { a2aInvites } from "./schema/a2a.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type A2aInviteStatus = "active" | "redeemed" | "revoked" | "expired";

export interface A2aInvite {
  id: string;
  tokenHash: string;
  contactId: string;
  maxUses: number;
  useCount: number;
  expiresAt: number;
  status: A2aInviteStatus;
  redeemedByExternalUserId: string | null;
  redeemedAt: number | null;
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

function rowToInvite(row: typeof a2aInvites.$inferSelect): A2aInvite {
  return { ...row, status: row.status as A2aInviteStatus };
}

function findByTokenHash(tokenHash: string): A2aInvite | null {
  const db = getDb();
  const row = db
    .select()
    .from(a2aInvites)
    .where(eq(a2aInvites.tokenHash, tokenHash))
    .get();
  return row ? rowToInvite(row) : null;
}

/**
 * Transition an invite's status to 'expired' in storage. Safe to call even if
 * the invite is already expired — the WHERE clause scopes the update to
 * 'active' rows so it becomes a no-op in that case.
 */
function markExpired(inviteId: string): void {
  const db = getDb();
  db.update(a2aInvites)
    .set({ status: "expired", updatedAt: Date.now() })
    .where(and(eq(a2aInvites.id, inviteId), eq(a2aInvites.status, "active")))
    .run();
}

/**
 * Increment an invite's use count and record redemption metadata. Returns
 * `true` if the use was recorded, or `false` if the invite was concurrently
 * revoked/expired (the WHERE clause constrains to `status = 'active'` so a
 * stale write is impossible).
 */
function recordUse(params: {
  inviteId: string;
  redeemedByExternalUserId: string;
}): boolean {
  const db = getDb();
  const now = Date.now();

  const invite = db
    .select()
    .from(a2aInvites)
    .where(eq(a2aInvites.id, params.inviteId))
    .get();

  if (!invite) {
    return false;
  }

  const newUseCount = invite.useCount + 1;
  const newStatus = newUseCount >= invite.maxUses ? "redeemed" : "active";

  db.update(a2aInvites)
    .set({
      useCount: newUseCount,
      status: newStatus,
      redeemedByExternalUserId: params.redeemedByExternalUserId,
      redeemedAt: now,
      updatedAt: now,
    })
    .where(and(eq(a2aInvites.id, invite.id), eq(a2aInvites.status, "active")))
    .run();

  // Re-read to confirm the update took effect (the WHERE clause constrains
  // to status = 'active', so a concurrent revoke/expire would prevent it).
  const updated = db
    .select({ useCount: a2aInvites.useCount })
    .from(a2aInvites)
    .where(eq(a2aInvites.id, invite.id))
    .get();

  return !!updated && updated.useCount === newUseCount;
}

// ---------------------------------------------------------------------------
// createA2aInvite
// ---------------------------------------------------------------------------

export function createA2aInvite(params: {
  contactId: string;
  maxUses?: number;
  expiresInMs?: number;
}): { invite: A2aInvite; rawToken: string } {
  const db = getDb();
  const now = Date.now();
  const rawToken = generateInviteToken();

  const row = {
    id: randomUUID(),
    tokenHash: hashInviteToken(rawToken),
    contactId: params.contactId,
    maxUses: params.maxUses ?? 1,
    useCount: 0,
    expiresAt: now + (params.expiresInMs ?? DEFAULT_EXPIRY_MS),
    status: "active" as const,
    redeemedByExternalUserId: null,
    redeemedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(a2aInvites).values(row).run();

  return { invite: rowToInvite(row), rawToken };
}

// ---------------------------------------------------------------------------
// claimA2aInvite — validate + consume an A2A invite token
// ---------------------------------------------------------------------------

export function claimA2aInvite(params: {
  token: string;
  redeemedByExternalUserId: string;
}): { claimed: boolean; invite: A2aInvite | null; error?: string } {
  const tokenHash = hashInviteToken(params.token);
  const invite = findByTokenHash(tokenHash);

  if (!invite) {
    return { claimed: false, invite: null, error: "not_found" };
  }

  // Idempotency: if already redeemed by the same acceptor, return success
  if (invite.status === "redeemed") {
    if (invite.redeemedByExternalUserId === params.redeemedByExternalUserId) {
      return { claimed: true, invite };
    }
    return { claimed: false, invite, error: "already_redeemed_by_other" };
  }

  if (invite.status !== "active") {
    return { claimed: false, invite, error: "not_found" };
  }

  if (Date.now() >= invite.expiresAt) {
    markExpired(invite.id);
    return { claimed: false, invite, error: "expired" };
  }

  if (invite.useCount >= invite.maxUses) {
    return { claimed: false, invite, error: "already_redeemed" };
  }

  const recorded = recordUse({
    inviteId: invite.id,
    redeemedByExternalUserId: params.redeemedByExternalUserId,
  });

  if (!recorded) {
    return { claimed: false, invite, error: "not_found" };
  }

  // Re-read to get updated state
  return { claimed: true, invite: findByTokenHash(tokenHash) };
}

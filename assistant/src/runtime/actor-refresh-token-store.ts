/**
 * Hash-only refresh token persistence.
 *
 * Stores SHA-256 hash of each refresh token with family tracking,
 * device binding, and dual expiry (absolute + inactivity).
 */

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import { getDb } from '../memory/db.js';
import { actorRefreshTokenRecords } from '../memory/schema.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('actor-refresh-token-store');

export type RefreshTokenStatus = 'active' | 'rotated' | 'revoked';

export interface RefreshTokenRecord {
  id: string;
  tokenHash: string;
  familyId: string;
  assistantId: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  status: RefreshTokenStatus;
  issuedAt: number;
  absoluteExpiresAt: number;
  inactivityExpiresAt: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Create a new refresh token record (hash-only). */
export function createRefreshTokenRecord(params: {
  tokenHash: string;
  familyId: string;
  assistantId: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  issuedAt: number;
  absoluteExpiresAt: number;
  inactivityExpiresAt: number;
}): RefreshTokenRecord {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    tokenHash: params.tokenHash,
    familyId: params.familyId,
    assistantId: params.assistantId,
    guardianPrincipalId: params.guardianPrincipalId,
    hashedDeviceId: params.hashedDeviceId,
    platform: params.platform,
    status: 'active' as const,
    issuedAt: params.issuedAt,
    absoluteExpiresAt: params.absoluteExpiresAt,
    inactivityExpiresAt: params.inactivityExpiresAt,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(actorRefreshTokenRecords).values(row).run();
  log.info({ id, familyId: params.familyId, platform: params.platform }, 'Refresh token record created');
  return row;
}

/** Look up a refresh token record by hash (ANY status - needed for replay detection). */
export function findByTokenHash(tokenHash: string): RefreshTokenRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(actorRefreshTokenRecords)
    .where(eq(actorRefreshTokenRecords.tokenHash, tokenHash))
    .get();
  return row ? rowToRecord(row) : null;
}

/** Find the active refresh token for a device binding. */
export function findActiveByDeviceBinding(
  assistantId: string,
  guardianPrincipalId: string,
  hashedDeviceId: string,
): RefreshTokenRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(actorRefreshTokenRecords)
    .where(
      and(
        eq(actorRefreshTokenRecords.assistantId, assistantId),
        eq(actorRefreshTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorRefreshTokenRecords.hashedDeviceId, hashedDeviceId),
        eq(actorRefreshTokenRecords.status, 'active'),
      ),
    )
    .get();
  return row ? rowToRecord(row) : null;
}

/** Mark a refresh token as rotated (used successfully, replaced by a new one). */
export function markRotated(tokenHash: string): boolean {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .select({ id: actorRefreshTokenRecords.id })
    .from(actorRefreshTokenRecords)
    .where(
      and(
        eq(actorRefreshTokenRecords.tokenHash, tokenHash),
        eq(actorRefreshTokenRecords.status, 'active'),
      ),
    )
    .get();
  if (!existing) return false;

  db.update(actorRefreshTokenRecords)
    .set({ status: 'rotated', lastUsedAt: now, updatedAt: now })
    .where(
      and(
        eq(actorRefreshTokenRecords.tokenHash, tokenHash),
        eq(actorRefreshTokenRecords.status, 'active'),
      ),
    )
    .run();
  return true;
}

/** Revoke all tokens in a family (replay detection response). */
export function revokeFamily(familyId: string): number {
  const db = getDb();
  const now = Date.now();
  const matching = db
    .select({ id: actorRefreshTokenRecords.id })
    .from(actorRefreshTokenRecords)
    .where(eq(actorRefreshTokenRecords.familyId, familyId))
    .all();
  if (matching.length === 0) return 0;

  db.update(actorRefreshTokenRecords)
    .set({ status: 'revoked', updatedAt: now })
    .where(eq(actorRefreshTokenRecords.familyId, familyId))
    .run();
  return matching.length;
}

/** Revoke all active refresh tokens for a device binding. */
export function revokeByDeviceBinding(
  assistantId: string,
  guardianPrincipalId: string,
  hashedDeviceId: string,
): number {
  const db = getDb();
  const now = Date.now();
  const condition = and(
    eq(actorRefreshTokenRecords.assistantId, assistantId),
    eq(actorRefreshTokenRecords.guardianPrincipalId, guardianPrincipalId),
    eq(actorRefreshTokenRecords.hashedDeviceId, hashedDeviceId),
    eq(actorRefreshTokenRecords.status, 'active'),
  );
  const matching = db
    .select({ id: actorRefreshTokenRecords.id })
    .from(actorRefreshTokenRecords)
    .where(condition)
    .all();
  if (matching.length === 0) return 0;

  db.update(actorRefreshTokenRecords)
    .set({ status: 'revoked', updatedAt: now })
    .where(condition)
    .run();
  return matching.length;
}

/** Update inactivity expiry timestamp on successful use. */
export function touchInactivityExpiry(tokenHash: string, newInactivityExpiresAt: number): void {
  const db = getDb();
  const now = Date.now();
  db.update(actorRefreshTokenRecords)
    .set({ inactivityExpiresAt: newInactivityExpiresAt, lastUsedAt: now, updatedAt: now })
    .where(
      and(
        eq(actorRefreshTokenRecords.tokenHash, tokenHash),
        eq(actorRefreshTokenRecords.status, 'active'),
      ),
    )
    .run();
}

function rowToRecord(row: typeof actorRefreshTokenRecords.$inferSelect): RefreshTokenRecord {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    assistantId: row.assistantId,
    guardianPrincipalId: row.guardianPrincipalId,
    hashedDeviceId: row.hashedDeviceId,
    platform: row.platform,
    status: row.status as RefreshTokenStatus,
    issuedAt: row.issuedAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    inactivityExpiresAt: row.inactivityExpiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

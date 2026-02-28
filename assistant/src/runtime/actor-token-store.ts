/**
 * Hash-only actor token persistence.
 *
 * Stores only the SHA-256 hash of each actor token alongside metadata
 * (assistantId, guardianPrincipalId, deviceId hash, platform, status).
 * The raw token plaintext is never stored.
 *
 * Uses the assistant SQLite database via drizzle-orm.
 */

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import { getDb } from '../memory/db.js';
import { actorTokenRecords } from '../memory/schema.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('actor-token-store');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActorTokenStatus = 'active' | 'revoked';

export interface ActorTokenRecord {
  id: string;
  tokenHash: string;
  assistantId: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  status: ActorTokenStatus;
  issuedAt: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Store a new actor token record (hash-only).
 */
export function createActorTokenRecord(params: {
  tokenHash: string;
  assistantId: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  issuedAt: number;
  expiresAt?: number | null;
}): ActorTokenRecord {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const row = {
    id,
    tokenHash: params.tokenHash,
    assistantId: params.assistantId,
    guardianPrincipalId: params.guardianPrincipalId,
    hashedDeviceId: params.hashedDeviceId,
    platform: params.platform,
    status: 'active' as const,
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(actorTokenRecords).values(row).run();
  log.info({ id, assistantId: params.assistantId, platform: params.platform }, 'Actor token record created');

  return row;
}

/**
 * Look up an active actor token record by its hash.
 */
export function findActiveByTokenHash(tokenHash: string): ActorTokenRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(actorTokenRecords)
    .where(
      and(
        eq(actorTokenRecords.tokenHash, tokenHash),
        eq(actorTokenRecords.status, 'active'),
      ),
    )
    .get();

  return row ? rowToRecord(row) : null;
}

/**
 * Find an active token for a specific (assistantId, guardianPrincipalId, deviceId).
 * Used for idempotent bootstrap — if an active token already exists for this
 * device binding, we can revoke-and-remint or return the existing record.
 */
export function findActiveByDeviceBinding(
  assistantId: string,
  guardianPrincipalId: string,
  hashedDeviceId: string,
): ActorTokenRecord | null {
  const db = getDb();
  const row = db
    .select()
    .from(actorTokenRecords)
    .where(
      and(
        eq(actorTokenRecords.assistantId, assistantId),
        eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorTokenRecords.hashedDeviceId, hashedDeviceId),
        eq(actorTokenRecords.status, 'active'),
      ),
    )
    .get();

  return row ? rowToRecord(row) : null;
}

/**
 * Revoke all active tokens for a given device binding.
 * Called before minting a new token to ensure one-active-per-device.
 */
export function revokeByDeviceBinding(
  assistantId: string,
  guardianPrincipalId: string,
  hashedDeviceId: string,
): number {
  const db = getDb();
  const now = Date.now();

  const result = db
    .update(actorTokenRecords)
    .set({ status: 'revoked', updatedAt: now })
    .where(
      and(
        eq(actorTokenRecords.assistantId, assistantId),
        eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorTokenRecords.hashedDeviceId, hashedDeviceId),
        eq(actorTokenRecords.status, 'active'),
      ),
    )
    .run();

  return result.changes;
}

/**
 * Find all active actor token records for a given (assistantId, guardianPrincipalId).
 * Used for multi-device guardian fanout — returns all bound devices (macOS, iOS, etc.)
 * so notification targeting can reach every device for the same guardian identity.
 */
export function findActiveByGuardianPrincipalId(
  assistantId: string,
  guardianPrincipalId: string,
): ActorTokenRecord[] {
  const db = getDb();
  const rows = db
    .select()
    .from(actorTokenRecords)
    .where(
      and(
        eq(actorTokenRecords.assistantId, assistantId),
        eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorTokenRecords.status, 'active'),
      ),
    )
    .all();

  return rows.map(rowToRecord);
}

/**
 * Revoke a single token by its hash.
 */
export function revokeByTokenHash(tokenHash: string): boolean {
  const db = getDb();
  const now = Date.now();

  const result = db
    .update(actorTokenRecords)
    .set({ status: 'revoked', updatedAt: now })
    .where(
      and(
        eq(actorTokenRecords.tokenHash, tokenHash),
        eq(actorTokenRecords.status, 'active'),
      ),
    )
    .run();

  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRecord(row: typeof actorTokenRecords.$inferSelect): ActorTokenRecord {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    assistantId: row.assistantId,
    guardianPrincipalId: row.guardianPrincipalId,
    hashedDeviceId: row.hashedDeviceId,
    platform: row.platform,
    status: row.status as ActorTokenStatus,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

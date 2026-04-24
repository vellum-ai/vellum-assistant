/**
 * Hash-only actor token persistence.
 *
 * Stores only the SHA-256 hash of each actor token alongside metadata
 * (assistantId, guardianPrincipalId, deviceId hash, platform, status).
 * The raw token plaintext is never stored.
 *
 * Uses the assistant SQLite database via drizzle-orm.
 */

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db.js";
import { actorTokenRecords } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("actor-token-store");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActorTokenStatus = "active" | "revoked";

export interface ActorTokenRecord {
  id: string;
  tokenHash: string;
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
    guardianPrincipalId: params.guardianPrincipalId,
    hashedDeviceId: params.hashedDeviceId,
    platform: params.platform,
    status: "active" as const,
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(actorTokenRecords).values(row).run();
  log.info({ id, platform: params.platform }, "Actor token record created");

  return row;
}

/**
 * Revoke all active tokens for a given device binding.
 * Called before minting a new token to ensure one-active-per-device.
 */
export function revokeByDeviceBinding(
  guardianPrincipalId: string,
  hashedDeviceId: string,
): number {
  const db = getDb();
  const now = Date.now();

  const condition = and(
    eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
    eq(actorTokenRecords.hashedDeviceId, hashedDeviceId),
    eq(actorTokenRecords.status, "active"),
  );

  // Count matching rows before the update since drizzle's bun-sqlite
  // .run() does not expose the underlying changes count in its types.
  const matching = db
    .select({ id: actorTokenRecords.id })
    .from(actorTokenRecords)
    .where(condition)
    .all();

  if (matching.length === 0) return 0;

  db.update(actorTokenRecords)
    .set({ status: "revoked", updatedAt: now })
    .where(condition)
    .run();

  return matching.length;
}



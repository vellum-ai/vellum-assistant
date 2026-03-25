/**
 * CRUD operations for the a2a_pairing_requests table.
 *
 * Manages pairing handshake state for both the initiator ("outbound")
 * and target ("inbound") sides of the A2A pairing protocol.
 */

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../../memory/db.js";
import { a2aPairingRequests } from "../../memory/schema.js";

export type PairingDirection = "outbound" | "inbound";
export type PairingStatus = "pending" | "accepted" | "expired" | "failed";

export interface PairingRequest {
  id: string;
  direction: PairingDirection;
  inviteCode: string;
  remoteAssistantId: string;
  remoteGatewayUrl: string;
  status: PairingStatus;
  createdAt: number;
  expiresAt: number;
}

function parseRow(row: typeof a2aPairingRequests.$inferSelect): PairingRequest {
  return {
    id: row.id,
    direction: row.direction as PairingDirection,
    inviteCode: row.inviteCode,
    remoteAssistantId: row.remoteAssistantId,
    remoteGatewayUrl: row.remoteGatewayUrl,
    status: row.status as PairingStatus,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** Default pairing request TTL: 1 hour. */
export const PAIRING_REQUEST_TTL_MS = 60 * 60 * 1000;

/**
 * Create a new pairing request. If a pending request already exists for
 * the same (direction, remoteAssistantId), it is replaced (idempotent
 * re-initiation).
 */
export function createPairingRequest(
  direction: PairingDirection,
  inviteCode: string,
  remoteAssistantId: string,
  remoteGatewayUrl: string,
  expiresAt: number,
): PairingRequest {
  const db = getDb();
  const now = Date.now();

  // Replace any existing pending request for the same remote assistant + direction
  const existing = db
    .select()
    .from(a2aPairingRequests)
    .where(
      and(
        eq(a2aPairingRequests.direction, direction),
        eq(a2aPairingRequests.remoteAssistantId, remoteAssistantId),
        eq(a2aPairingRequests.status, "pending"),
      ),
    )
    .get();

  if (existing) {
    db.delete(a2aPairingRequests)
      .where(eq(a2aPairingRequests.id, existing.id))
      .run();
  }

  const id = uuid();
  db.insert(a2aPairingRequests)
    .values({
      id,
      direction,
      inviteCode,
      remoteAssistantId,
      remoteGatewayUrl,
      status: "pending",
      createdAt: now,
      expiresAt,
    })
    .run();

  return {
    id,
    direction,
    inviteCode,
    remoteAssistantId,
    remoteGatewayUrl,
    status: "pending",
    createdAt: now,
    expiresAt,
  };
}

/**
 * Find a pairing request by invite code. Returns null if not found or expired.
 */
export function findPairingByInviteCode(
  inviteCode: string,
): PairingRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(a2aPairingRequests)
    .where(eq(a2aPairingRequests.inviteCode, inviteCode))
    .get();

  if (!row) return null;

  const parsed = parseRow(row);

  // Auto-expire stale requests
  if (parsed.status === "pending" && Date.now() > parsed.expiresAt) {
    updatePairingStatus(parsed.id, "expired");
    return null;
  }

  return parsed;
}

/**
 * Find a pairing request by remote assistant ID and direction.
 * Returns the most recent matching request, or null if none found.
 */
export function findPairingByRemoteAssistant(
  remoteAssistantId: string,
  direction: PairingDirection,
): PairingRequest | null {
  const db = getDb();
  const row = db
    .select()
    .from(a2aPairingRequests)
    .where(
      and(
        eq(a2aPairingRequests.remoteAssistantId, remoteAssistantId),
        eq(a2aPairingRequests.direction, direction),
      ),
    )
    .get();

  if (!row) return null;

  const parsed = parseRow(row);

  // Auto-expire stale requests
  if (parsed.status === "pending" && Date.now() > parsed.expiresAt) {
    updatePairingStatus(parsed.id, "expired");
    return { ...parsed, status: "expired" };
  }

  return parsed;
}

/**
 * Update the status of a pairing request.
 */
export function updatePairingStatus(id: string, status: PairingStatus): void {
  const db = getDb();
  db.update(a2aPairingRequests)
    .set({ status })
    .where(eq(a2aPairingRequests.id, id))
    .run();
}

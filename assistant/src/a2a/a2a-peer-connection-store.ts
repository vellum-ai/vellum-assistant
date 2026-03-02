/**
 * CRUD store for A2A peer connections.
 *
 * Each connection represents a bidirectional link between this assistant and a
 * peer assistant. Stores credential hashes (never raw credentials), the peer's
 * gateway URL, protocol version, negotiated capabilities, and granted scopes.
 */

import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { DAEMON_INTERNAL_ASSISTANT_ID } from '../runtime/assistant-scope.js';
import { getDb } from '../memory/db.js';
import { rawChanges } from '../memory/raw-query.js';
import { a2aPeerConnections } from '../memory/schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type A2APeerConnectionStatus =
  | 'pending'
  | 'active'
  | 'revoked'
  | 'revoked_by_peer'
  | 'revocation_pending'
  | 'expired';

export interface A2APeerConnection {
  id: string;
  assistantId: string;
  peerAssistantId: string | null;
  peerGatewayUrl: string;
  peerDisplayName: string | null;
  inviteId: string | null;
  status: A2APeerConnectionStatus;
  protocolVersion: string | null;
  capabilities: string[];
  scopes: string[];
  outboundCredentialHash: string | null;
  inboundCredentialHash: string | null;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToConnection(row: typeof a2aPeerConnections.$inferSelect): A2APeerConnection {
  return {
    id: row.id,
    assistantId: row.assistantId,
    peerAssistantId: row.peerAssistantId,
    peerGatewayUrl: row.peerGatewayUrl,
    peerDisplayName: row.peerDisplayName,
    inviteId: row.inviteId,
    status: row.status as A2APeerConnectionStatus,
    protocolVersion: row.protocolVersion,
    capabilities: JSON.parse(row.capabilities) as string[],
    scopes: JSON.parse(row.scopes) as string[],
    outboundCredentialHash: row.outboundCredentialHash,
    inboundCredentialHash: row.inboundCredentialHash,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    expiresAt: row.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// createConnection
// ---------------------------------------------------------------------------

export function createConnection(params: {
  peerGatewayUrl: string;
  peerAssistantId?: string;
  peerDisplayName?: string;
  inviteId?: string;
  status?: A2APeerConnectionStatus;
  protocolVersion?: string;
  capabilities?: string[];
  scopes?: string[];
  outboundCredentialHash?: string;
  inboundCredentialHash?: string;
  expiresAt?: number;
}): A2APeerConnection {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();

  const row = {
    id,
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    peerAssistantId: params.peerAssistantId ?? null,
    peerGatewayUrl: params.peerGatewayUrl,
    peerDisplayName: params.peerDisplayName ?? null,
    inviteId: params.inviteId ?? null,
    status: params.status ?? ('pending' as const),
    protocolVersion: params.protocolVersion ?? null,
    capabilities: JSON.stringify(params.capabilities ?? []),
    scopes: JSON.stringify(params.scopes ?? []),
    outboundCredentialHash: params.outboundCredentialHash ?? null,
    inboundCredentialHash: params.inboundCredentialHash ?? null,
    lastSeenAt: null,
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
    revokedReason: null,
    expiresAt: params.expiresAt ?? null,
  };

  db.insert(a2aPeerConnections).values(row).run();

  return rowToConnection(row);
}

// ---------------------------------------------------------------------------
// getConnection
// ---------------------------------------------------------------------------

export function getConnection(connectionId: string): A2APeerConnection | null {
  const db = getDb();

  const row = db
    .select()
    .from(a2aPeerConnections)
    .where(eq(a2aPeerConnections.id, connectionId))
    .get();

  return row ? rowToConnection(row) : null;
}

// ---------------------------------------------------------------------------
// getConnectionByPeerAssistantId
// ---------------------------------------------------------------------------

export function getConnectionByPeerAssistantId(peerAssistantId: string): A2APeerConnection | null {
  const db = getDb();

  const row = db
    .select()
    .from(a2aPeerConnections)
    .where(
      and(
        eq(a2aPeerConnections.assistantId, DAEMON_INTERNAL_ASSISTANT_ID),
        eq(a2aPeerConnections.peerAssistantId, peerAssistantId),
      ),
    )
    .orderBy(desc(a2aPeerConnections.updatedAt))
    .get();

  return row ? rowToConnection(row) : null;
}

// ---------------------------------------------------------------------------
// listConnections
// ---------------------------------------------------------------------------

export function listConnections(filters?: {
  status?: A2APeerConnectionStatus;
  limit?: number;
  offset?: number;
}): A2APeerConnection[] {
  const db = getDb();

  const conditions = [eq(a2aPeerConnections.assistantId, DAEMON_INTERNAL_ASSISTANT_ID)];

  if (filters?.status) {
    conditions.push(eq(a2aPeerConnections.status, filters.status));
  }

  const rows = db
    .select()
    .from(a2aPeerConnections)
    .where(and(...conditions))
    .orderBy(desc(a2aPeerConnections.createdAt))
    .limit(filters?.limit ?? 100)
    .offset(filters?.offset ?? 0)
    .all();

  return rows.map(rowToConnection);
}

// ---------------------------------------------------------------------------
// updateConnectionStatus (CAS-style)
// ---------------------------------------------------------------------------

/**
 * Atomically transition a connection's status. When `expectedCurrentStatus` is
 * provided, the update only applies if the current status matches (CAS). Returns
 * the updated connection, or `null` if the connection was not found or the CAS
 * check failed.
 */
export function updateConnectionStatus(
  connectionId: string,
  newStatus: A2APeerConnectionStatus,
  expectedCurrentStatus?: A2APeerConnectionStatus,
): A2APeerConnection | null {
  const db = getDb();
  const now = Date.now();

  const conditions = [eq(a2aPeerConnections.id, connectionId)];
  if (expectedCurrentStatus) {
    conditions.push(eq(a2aPeerConnections.status, expectedCurrentStatus));
  }

  const setFields: Record<string, unknown> = {
    status: newStatus,
    updatedAt: now,
  };

  // Auto-populate revokedAt for revocation statuses
  if (newStatus === 'revoked' || newStatus === 'revoked_by_peer') {
    setFields.revokedAt = now;
  }

  db.update(a2aPeerConnections)
    .set(setFields)
    .where(and(...conditions))
    .run();

  // Use affected-row count to determine if the conditional update applied.
  // This is reliable even at millisecond precision, unlike timestamp comparison.
  if (rawChanges() === 0) return null;

  const updated = db
    .select()
    .from(a2aPeerConnections)
    .where(eq(a2aPeerConnections.id, connectionId))
    .get();

  return updated ? rowToConnection(updated) : null;
}

// ---------------------------------------------------------------------------
// updateConnectionScopes
// ---------------------------------------------------------------------------

export function updateConnectionScopes(
  connectionId: string,
  scopes: string[],
): A2APeerConnection | null {
  const db = getDb();
  const now = Date.now();

  db.update(a2aPeerConnections)
    .set({
      scopes: JSON.stringify(scopes),
      updatedAt: now,
    })
    .where(eq(a2aPeerConnections.id, connectionId))
    .run();

  const updated = db
    .select()
    .from(a2aPeerConnections)
    .where(eq(a2aPeerConnections.id, connectionId))
    .get();

  return updated ? rowToConnection(updated) : null;
}

// ---------------------------------------------------------------------------
// updateConnectionCredentials
// ---------------------------------------------------------------------------

export function updateConnectionCredentials(
  connectionId: string,
  credentials: {
    outboundCredentialHash?: string;
    inboundCredentialHash?: string;
  },
): A2APeerConnection | null {
  const db = getDb();
  const now = Date.now();

  const setFields: Record<string, unknown> = { updatedAt: now };

  if (credentials.outboundCredentialHash !== undefined) {
    setFields.outboundCredentialHash = credentials.outboundCredentialHash;
  }
  if (credentials.inboundCredentialHash !== undefined) {
    setFields.inboundCredentialHash = credentials.inboundCredentialHash;
  }

  db.update(a2aPeerConnections)
    .set(setFields)
    .where(eq(a2aPeerConnections.id, connectionId))
    .run();

  const updated = db
    .select()
    .from(a2aPeerConnections)
    .where(eq(a2aPeerConnections.id, connectionId))
    .get();

  return updated ? rowToConnection(updated) : null;
}

// ---------------------------------------------------------------------------
// deleteConnection
// ---------------------------------------------------------------------------

/**
 * Hard-delete a connection record. Returns `true` if a row was deleted,
 * `false` if the connection did not exist.
 */
export function deleteConnection(connectionId: string): boolean {
  const db = getDb();

  db.delete(a2aPeerConnections)
    .where(eq(a2aPeerConnections.id, connectionId))
    .run();

  return rawChanges() > 0;
}

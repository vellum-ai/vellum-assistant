import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-peer-connection-store-test-'));

mock.module('../../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

mock.module('../../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createConnection,
  deleteConnection,
  getConnection,
  getConnectionByPeerAssistantId,
  listConnections,
  updateConnectionCredentials,
  updateConnectionStatus,
} from '../a2a-peer-connection-store.js';
import { getDb, initializeDb, resetDb } from '../../memory/db.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
}

describe('a2a-peer-connection-store', () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ── Table creation (migration idempotency) ──────────────────────────

  test('table exists after initializeDb', () => {
    const db = getDb();
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='a2a_peer_connections'",
    );
    expect(tables).toHaveLength(1);
  });

  test('migration is idempotent (re-running initializeDb does not throw)', () => {
    expect(() => initializeDb()).not.toThrow();
  });

  // ── createConnection ────────────────────────────────────────────────

  test('creates a connection with all fields populated', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com/gateway',
      peerAssistantId: 'peer-assistant-1',
      peerDisplayName: 'Peer One',
      inviteId: 'invite-123',
      status: 'pending',
      protocolVersion: '1.0.0',
      capabilities: ['scheduling:read', 'messaging:relay'],
      outboundCredentialHash: 'hash-outbound-abc',
      inboundCredentialHash: 'hash-inbound-xyz',
      expiresAt: Date.now() + 86_400_000,
    });

    expect(conn.id).toBeTruthy();
    expect(conn.assistantId).toBe('self');
    expect(conn.peerAssistantId).toBe('peer-assistant-1');
    expect(conn.peerGatewayUrl).toBe('https://peer.example.com/gateway');
    expect(conn.peerDisplayName).toBe('Peer One');
    expect(conn.inviteId).toBe('invite-123');
    expect(conn.status).toBe('pending');
    expect(conn.protocolVersion).toBe('1.0.0');
    expect(conn.capabilities).toEqual(['scheduling:read', 'messaging:relay']);
    expect(conn.outboundCredentialHash).toBe('hash-outbound-abc');
    expect(conn.inboundCredentialHash).toBe('hash-inbound-xyz');
    expect(conn.createdAt).toBeGreaterThan(0);
    expect(conn.updatedAt).toBeGreaterThan(0);
    expect(conn.revokedAt).toBeNull();
    expect(conn.revokedReason).toBeNull();
    expect(conn.expiresAt).toBeGreaterThan(0);
  });

  test('creates a connection with minimal fields', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com/gateway',
    });

    expect(conn.id).toBeTruthy();
    expect(conn.peerAssistantId).toBeNull();
    expect(conn.peerDisplayName).toBeNull();
    expect(conn.inviteId).toBeNull();
    expect(conn.status).toBe('pending');
    expect(conn.protocolVersion).toBeNull();
    expect(conn.capabilities).toEqual([]);
    expect(conn.outboundCredentialHash).toBeNull();
    expect(conn.inboundCredentialHash).toBeNull();
    expect(conn.expiresAt).toBeNull();
  });

  test('each created connection has a unique ID', () => {
    const conn1 = createConnection({ peerGatewayUrl: 'https://a.example.com' });
    const conn2 = createConnection({ peerGatewayUrl: 'https://b.example.com' });

    expect(conn1.id).not.toBe(conn2.id);
  });

  // ── getConnection ───────────────────────────────────────────────────

  test('gets a connection by ID', () => {
    const created = createConnection({
      peerGatewayUrl: 'https://peer.example.com/gateway',
      peerDisplayName: 'My Peer',
    });

    const fetched = getConnection(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.peerGatewayUrl).toBe('https://peer.example.com/gateway');
    expect(fetched!.peerDisplayName).toBe('My Peer');
  });

  test('returns null for nonexistent ID', () => {
    const fetched = getConnection('nonexistent');
    expect(fetched).toBeNull();
  });

  // ── getConnectionByPeerAssistantId ──────────────────────────────────

  test('looks up connection by peer assistant ID', () => {
    createConnection({
      peerGatewayUrl: 'https://peer-a.example.com',
      peerAssistantId: 'peer-a',
    });
    createConnection({
      peerGatewayUrl: 'https://peer-b.example.com',
      peerAssistantId: 'peer-b',
    });

    const found = getConnectionByPeerAssistantId('peer-b');
    expect(found).not.toBeNull();
    expect(found!.peerAssistantId).toBe('peer-b');
    expect(found!.peerGatewayUrl).toBe('https://peer-b.example.com');
  });

  test('returns null for nonexistent peer assistant ID', () => {
    const found = getConnectionByPeerAssistantId('nonexistent');
    expect(found).toBeNull();
  });

  // ── listConnections ─────────────────────────────────────────────────

  test('lists all connections with no filters', () => {
    createConnection({ peerGatewayUrl: 'https://a.example.com' });
    createConnection({ peerGatewayUrl: 'https://b.example.com' });
    createConnection({ peerGatewayUrl: 'https://c.example.com' });

    const all = listConnections();
    expect(all).toHaveLength(3);
  });

  test('filters by status', () => {
    createConnection({ peerGatewayUrl: 'https://a.example.com', status: 'pending' });
    createConnection({ peerGatewayUrl: 'https://b.example.com', status: 'active' });
    createConnection({ peerGatewayUrl: 'https://c.example.com', status: 'active' });

    const active = listConnections({ status: 'active' });
    expect(active).toHaveLength(2);

    const pending = listConnections({ status: 'pending' });
    expect(pending).toHaveLength(1);

    const revoked = listConnections({ status: 'revoked' });
    expect(revoked).toHaveLength(0);
  });

  test('returns empty array when no connections exist', () => {
    const result = listConnections();
    expect(result).toHaveLength(0);
  });

  test('respects limit and offset', () => {
    createConnection({ peerGatewayUrl: 'https://a.example.com' });
    createConnection({ peerGatewayUrl: 'https://b.example.com' });
    createConnection({ peerGatewayUrl: 'https://c.example.com' });

    const first = listConnections({ limit: 1 });
    expect(first).toHaveLength(1);

    const second = listConnections({ limit: 1, offset: 1 });
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe(first[0].id);
  });

  // ── updateConnectionStatus (CAS) ───────────────────────────────────

  test('updates status without CAS (no expected status)', () => {
    const conn = createConnection({ peerGatewayUrl: 'https://a.example.com' });

    const updated = updateConnectionStatus(conn.id, 'active');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('active');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(conn.updatedAt);
  });

  test('CAS succeeds when expected status matches', () => {
    const conn = createConnection({ peerGatewayUrl: 'https://a.example.com' });

    const updated = updateConnectionStatus(conn.id, 'active', 'pending');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('active');
  });

  test('CAS fails when expected status does not match', () => {
    const conn = createConnection({ peerGatewayUrl: 'https://a.example.com' });

    // Try to transition from 'active' but it's currently 'pending'
    const result = updateConnectionStatus(conn.id, 'revoked', 'active');
    expect(result).toBeNull();

    // Verify the connection is unchanged
    const unchanged = getConnection(conn.id);
    expect(unchanged!.status).toBe('pending');
  });

  test('CAS race condition: two concurrent transitions, only one succeeds', () => {
    const conn = createConnection({ peerGatewayUrl: 'https://a.example.com' });

    // First transition succeeds: pending -> active
    const first = updateConnectionStatus(conn.id, 'active', 'pending');
    expect(first).not.toBeNull();
    expect(first!.status).toBe('active');

    // Second transition fails: also tries pending -> revoked, but status is now 'active'
    const second = updateConnectionStatus(conn.id, 'revoked', 'pending');
    expect(second).toBeNull();

    // Verify the first transition stuck
    const final = getConnection(conn.id);
    expect(final!.status).toBe('active');
  });

  test('returns null for nonexistent connection', () => {
    const result = updateConnectionStatus('nonexistent', 'active');
    expect(result).toBeNull();
  });

  test('auto-populates revokedAt when revoking', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://a.example.com',
      status: 'active',
    });

    const revoked = updateConnectionStatus(conn.id, 'revoked', 'active');
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe('revoked');
    expect(revoked!.revokedAt).not.toBeNull();
    expect(revoked!.revokedAt).toBeGreaterThan(0);
  });

  test('auto-populates revokedAt for revoked_by_peer status', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://a.example.com',
      status: 'active',
    });

    const revoked = updateConnectionStatus(conn.id, 'revoked_by_peer', 'active');
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe('revoked_by_peer');
    expect(revoked!.revokedAt).not.toBeNull();
  });

  // ── Full status lifecycle ──────────────────────────────────────────

  test('full lifecycle: pending -> active -> revoked', () => {
    const conn = createConnection({ peerGatewayUrl: 'https://a.example.com' });
    expect(conn.status).toBe('pending');

    const activated = updateConnectionStatus(conn.id, 'active', 'pending');
    expect(activated).not.toBeNull();
    expect(activated!.status).toBe('active');

    const revoked = updateConnectionStatus(activated!.id, 'revoked', 'active');
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe('revoked');
    expect(revoked!.revokedAt).not.toBeNull();
  });

  // ── updateConnectionCredentials ────────────────────────────────────

  test('rotates outbound credential', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://a.example.com',
      outboundCredentialHash: 'old-hash',
    });

    const updated = updateConnectionCredentials(conn.id, {
      outboundCredentialHash: 'new-hash',
    });

    expect(updated).not.toBeNull();
    expect(updated!.outboundCredentialHash).toBe('new-hash');
    // Inbound should remain unchanged
    expect(updated!.inboundCredentialHash).toBeNull();
  });

  test('rotates inbound credential', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://a.example.com',
      inboundCredentialHash: 'old-inbound',
    });

    const updated = updateConnectionCredentials(conn.id, {
      inboundCredentialHash: 'new-inbound',
    });

    expect(updated).not.toBeNull();
    expect(updated!.inboundCredentialHash).toBe('new-inbound');
  });

  test('rotates both credentials at once', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://a.example.com',
      outboundCredentialHash: 'old-out',
      inboundCredentialHash: 'old-in',
    });

    const updated = updateConnectionCredentials(conn.id, {
      outboundCredentialHash: 'new-out',
      inboundCredentialHash: 'new-in',
    });

    expect(updated).not.toBeNull();
    expect(updated!.outboundCredentialHash).toBe('new-out');
    expect(updated!.inboundCredentialHash).toBe('new-in');
  });

  test('returns null for nonexistent connection', () => {
    const updated = updateConnectionCredentials('nonexistent', {
      outboundCredentialHash: 'hash',
    });
    expect(updated).toBeNull();
  });

  // ── deleteConnection ───────────────────────────────────────────────

  test('deletes an existing connection', () => {
    const conn = createConnection({ peerGatewayUrl: 'https://a.example.com' });

    const deleted = deleteConnection(conn.id);
    expect(deleted).toBe(true);

    const fetched = getConnection(conn.id);
    expect(fetched).toBeNull();
  });

  test('returns false for nonexistent connection', () => {
    const deleted = deleteConnection('nonexistent');
    expect(deleted).toBe(false);
  });

  test('deleted connection no longer appears in list', () => {
    const conn = createConnection({ peerGatewayUrl: 'https://a.example.com' });
    createConnection({ peerGatewayUrl: 'https://b.example.com' });

    expect(listConnections()).toHaveLength(2);

    deleteConnection(conn.id);

    expect(listConnections()).toHaveLength(1);
  });

  // ── JSON field round-trip ──────────────────────────────────────────

  test('capabilities round-trip through JSON correctly', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://a.example.com',
      capabilities: ['scheduling:read', 'messaging:relay', 'preferences:read'],
    });

    const fetched = getConnection(conn.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.capabilities).toEqual(['scheduling:read', 'messaging:relay', 'preferences:read']);
  });

  test('empty arrays round-trip correctly', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://a.example.com',
      capabilities: [],
    });

    const fetched = getConnection(conn.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.capabilities).toEqual([]);
  });
});

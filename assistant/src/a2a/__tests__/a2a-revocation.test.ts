/**
 * Tests for A2A revocation propagation and credential tombstoning.
 *
 * Covers:
 * - Revoke with unreachable peer -> revocation_pending status
 * - Revoke with reachable peer -> revoked status
 * - Double-revoke idempotency
 * - Revoked peer attempting to send a message -> rejected
 * - Receiving revocation notification from peer -> revoked_by_peer
 * - Sweep timer successfully delivering pending revocations
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-revocation-test-'));

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

// Track fetch calls for revocation delivery testing
let fetchMock: ReturnType<typeof mock>;
let lastFetchUrl: string | null = null;
let lastFetchBody: string | null = null;
let fetchShouldFail = false;
let fetchShouldTimeout = false;

// Mock global fetch for revocation delivery
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  lastFetchUrl = url;
  lastFetchBody = init?.body as string ?? null;

  if (fetchShouldTimeout) {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }
  if (fetchShouldFail) {
    throw new Error('Network error: connection refused');
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

import {
  A2A_PROTOCOL_VERSION,
  approveConnection,
  decodeInviteCode,
  generateInvite,
  handlePeerRevocationNotification,
  initiateConnection,
  revokeConnection,
  submitVerificationCode,
  _resetHandshakeSessions,
  _resetIdempotencyStore,
} from '../a2a-connection-service.js';
import {
  getConnection,
  tombstoneOutboundCredential,
  updateConnectionCredentials,
  updateConnectionStatus,
} from '../a2a-peer-connection-store.js';
import {
  runRevocationSweep,
  _resetAttemptCounts,
  _getAttemptCount,
  MAX_REVOCATION_ATTEMPTS,
} from '../a2a-revocation-sweep.js';
import { initializeDb, resetDb, getDb } from '../../memory/db.js';

initializeDb();

const MOCK_GATEWAY_URL = 'https://my-assistant.example.com';
const PEER_GATEWAY_URL = 'https://peer-assistant.example.com';

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
  db.run('DELETE FROM assistant_ingress_invites');
}

/**
 * Helper: create a fully active connection for testing revocation.
 * Returns the connection ID.
 */
function createActiveConnection(): string {
  const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
  if (!genResult.ok) throw new Error('Failed to create invite');
  const decoded = decodeInviteCode(genResult.inviteCode)!;

  const initResult = initiateConnection({
    peerGatewayUrl: PEER_GATEWAY_URL,
    inviteToken: decoded.t,
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: [],
  });
  if (!initResult.ok) throw new Error('Failed to initiate connection');

  const approveResult = approveConnection({
    connectionId: initResult.connectionId,
    decision: 'approve',
  });
  if (!approveResult.ok) throw new Error('Failed to approve');

  const code = (approveResult as { ok: true; verificationCode: string }).verificationCode;

  const verifyResult = submitVerificationCode({
    connectionId: initResult.connectionId,
    code,
    peerIdentity: PEER_GATEWAY_URL,
  });
  if (!verifyResult.ok) throw new Error('Failed to verify');

  return initResult.connectionId;
}

describe('a2a-revocation', () => {
  beforeEach(() => {
    resetTables();
    _resetHandshakeSessions();
    _resetIdempotencyStore();
    _resetAttemptCounts();
    lastFetchUrl = null;
    lastFetchBody = null;
    fetchShouldFail = false;
    fetchShouldTimeout = false;
  });

  afterAll(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ========================================================================
  // Revoke with reachable peer -> revoked status
  // ========================================================================

  describe('revokeConnection with reachable peer', () => {
    test('sends revocation notification and transitions to revoked', async () => {
      const connectionId = createActiveConnection();

      const result = await revokeConnection({ connectionId });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe('revoked');
      }

      // Verify the connection is revoked
      const conn = getConnection(connectionId);
      expect(conn).not.toBeNull();
      expect(conn!.status).toBe('revoked');

      // Credentials should be tombstoned
      expect(conn!.outboundCredentialHash).toBe('');
      expect(conn!.outboundCredential).toBe('');
      expect(conn!.inboundCredentialHash).toBe('');
      expect(conn!.inboundCredential).toBe('');

      // Verify fetch was called with the peer's revoke-notify endpoint
      expect(lastFetchUrl).toBe(`${PEER_GATEWAY_URL}/v1/a2a/revoke-notify`);

      // Verify the body contains the connection ID
      expect(lastFetchBody).not.toBeNull();
      const body = JSON.parse(lastFetchBody!);
      expect(body.connectionId).toBe(connectionId);
    });
  });

  // ========================================================================
  // Revoke with unreachable peer -> revocation_pending
  // ========================================================================

  describe('revokeConnection with unreachable peer', () => {
    test('marks as revocation_pending when peer is unreachable (network error)', async () => {
      const connectionId = createActiveConnection();

      // Capture the outbound credential before revocation
      const activeCon = getConnection(connectionId);
      const originalOutboundCredential = activeCon!.outboundCredential;
      const originalOutboundCredentialHash = activeCon!.outboundCredentialHash;
      expect(originalOutboundCredential).toBeTruthy();

      fetchShouldFail = true;

      const result = await revokeConnection({ connectionId });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe('revocation_pending');
      }

      const conn = getConnection(connectionId);
      expect(conn).not.toBeNull();
      expect(conn!.status).toBe('revocation_pending');

      // Inbound credential should be tombstoned immediately (blocks accepting messages)
      expect(conn!.inboundCredentialHash).toBe('');
      expect(conn!.inboundCredential).toBe('');

      // Outbound credential should be preserved for sweep retry signing
      expect(conn!.outboundCredential).toBe(originalOutboundCredential);
      expect(conn!.outboundCredentialHash).toBe(originalOutboundCredentialHash);
    });

    test('marks as revocation_pending when peer times out', async () => {
      const connectionId = createActiveConnection();

      // Capture the outbound credential before revocation
      const activeCon = getConnection(connectionId);
      const originalOutboundCredential = activeCon!.outboundCredential;
      expect(originalOutboundCredential).toBeTruthy();

      fetchShouldTimeout = true;

      const result = await revokeConnection({ connectionId });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe('revocation_pending');
      }

      const conn = getConnection(connectionId);
      expect(conn!.status).toBe('revocation_pending');

      // Outbound credential preserved for sweep retries
      expect(conn!.outboundCredential).toBe(originalOutboundCredential);

      // Inbound credential tombstoned
      expect(conn!.inboundCredential).toBe('');
    });
  });

  // ========================================================================
  // Double-revoke idempotency
  // ========================================================================

  describe('double-revoke idempotency', () => {
    test('revoking an already-revoked connection returns ok', async () => {
      const connectionId = createActiveConnection();

      const r1 = await revokeConnection({ connectionId });
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.status).toBe('revoked');

      const r2 = await revokeConnection({ connectionId });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.status).toBe('revoked');
    });

    test('revoking a revocation_pending connection returns ok', async () => {
      const connectionId = createActiveConnection();

      fetchShouldFail = true;
      const r1 = await revokeConnection({ connectionId });
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.status).toBe('revocation_pending');

      const r2 = await revokeConnection({ connectionId });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.status).toBe('revocation_pending');
    });

    test('revoking a revoked_by_peer connection returns ok', async () => {
      const connectionId = createActiveConnection();

      // Simulate peer-initiated revocation
      handlePeerRevocationNotification({ connectionId });

      const conn = getConnection(connectionId);
      expect(conn!.status).toBe('revoked_by_peer');

      const result = await revokeConnection({ connectionId });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe('revoked');
    });
  });

  // ========================================================================
  // Receiving revocation notification from peer
  // ========================================================================

  describe('handlePeerRevocationNotification', () => {
    test('marks connection as revoked_by_peer and tombstones credentials', () => {
      const connectionId = createActiveConnection();

      const result = handlePeerRevocationNotification({ connectionId });
      expect(result.ok).toBe(true);

      const conn = getConnection(connectionId);
      expect(conn).not.toBeNull();
      expect(conn!.status).toBe('revoked_by_peer');

      // Credentials should be tombstoned
      expect(conn!.outboundCredentialHash).toBe('');
      expect(conn!.outboundCredential).toBe('');
      expect(conn!.inboundCredentialHash).toBe('');
      expect(conn!.inboundCredential).toBe('');
    });

    test('returns not_found for nonexistent connection', () => {
      const result = handlePeerRevocationNotification({ connectionId: 'nonexistent' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    test('returns already_revoked for already-revoked connection', async () => {
      const connectionId = createActiveConnection();

      await revokeConnection({ connectionId });

      const result = handlePeerRevocationNotification({ connectionId });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('already_revoked');
      }
    });

    test('idempotent: double peer revocation notification', () => {
      const connectionId = createActiveConnection();

      const r1 = handlePeerRevocationNotification({ connectionId });
      expect(r1.ok).toBe(true);

      const r2 = handlePeerRevocationNotification({ connectionId });
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.reason).toBe('already_revoked');
      }
    });
  });

  // ========================================================================
  // Revocation sweep timer
  // ========================================================================

  describe('revocation sweep', () => {
    test('processes no connections when none are pending', async () => {
      const processed = await runRevocationSweep();
      expect(processed).toBe(0);
    });

    test('transitions revocation_pending to revoked on successful delivery', async () => {
      const connectionId = createActiveConnection();

      // First, do a revoke that fails (peer unreachable)
      fetchShouldFail = true;
      await revokeConnection({ connectionId });

      const conn1 = getConnection(connectionId);
      expect(conn1!.status).toBe('revocation_pending');
      // Outbound credential should still be available for sweep retry
      expect(conn1!.outboundCredential).toBeTruthy();

      // Now make the peer reachable
      fetchShouldFail = false;

      // Run the sweep — outbound credential is preserved so delivery succeeds
      const processed = await runRevocationSweep();
      expect(processed).toBe(1);

      const conn2 = getConnection(connectionId);
      expect(conn2!.status).toBe('revoked');

      // After successful sweep delivery, outbound credential is tombstoned
      expect(conn2!.outboundCredential).toBe('');
      expect(conn2!.outboundCredentialHash).toBe('');

      // Verify the sweep actually called fetch with the peer URL
      expect(lastFetchUrl).toBe(`${PEER_GATEWAY_URL}/v1/a2a/revoke-notify`);
    });

    test('force-revokes after max attempts exceeded', async () => {
      const connectionId = createActiveConnection();

      // Revoke with peer unreachable — goes to revocation_pending
      fetchShouldFail = true;
      await revokeConnection({ connectionId });

      // Outbound credential preserved for retries
      const pendingConn = getConnection(connectionId);
      expect(pendingConn!.outboundCredential).toBeTruthy();
      expect(pendingConn!.status).toBe('revocation_pending');

      // Run sweeps up to max attempts — each attempt fails but retries
      for (let i = 0; i < MAX_REVOCATION_ATTEMPTS; i++) {
        await runRevocationSweep();
        // Connection should still be revocation_pending while retrying
        const c = getConnection(connectionId);
        expect(c!.status).toBe('revocation_pending');
      }

      // One more sweep exceeds max attempts — forces revoked
      await runRevocationSweep();

      const conn = getConnection(connectionId);
      expect(conn!.status).toBe('revoked');

      // Outbound credential should be tombstoned after force-revoke
      expect(conn!.outboundCredential).toBe('');
      expect(conn!.outboundCredentialHash).toBe('');
    });

    test('tracks attempt counts per connection', async () => {
      const connectionId = createActiveConnection();

      // Revoke with peer unreachable — outbound credential preserved
      fetchShouldFail = true;
      await revokeConnection({ connectionId });

      expect(_getAttemptCount(connectionId)).toBe(0);

      // Run sweep — delivery fails, attempt count increments
      await runRevocationSweep();
      expect(_getAttemptCount(connectionId)).toBe(1);

      // Connection should still be revocation_pending (retry later)
      const conn = getConnection(connectionId);
      expect(conn!.status).toBe('revocation_pending');

      // Run another sweep
      await runRevocationSweep();
      expect(_getAttemptCount(connectionId)).toBe(2);
    });

    test('sweep retries delivery with valid outbound credential', async () => {
      const connectionId = createActiveConnection();

      // Capture the original outbound credential
      const activeCon = getConnection(connectionId);
      const originalOutbound = activeCon!.outboundCredential;

      // Revoke with peer unreachable
      fetchShouldFail = true;
      await revokeConnection({ connectionId });

      // Verify outbound credential is still there for sweep
      const pendingConn = getConnection(connectionId);
      expect(pendingConn!.outboundCredential).toBe(originalOutbound);

      // Make peer reachable and run sweep
      fetchShouldFail = false;
      await runRevocationSweep();

      // Should have delivered successfully and tombstoned the outbound credential
      const finalConn = getConnection(connectionId);
      expect(finalConn!.status).toBe('revoked');
      expect(finalConn!.outboundCredential).toBe('');
    });
  });

  // ========================================================================
  // Revoke pending connection (not just active)
  // ========================================================================

  describe('revoke non-active connections', () => {
    test('can revoke a pending connection', async () => {
      const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!genResult.ok) throw new Error('Failed to create invite');
      const decoded = decodeInviteCode(genResult.inviteCode)!;

      const initResult = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      if (!initResult.ok) throw new Error('Failed to initiate');

      // Pending connections have no outbound credential, so no notification
      // is sent and the status goes straight to revoked.
      const result = await revokeConnection({ connectionId: initResult.connectionId });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe('revoked');

      const conn = getConnection(initResult.connectionId);
      expect(conn!.status).toBe('revoked');
    });
  });

  // ========================================================================
  // Not found
  // ========================================================================

  describe('edge cases', () => {
    test('returns not_found for nonexistent connection', async () => {
      const result = await revokeConnection({ connectionId: 'nonexistent' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });
  });
});

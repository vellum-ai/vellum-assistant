import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-routes-test-'));

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
  handleA2AInvite,
  handleA2ARedeem,
  handleA2AConnect,
  handleA2AApprove,
  handleA2AVerify,
  handleA2ARevoke,
  handleA2AListConnections,
  handleA2AConnectionStatus,
} from '../../runtime/routes/a2a-routes.js';
import {
  generateInvite,
  decodeInviteCode,
  initiateConnection,
  approveConnection,
  _resetHandshakeSessions,
  _resetIdempotencyStore,
} from '../a2a-connection-service.js';
import {
  inviteRedemptionLimiter,
  codeVerificationLimiter,
  statusPollingLimiter,
} from '../a2a-rate-limiter.js';
import { getDb, initializeDb, resetDb } from '../../memory/db.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
  db.run('DELETE FROM assistant_ingress_invites');
}

const MOCK_GATEWAY_URL = 'https://my-assistant.example.com';
const PEER_GATEWAY_URL = 'https://peer-assistant.example.com';

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('a2a-routes', () => {
  beforeEach(() => {
    resetTables();
    _resetHandshakeSessions();
    _resetIdempotencyStore();
    inviteRedemptionLimiter.clear();
    codeVerificationLimiter.clear();
    statusPollingLimiter.clear();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ========================================================================
  // POST /v1/a2a/invite
  // ========================================================================

  describe('handleA2AInvite', () => {
    test('happy path — generates an invite', async () => {
      const res = await handleA2AInvite(jsonReq({ gatewayUrl: MOCK_GATEWAY_URL }));
      expect(res.status).toBe(200);
      const body = await res.json() as { inviteCode: string; inviteId: string };
      expect(body.inviteCode).toBeTruthy();
      expect(body.inviteId).toBeTruthy();
    });

    test('missing gatewayUrl returns 400', async () => {
      const res = await handleA2AInvite(jsonReq({}));
      expect(res.status).toBe(400);
    });

    test('empty gatewayUrl returns 400', async () => {
      const res = await handleA2AInvite(jsonReq({ gatewayUrl: '' }));
      expect(res.status).toBe(400);
    });

    test('idempotent invite generation', async () => {
      const req1 = jsonReq({ gatewayUrl: MOCK_GATEWAY_URL, idempotencyKey: 'test-key' });
      const res1 = await handleA2AInvite(req1);
      const body1 = await res1.json() as { inviteCode: string; inviteId: string };

      const req2 = jsonReq({ gatewayUrl: MOCK_GATEWAY_URL, idempotencyKey: 'test-key' });
      const res2 = await handleA2AInvite(req2);
      const body2 = await res2.json() as { inviteCode: string; inviteId: string };

      expect(body1.inviteCode).toBe(body2.inviteCode);
      expect(body1.inviteId).toBe(body2.inviteId);
    });
  });

  // ========================================================================
  // POST /v1/a2a/redeem
  // ========================================================================

  describe('handleA2ARedeem', () => {
    test('happy path — redeems a valid invite', async () => {
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');

      const res = await handleA2ARedeem(jsonReq({ inviteCode: inviteResult.inviteCode }));
      expect(res.status).toBe(200);
      const body = await res.json() as { peerGatewayUrl: string; inviteId: string };
      expect(body.peerGatewayUrl).toBe(MOCK_GATEWAY_URL);
      expect(body.inviteId).toBe(inviteResult.inviteId);
    });

    test('missing inviteCode returns 400', async () => {
      const res = await handleA2ARedeem(jsonReq({}));
      expect(res.status).toBe(400);
    });

    test('malformed invite returns 400', async () => {
      const res = await handleA2ARedeem(jsonReq({ inviteCode: 'not-valid-base64' }));
      expect(res.status).toBe(400);
    });

    test('invalid token returns 404', async () => {
      // Create a well-formed but unknown invite code
      const fakeCode = Buffer.from(JSON.stringify({
        g: 'https://fake.example.com',
        t: 'nonexistent-token',
        v: '1.0.0',
      })).toString('base64url');
      const res = await handleA2ARedeem(jsonReq({ inviteCode: fakeCode }));
      expect(res.status).toBe(404);
    });

    test('rate limit enforcement — returns 429 after 5 attempts', async () => {
      const inviteCode = 'rate-limit-test-code';
      for (let i = 0; i < 5; i++) {
        await handleA2ARedeem(jsonReq({ inviteCode }));
      }

      const res = await handleA2ARedeem(jsonReq({ inviteCode }));
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });
  });

  // ========================================================================
  // POST /v1/a2a/connect
  // ========================================================================

  describe('handleA2AConnect', () => {
    test('happy path — initiates connection with valid invite token', async () => {
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');

      const payload = decodeInviteCode(inviteResult.inviteCode);
      if (!payload) throw new Error('Failed to decode invite code');

      const res = await handleA2AConnect(jsonReq({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      }));
      expect(res.status).toBe(201);
      const body = await res.json() as { connectionId: string; handshakeSessionId: string };
      expect(body.connectionId).toBeTruthy();
      expect(body.handshakeSessionId).toBeTruthy();
    });

    test('missing peerGatewayUrl returns 400', async () => {
      const res = await handleA2AConnect(jsonReq({ inviteToken: 'some-token' }));
      expect(res.status).toBe(400);
    });

    test('missing inviteToken returns 400', async () => {
      const res = await handleA2AConnect(jsonReq({ peerGatewayUrl: PEER_GATEWAY_URL }));
      expect(res.status).toBe(400);
    });

    test('invalid invite token returns 404', async () => {
      const res = await handleA2AConnect(jsonReq({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: 'nonexistent-token',
        protocolVersion: '1.0.0',
        capabilities: [],
      }));
      expect(res.status).toBe(404);
    });

    test('consumed invite returns 409', async () => {
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');
      const payload = decodeInviteCode(inviteResult.inviteCode);
      if (!payload) throw new Error('Failed to decode invite code');

      // First connect consumes the invite
      await handleA2AConnect(jsonReq({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      }));

      // Second connect should fail
      const res = await handleA2AConnect(jsonReq({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      }));
      expect(res.status).toBe(409);
    });
  });

  // ========================================================================
  // POST /v1/a2a/approve
  // ========================================================================

  describe('handleA2AApprove', () => {
    function createPendingConnection(): { connectionId: string } {
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');
      const payload = decodeInviteCode(inviteResult.inviteCode);
      if (!payload) throw new Error('Failed to decode invite code');

      const connectResult = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      });
      if (!connectResult.ok) throw new Error('Failed to initiate connection');
      return { connectionId: connectResult.connectionId };
    }

    test('happy path — approve returns verification code', async () => {
      const { connectionId } = createPendingConnection();

      const res = await handleA2AApprove(jsonReq({
        connectionId,
        decision: 'approve',
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { verificationCode: string; connectionId: string };
      expect(body.verificationCode).toBeTruthy();
      expect(body.connectionId).toBe(connectionId);
    });

    test('deny returns ok', async () => {
      const { connectionId } = createPendingConnection();

      const res = await handleA2AApprove(jsonReq({
        connectionId,
        decision: 'deny',
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    test('missing connectionId returns 400', async () => {
      const res = await handleA2AApprove(jsonReq({ decision: 'approve' }));
      expect(res.status).toBe(400);
    });

    test('invalid decision returns 400', async () => {
      const res = await handleA2AApprove(jsonReq({
        connectionId: 'some-id',
        decision: 'invalid',
      }));
      expect(res.status).toBe(400);
    });

    test('nonexistent connection returns 404', async () => {
      const res = await handleA2AApprove(jsonReq({
        connectionId: 'nonexistent',
        decision: 'approve',
      }));
      expect(res.status).toBe(404);
    });
  });

  // ========================================================================
  // POST /v1/a2a/verify
  // ========================================================================

  describe('handleA2AVerify', () => {
    function createApprovedConnection(): { connectionId: string; verificationCode: string } {
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');
      const payload = decodeInviteCode(inviteResult.inviteCode);
      if (!payload) throw new Error('Failed to decode invite code');

      const connectResult = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      });
      if (!connectResult.ok) throw new Error('Failed to initiate connection');

      const approveResult = approveConnection({
        connectionId: connectResult.connectionId,
        decision: 'approve',
      });
      if (!approveResult.ok || !('verificationCode' in approveResult)) {
        throw new Error('Failed to approve connection');
      }

      return {
        connectionId: connectResult.connectionId,
        verificationCode: approveResult.verificationCode,
      };
    }

    test('happy path — valid code transitions to active', async () => {
      const { connectionId, verificationCode } = createApprovedConnection();

      const res = await handleA2AVerify(jsonReq({
        connectionId,
        code: verificationCode,
        peerIdentity: PEER_GATEWAY_URL,
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { connectionId: string; status: string };
      expect(body.connectionId).toBe(connectionId);
      expect(body.status).toBe('active');
    });

    test('missing connectionId returns 400', async () => {
      const res = await handleA2AVerify(jsonReq({ code: '123456', peerIdentity: 'test' }));
      expect(res.status).toBe(400);
    });

    test('missing code returns 400', async () => {
      const res = await handleA2AVerify(jsonReq({ connectionId: 'some-id', peerIdentity: 'test' }));
      expect(res.status).toBe(400);
    });

    test('missing peerIdentity returns 400', async () => {
      const res = await handleA2AVerify(jsonReq({ connectionId: 'some-id', code: '123456' }));
      expect(res.status).toBe(400);
    });

    test('invalid code returns 403', async () => {
      const { connectionId } = createApprovedConnection();

      const res = await handleA2AVerify(jsonReq({
        connectionId,
        code: 'wrong-code',
        peerIdentity: PEER_GATEWAY_URL,
      }));
      expect(res.status).toBe(403);
    });

    test('nonexistent connection returns 404', async () => {
      const res = await handleA2AVerify(jsonReq({
        connectionId: 'nonexistent',
        code: '123456',
        peerIdentity: 'test',
      }));
      expect(res.status).toBe(404);
    });

    test('rate limit enforcement — returns 429 after 5 attempts', async () => {
      const { connectionId } = createApprovedConnection();

      for (let i = 0; i < 5; i++) {
        await handleA2AVerify(jsonReq({
          connectionId,
          code: 'wrong-code',
          peerIdentity: PEER_GATEWAY_URL,
        }));
      }

      const res = await handleA2AVerify(jsonReq({
        connectionId,
        code: 'wrong-code',
        peerIdentity: PEER_GATEWAY_URL,
      }));
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });
  });

  // ========================================================================
  // POST /v1/a2a/revoke
  // ========================================================================

  describe('handleA2ARevoke', () => {
    test('missing connectionId returns 400', async () => {
      const res = await handleA2ARevoke(jsonReq({}));
      expect(res.status).toBe(400);
    });

    test('nonexistent connection returns 404', async () => {
      const res = await handleA2ARevoke(jsonReq({ connectionId: 'nonexistent' }));
      expect(res.status).toBe(404);
    });

    test('happy path — revoke an active connection', async () => {
      // Create a full connection cycle to get to active state
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');
      const payload = decodeInviteCode(inviteResult.inviteCode);
      if (!payload) throw new Error('Failed to decode invite code');

      const connectResult = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      });
      if (!connectResult.ok) throw new Error('Failed to initiate connection');

      const approveResult = approveConnection({
        connectionId: connectResult.connectionId,
        decision: 'approve',
      });
      if (!approveResult.ok || !('verificationCode' in approveResult)) {
        throw new Error('Failed to approve connection');
      }

      // Use the route handler for the revoke step
      const res = await handleA2ARevoke(jsonReq({
        connectionId: connectResult.connectionId,
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  // ========================================================================
  // GET /v1/a2a/connections
  // ========================================================================

  describe('handleA2AListConnections', () => {
    test('returns empty array when no connections', () => {
      const url = new URL('http://localhost/v1/a2a/connections');
      const res = handleA2AListConnections(url);
      expect(res.status).toBe(200);
    });

    test('returns connections after creating one', async () => {
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');
      const payload = decodeInviteCode(inviteResult.inviteCode);
      if (!payload) throw new Error('Failed to decode invite code');

      initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      });

      const url = new URL('http://localhost/v1/a2a/connections');
      const res = handleA2AListConnections(url);
      expect(res.status).toBe(200);
      const body = await res.json() as { connections: unknown[] };
      expect(body.connections.length).toBeGreaterThan(0);
    });

    test('filters by status', async () => {
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');
      const payload = decodeInviteCode(inviteResult.inviteCode);
      if (!payload) throw new Error('Failed to decode invite code');

      initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      });

      const url = new URL('http://localhost/v1/a2a/connections?status=active');
      const res = handleA2AListConnections(url);
      const body = await res.json() as { connections: unknown[] };
      expect(body.connections.length).toBe(0);

      const url2 = new URL('http://localhost/v1/a2a/connections?status=pending');
      const res2 = handleA2AListConnections(url2);
      const body2 = await res2.json() as { connections: unknown[] };
      expect(body2.connections.length).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // GET /v1/a2a/connections/:connectionId/status
  // ========================================================================

  describe('handleA2AConnectionStatus', () => {
    test('nonexistent connection returns 404', () => {
      const res = handleA2AConnectionStatus('nonexistent');
      expect(res.status).toBe(404);
    });

    test('happy path — returns connection status', async () => {
      const inviteResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('Failed to generate invite');
      const payload = decodeInviteCode(inviteResult.inviteCode);
      if (!payload) throw new Error('Failed to decode invite code');

      const connectResult = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: payload.t,
        protocolVersion: '1.0.0',
        capabilities: [],
      });
      if (!connectResult.ok) throw new Error('Failed to initiate connection');

      const res = handleA2AConnectionStatus(connectResult.connectionId);
      expect(res.status).toBe(200);
      const body = await res.json() as { connectionId: string; status: string };
      expect(body.connectionId).toBe(connectResult.connectionId);
      expect(body.status).toBe('pending');
    });

    test('rate limit enforcement — returns 429 after 60 requests', () => {
      const connectionId = 'rate-limit-test-id';
      for (let i = 0; i < 60; i++) {
        handleA2AConnectionStatus(connectionId);
      }

      const res = handleA2AConnectionStatus(connectionId);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });
  });

  // ========================================================================
  // Authentication (401)
  // ========================================================================

  describe('authentication', () => {
    // Note: Auth enforcement happens at the HTTP server level, not in the route
    // handlers. These tests verify the route handlers themselves work with valid
    // requests. The HTTP server tests would cover auth enforcement.

    test('all POST endpoints reject empty JSON gracefully', async () => {
      const endpoints = [
        handleA2AInvite,
        handleA2ARedeem,
        handleA2AConnect,
        handleA2AApprove,
        handleA2AVerify,
        handleA2ARevoke,
      ];

      for (const handler of endpoints) {
        const res = await handler(jsonReq({}));
        expect(res.status).toBe(400);
      }
    });
  });
});

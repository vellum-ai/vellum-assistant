import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-connection-service-test-'));

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
  A2A_PROTOCOL_VERSION,
  A2A_SOURCE_CHANNEL,
  approveConnection,
  decodeInviteCode,
  encodeInviteCode,
  generateInvite,
  initiateConnection,
  listConnectionsFiltered,
  redeemInvite,
  revokeConnection,
  submitVerificationCode,
  validateA2ATarget,
  _resetHandshakeSessions,
  _resetIdempotencyStore,
} from '../a2a-connection-service.js';
import { getConnection } from '../a2a-peer-connection-store.js';
import { getDb, initializeDb, resetDb } from '../../memory/db.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
  db.run('DELETE FROM assistant_ingress_invites');
}

const MOCK_GATEWAY_URL = 'https://my-assistant.example.com';
const PEER_GATEWAY_URL = 'https://peer-assistant.example.com';

describe('a2a-connection-service', () => {
  beforeEach(() => {
    resetTables();
    _resetHandshakeSessions();
    _resetIdempotencyStore();
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
  // Invite code encoding / decoding
  // ========================================================================

  describe('encodeInviteCode / decodeInviteCode', () => {
    test('round-trips correctly', () => {
      const code = encodeInviteCode('https://example.com/gateway', 'test-token');
      const decoded = decodeInviteCode(code);
      expect(decoded).not.toBeNull();
      expect(decoded!.g).toBe('https://example.com/gateway');
      expect(decoded!.t).toBe('test-token');
      expect(decoded!.v).toBe(A2A_PROTOCOL_VERSION);
    });

    test('returns null for malformed code', () => {
      expect(decodeInviteCode('not-valid-base64url!!!')).toBeNull();
    });

    test('returns null for valid base64 but invalid JSON', () => {
      const code = Buffer.from('not json').toString('base64url');
      expect(decodeInviteCode(code)).toBeNull();
    });

    test('returns null for JSON missing required fields', () => {
      const code = Buffer.from(JSON.stringify({ g: 'url' })).toString('base64url');
      expect(decodeInviteCode(code)).toBeNull();
    });

    test('returns null for empty string fields', () => {
      const code = Buffer.from(JSON.stringify({ g: '', t: 'token', v: '1.0.0' })).toString('base64url');
      expect(decodeInviteCode(code)).toBeNull();
    });
  });

  // ========================================================================
  // Target URL validation
  // ========================================================================

  describe('validateA2ATarget', () => {
    test('accepts HTTPS URLs', () => {
      const result = validateA2ATarget('https://peer.example.com');
      expect(result.ok).toBe(true);
    });

    test('accepts HTTP for localhost', () => {
      const result = validateA2ATarget('http://localhost:7830');
      expect(result.ok).toBe(true);
    });

    test('accepts HTTP for 127.0.0.1', () => {
      const result = validateA2ATarget('http://127.0.0.1:7830');
      expect(result.ok).toBe(true);
    });

    test('accepts HTTP for 10.x.x.x', () => {
      const result = validateA2ATarget('http://10.0.1.5:7830');
      expect(result.ok).toBe(true);
    });

    test('accepts HTTP for 172.16.x.x', () => {
      const result = validateA2ATarget('http://172.16.0.1:7830');
      expect(result.ok).toBe(true);
    });

    test('accepts HTTP for 192.168.x.x', () => {
      const result = validateA2ATarget('http://192.168.1.100:7830');
      expect(result.ok).toBe(true);
    });

    test('rejects HTTP for public addresses', () => {
      const result = validateA2ATarget('http://peer.example.com');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('HTTPS');
      }
    });

    test('rejects non-HTTP(S) schemes', () => {
      const result = validateA2ATarget('ftp://peer.example.com');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('scheme');
      }
    });

    test('rejects invalid URL format', () => {
      const result = validateA2ATarget('not-a-url');
      expect(result.ok).toBe(false);
    });

    test('rejects port 7821 (runtime port)', () => {
      const result = validateA2ATarget('https://peer.example.com:7821');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('7821');
      }
    });

    test('rejects port 7821 on localhost', () => {
      const result = validateA2ATarget('http://localhost:7821');
      expect(result.ok).toBe(false);
    });

    test('rejects 169.254.x.x (link-local / metadata)', () => {
      const result = validateA2ATarget('http://169.254.169.254/metadata');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('link-local');
      }
    });

    test('rejects fe80:: (IPv6 link-local)', () => {
      const result = validateA2ATarget('http://[fe80::1]:7830');
      expect(result.ok).toBe(false);
    });

    test('rejects self-loop to own gateway', () => {
      const result = validateA2ATarget(
        'https://my-assistant.example.com:443',
        'https://my-assistant.example.com:443',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('self-loop');
      }
    });

    test('accepts HTTPS for private IPs', () => {
      const result = validateA2ATarget('https://192.168.1.100:8443');
      expect(result.ok).toBe(true);
    });

    test('accepts HTTP for .local addresses', () => {
      const result = validateA2ATarget('http://myhost.local:7830');
      expect(result.ok).toBe(true);
    });
  });

  // ========================================================================
  // generateInvite
  // ========================================================================

  describe('generateInvite', () => {
    test('creates an invite and returns a decodable invite code', () => {
      const result = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.inviteId).toBeTruthy();
        expect(result.inviteCode).toBeTruthy();

        const decoded = decodeInviteCode(result.inviteCode);
        expect(decoded).not.toBeNull();
        expect(decoded!.g).toBe(MOCK_GATEWAY_URL);
        expect(decoded!.v).toBe(A2A_PROTOCOL_VERSION);
      }
    });

    test('returns error when gateway URL is empty', () => {
      const result = generateInvite({ gatewayUrl: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing_gateway_url');
      }
    });

    test('idempotent with idempotency key', () => {
      const r1 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL, idempotencyKey: 'key-1' });
      const r2 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL, idempotencyKey: 'key-1' });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.inviteId).toBe(r2.inviteId);
        expect(r1.inviteCode).toBe(r2.inviteCode);
      }
    });

    test('different idempotency keys produce different invites', () => {
      const r1 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL, idempotencyKey: 'key-1' });
      const r2 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL, idempotencyKey: 'key-2' });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.inviteId).not.toBe(r2.inviteId);
      }
    });

    test('no idempotency key always creates new invite', () => {
      const r1 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      const r2 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.inviteId).not.toBe(r2.inviteId);
      }
    });

    test('supports custom expiry and note', () => {
      const result = generateInvite({
        gatewayUrl: MOCK_GATEWAY_URL,
        expiresInMs: 3600_000,
        note: 'Test invite',
      });
      expect(result.ok).toBe(true);
    });
  });

  // ========================================================================
  // redeemInvite
  // ========================================================================

  describe('redeemInvite', () => {
    test('successfully redeems a valid invite', () => {
      const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      expect(genResult.ok).toBe(true);
      if (!genResult.ok) return;

      const redeemResult = redeemInvite({ inviteCode: genResult.inviteCode });
      expect(redeemResult.ok).toBe(true);
      if (redeemResult.ok) {
        expect(redeemResult.peerGatewayUrl).toBe(MOCK_GATEWAY_URL);
        expect(redeemResult.inviteId).toBe(genResult.inviteId);
        expect(redeemResult.tokenHash).toBeTruthy();
      }
    });

    test('rejects malformed invite code', () => {
      const result = redeemInvite({ inviteCode: 'garbage' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('malformed_invite');
      }
    });

    test('rejects invite with unknown token', () => {
      const fakeCode = encodeInviteCode('https://fake.example.com', 'nonexistent-token');
      const result = redeemInvite({ inviteCode: fakeCode });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_or_expired');
      }
    });

    test('returns already_redeemed for consumed invite', () => {
      // Generate and then consume via initiateConnection
      const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!genResult.ok) throw new Error('Failed');

      const decoded = decodeInviteCode(genResult.inviteCode)!;

      // Consume via initiateConnection
      initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });

      // Try to redeem again
      const redeemResult = redeemInvite({ inviteCode: genResult.inviteCode });
      expect(redeemResult.ok).toBe(false);
      if (!redeemResult.ok) {
        expect(redeemResult.reason).toBe('already_redeemed');
      }
    });
  });

  // ========================================================================
  // initiateConnection
  // ========================================================================

  describe('initiateConnection', () => {
    function createValidInvite() {
      const result = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!result.ok) throw new Error('Failed to create invite');
      const decoded = decodeInviteCode(result.inviteCode);
      if (!decoded) throw new Error('Failed to decode invite');
      return { ...result, token: decoded.t };
    }

    test('creates a pending connection with valid invite', () => {
      const invite = createValidInvite();
      const result = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: invite.token,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: ['scheduling:read'],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.connectionId).toBeTruthy();
        expect(result.handshakeSessionId).toBeTruthy();

        // Verify connection in store
        const conn = getConnection(result.connectionId);
        expect(conn).not.toBeNull();
        expect(conn!.status).toBe('pending');
        expect(conn!.peerGatewayUrl).toBe(PEER_GATEWAY_URL);
        expect(conn!.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
        expect(conn!.capabilities).toEqual(['scheduling:read']);
      }
    });

    test('rejects invalid target URL', () => {
      const invite = createValidInvite();
      const result = initiateConnection({
        peerGatewayUrl: 'http://public-host.example.com',
        inviteToken: invite.token,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_target');
      }
    });

    test('rejects protocol version mismatch', () => {
      const invite = createValidInvite();
      const result = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: invite.token,
        protocolVersion: '2.0.0',
        capabilities: [],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('version_mismatch');
        expect(result.detail).toContain('major version');
      }
    });

    test('accepts minor version difference', () => {
      const invite = createValidInvite();
      const result = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: invite.token,
        protocolVersion: '1.1.0',
        capabilities: [],
      });

      expect(result.ok).toBe(true);
    });

    test('rejects invalid invite token', () => {
      const result = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: 'nonexistent-token',
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invite_not_found');
      }
    });

    test('rejects already-consumed invite (one-time use)', () => {
      const invite = createValidInvite();

      // First use succeeds
      const r1 = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: invite.token,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      expect(r1.ok).toBe(true);

      // Second use fails
      const r2 = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: invite.token,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.reason).toBe('invite_consumed');
      }
    });

    test('rejects connection to runtime port', () => {
      const invite = createValidInvite();
      const result = initiateConnection({
        peerGatewayUrl: 'https://peer.example.com:7821',
        inviteToken: invite.token,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_target');
      }
    });

    test('rejects connection to link-local address', () => {
      const invite = createValidInvite();
      const result = initiateConnection({
        peerGatewayUrl: 'http://169.254.169.254/metadata',
        inviteToken: invite.token,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_target');
      }
    });
  });

  // ========================================================================
  // approveConnection
  // ========================================================================

  describe('approveConnection', () => {
    function createPendingConnection() {
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
      return initResult;
    }

    test('approve generates verification code', () => {
      const conn = createPendingConnection();
      const result = approveConnection({
        connectionId: conn.connectionId,
        decision: 'approve',
      });

      expect(result.ok).toBe(true);
      if (result.ok && 'verificationCode' in result) {
        expect(result.verificationCode).toBeTruthy();
        expect(result.verificationCode).toHaveLength(6);
        expect(result.connectionId).toBe(conn.connectionId);
      }
    });

    test('deny revokes the connection', () => {
      const conn = createPendingConnection();
      const result = approveConnection({
        connectionId: conn.connectionId,
        decision: 'deny',
      });

      expect(result.ok).toBe(true);

      const connection = getConnection(conn.connectionId);
      expect(connection).not.toBeNull();
      expect(connection!.status).toBe('revoked');
    });

    test('returns not_found for nonexistent connection', () => {
      const result = approveConnection({
        connectionId: 'nonexistent',
        decision: 'approve',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    test('returns already_resolved for active connection', () => {
      const conn = createPendingConnection();

      // Approve once
      const r1 = approveConnection({
        connectionId: conn.connectionId,
        decision: 'approve',
      });
      expect(r1.ok).toBe(true);

      // Submit code to activate
      if (r1.ok && 'verificationCode' in r1) {
        submitVerificationCode({
          connectionId: conn.connectionId,
          code: r1.verificationCode,
          peerIdentity: PEER_GATEWAY_URL,
        });
      }

      // Try to approve again (connection is now active)
      const r2 = approveConnection({
        connectionId: conn.connectionId,
        decision: 'approve',
      });
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.reason).toBe('already_resolved');
      }
    });
  });

  // ========================================================================
  // submitVerificationCode
  // ========================================================================

  describe('submitVerificationCode', () => {
    function createApprovedConnection() {
      const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!genResult.ok) throw new Error('Failed to create invite');
      const decoded = decodeInviteCode(genResult.inviteCode)!;

      const initResult = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: ['scheduling:read'],
      });
      if (!initResult.ok) throw new Error('Failed to initiate connection');

      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      if (!approveResult.ok) throw new Error('Failed to approve connection');

      const verificationCode = (approveResult as { ok: true; verificationCode: string }).verificationCode;

      return {
        connectionId: initResult.connectionId,
        verificationCode,
      };
    }

    test('valid code activates the connection', () => {
      const { connectionId, verificationCode } = createApprovedConnection();

      const result = submitVerificationCode({
        connectionId,
        code: verificationCode,
        peerIdentity: PEER_GATEWAY_URL,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.connection.status).toBe('active');
        expect(result.connection.outboundCredentialHash).toBeTruthy();
        expect(result.connection.inboundCredentialHash).toBeTruthy();
      }
    });

    test('invalid code returns error', () => {
      const { connectionId } = createApprovedConnection();

      const result = submitVerificationCode({
        connectionId,
        code: '000000',
        peerIdentity: PEER_GATEWAY_URL,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_code');
      }
    });

    test('returns not_found for nonexistent connection', () => {
      const result = submitVerificationCode({
        connectionId: 'nonexistent',
        code: '123456',
        peerIdentity: 'peer',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    test('wrong peer identity returns identity_mismatch', () => {
      const { connectionId, verificationCode } = createApprovedConnection();

      const result = submitVerificationCode({
        connectionId,
        code: verificationCode,
        peerIdentity: 'wrong-peer',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('identity_mismatch');
      }
    });

    test('max attempts exhaustion', () => {
      const { connectionId } = createApprovedConnection();

      // Submit wrong codes up to the limit
      for (let i = 0; i < 3; i++) {
        submitVerificationCode({
          connectionId,
          code: `99999${i}`,
          peerIdentity: PEER_GATEWAY_URL,
        });
      }

      // Next attempt should fail with max_attempts
      const result = submitVerificationCode({
        connectionId,
        code: '999999',
        peerIdentity: PEER_GATEWAY_URL,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('max_attempts');
      }
    });
  });

  // ========================================================================
  // revokeConnection
  // ========================================================================

  describe('revokeConnection', () => {
    function createActiveConnection() {
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

    test('revokes an active connection', () => {
      const connectionId = createActiveConnection();
      const result = revokeConnection({ connectionId });
      expect(result.ok).toBe(true);

      const conn = getConnection(connectionId);
      expect(conn).not.toBeNull();
      expect(conn!.status).toBe('revoked');
      // Credentials should be tombstoned
      expect(conn!.outboundCredentialHash).toBe('');
      expect(conn!.inboundCredentialHash).toBe('');
    });

    test('idempotent: revoking already-revoked returns ok', () => {
      const connectionId = createActiveConnection();

      const r1 = revokeConnection({ connectionId });
      expect(r1.ok).toBe(true);

      const r2 = revokeConnection({ connectionId });
      expect(r2.ok).toBe(true);
    });

    test('returns not_found for nonexistent connection', () => {
      const result = revokeConnection({ connectionId: 'nonexistent' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    test('can revoke a pending connection', () => {
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

      const result = revokeConnection({ connectionId: initResult.connectionId });
      expect(result.ok).toBe(true);

      const conn = getConnection(initResult.connectionId);
      expect(conn!.status).toBe('revoked');
    });
  });

  // ========================================================================
  // listConnections
  // ========================================================================

  describe('listConnectionsFiltered', () => {
    test('returns empty array when no connections', () => {
      const result = listConnectionsFiltered();
      expect(result.connections).toHaveLength(0);
    });

    test('returns all connections', () => {
      const gen1 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      const gen2 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!gen1.ok || !gen2.ok) throw new Error('Failed');

      const d1 = decodeInviteCode(gen1.inviteCode)!;
      const d2 = decodeInviteCode(gen2.inviteCode)!;

      initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: d1.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      initiateConnection({
        peerGatewayUrl: 'https://other-peer.example.com',
        inviteToken: d2.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });

      const result = listConnectionsFiltered();
      expect(result.connections).toHaveLength(2);
    });

    test('filters by status', () => {
      const gen1 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      const gen2 = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!gen1.ok || !gen2.ok) throw new Error('Failed');

      const d1 = decodeInviteCode(gen1.inviteCode)!;
      const d2 = decodeInviteCode(gen2.inviteCode)!;

      const c1 = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: d1.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      initiateConnection({
        peerGatewayUrl: 'https://other-peer.example.com',
        inviteToken: d2.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });

      if (c1.ok) {
        revokeConnection({ connectionId: c1.connectionId });
      }

      const pending = listConnectionsFiltered({ status: 'pending' });
      expect(pending.connections).toHaveLength(1);

      const revoked = listConnectionsFiltered({ status: 'revoked' });
      expect(revoked.connections).toHaveLength(1);

      const active = listConnectionsFiltered({ status: 'active' });
      expect(active.connections).toHaveLength(0);
    });
  });

  // ========================================================================
  // Full lifecycle: generate -> redeem -> initiate -> approve -> verify
  // ========================================================================

  describe('full connection lifecycle', () => {
    test('complete happy path', () => {
      // Step 1: Generate invite
      const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      expect(genResult.ok).toBe(true);
      if (!genResult.ok) return;

      // Step 2: Redeem invite (peer side validation)
      const redeemResult = redeemInvite({ inviteCode: genResult.inviteCode });
      expect(redeemResult.ok).toBe(true);
      if (!redeemResult.ok) return;
      expect(redeemResult.peerGatewayUrl).toBe(MOCK_GATEWAY_URL);

      // Step 3: Initiate connection with the token from the invite
      const decoded = decodeInviteCode(genResult.inviteCode)!;
      const initResult = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: ['scheduling:read', 'messaging:relay'],
      });
      expect(initResult.ok).toBe(true);
      if (!initResult.ok) return;

      // Verify connection is pending
      let conn = getConnection(initResult.connectionId);
      expect(conn!.status).toBe('pending');

      // Step 4: Approve the connection
      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      expect(approveResult.ok).toBe(true);
      if (!approveResult.ok) return;
      const verificationCode = (approveResult as { ok: true; verificationCode: string }).verificationCode;

      // Step 5: Submit verification code — peerIdentity must match the bound
      // identity (peerAssistantId ?? peerGatewayUrl), not the connectionId
      const verifyResult = submitVerificationCode({
        connectionId: initResult.connectionId,
        code: verificationCode,
        peerIdentity: PEER_GATEWAY_URL,
      });
      expect(verifyResult.ok).toBe(true);
      if (!verifyResult.ok) return;

      // Verify final state
      conn = getConnection(initResult.connectionId);
      expect(conn!.status).toBe('active');
      expect(conn!.outboundCredentialHash).toBeTruthy();
      expect(conn!.inboundCredentialHash).toBeTruthy();
      expect(conn!.peerGatewayUrl).toBe(PEER_GATEWAY_URL);
      expect(conn!.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    });

    test('lifecycle with revocation', () => {
      // Set up an active connection
      const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
      if (!genResult.ok) throw new Error('Failed');
      const decoded = decodeInviteCode(genResult.inviteCode)!;

      const initResult = initiateConnection({
        peerGatewayUrl: PEER_GATEWAY_URL,
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      if (!initResult.ok) throw new Error('Failed');

      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      if (!approveResult.ok) throw new Error('Failed');

      const code = (approveResult as { ok: true; verificationCode: string }).verificationCode;
      const verifyResult = submitVerificationCode({
        connectionId: initResult.connectionId,
        code,
        peerIdentity: PEER_GATEWAY_URL,
      });
      if (!verifyResult.ok) throw new Error('Failed');

      // Revoke
      const revokeResult = revokeConnection({ connectionId: initResult.connectionId });
      expect(revokeResult.ok).toBe(true);

      const conn = getConnection(initResult.connectionId);
      expect(conn!.status).toBe('revoked');
      expect(conn!.outboundCredentialHash).toBe('');
      expect(conn!.inboundCredentialHash).toBe('');
    });
  });

  // ========================================================================
  // Protocol version constant
  // ========================================================================

  describe('constants', () => {
    test('A2A_PROTOCOL_VERSION is semver', () => {
      expect(A2A_PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('A2A_SOURCE_CHANNEL is assistant', () => {
      expect(A2A_SOURCE_CHANNEL).toBe('assistant');
    });
  });
});

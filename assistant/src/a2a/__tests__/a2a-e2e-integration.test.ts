/**
 * End-to-end integration tests for A2A connection lifecycle.
 *
 * Exercises the full flow through the service layer, simulating two
 * assistants (Alice and Bob) going through the complete connection
 * lifecycle: invite generation -> redemption -> connection request ->
 * guardian approval -> IRL verification code exchange -> active
 * connection -> message exchange -> revocation.
 *
 * Uses real in-memory SQLite (via the actual store layer) with mocked
 * outbound delivery (HTTP calls to peer gateways) and notification
 * signals. Tests are surface-agnostic by design — they call service
 * methods directly, which is exactly how any future surface (HTTP,
 * Telegram, etc.) would interact with the A2A subsystem.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-integration-test-'));

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that touches mocked modules.
// ---------------------------------------------------------------------------

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

// Track notification signals emitted during tests
const emittedSignals: Array<{ sourceEventName: string; contextPayload: Record<string, unknown> }> = [];
mock.module('../../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async (params: { sourceEventName: string; contextPayload: Record<string, unknown> }) => {
    emittedSignals.push({ sourceEventName: params.sourceEventName, contextPayload: params.contextPayload });
    return { signalId: 'test-signal', deduplicated: false, dispatched: true, reason: 'ok', deliveryResults: [] };
  },
}));

// Mock outbound delivery — track calls and control success/failure per test
let deliverMessageShouldSucceed = true;
let deliveredMessages: Array<{ connectionId: string; envelope: unknown }> = [];
mock.module('../a2a-outbound-delivery.js', () => ({
  deliverMessage: async (params: { connectionId: string; envelope: { messageId: string } }) => {
    deliveredMessages.push({ connectionId: params.connectionId, envelope: params.envelope });
    if (deliverMessageShouldSucceed) {
      return { ok: true, messageId: params.envelope.messageId };
    }
    return { ok: false, reason: 'delivery_failed', error: 'mock delivery failure' };
  },
  MAX_RETRIES: 3,
}));

// Mock revocation delivery — track calls and control success/failure per test
let revocationDeliveryShouldSucceed = true;
let revocationDeliveries: Array<{ connectionId: string; peerGatewayUrl: string }> = [];
mock.module('../a2a-revocation-delivery.js', () => ({
  deliverRevocationNotification: async (params: { connectionId: string; peerGatewayUrl: string }) => {
    revocationDeliveries.push({ connectionId: params.connectionId, peerGatewayUrl: params.peerGatewayUrl });
    if (revocationDeliveryShouldSucceed) {
      return { ok: true };
    }
    return { ok: false, reason: 'delivery_failed', error: 'peer unreachable' };
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  A2A_PROTOCOL_VERSION,
  approveConnection,
  decodeInviteCode,
  generateInvite,
  handlePeerRevocationNotification,
  initiateConnection,
  listConnectionsFiltered,
  redeemInvite,
  revokeConnection,
  sendMessage,
  submitVerificationCode,
  _resetHandshakeSessions,
  _resetIdempotencyStore,
} from '../a2a-connection-service.js';
import {
  getConnection,
  updateConnectionStatus,
} from '../a2a-peer-connection-store.js';
import { getDb, initializeDb, resetDb } from '../../memory/db.js';
import { hashHandshakeSecret, VERIFICATION_CODE_TTL_MS } from '../a2a-handshake.js';

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALICE_GATEWAY_URL = 'https://alice-assistant.example.com';
const BOB_GATEWAY_URL = 'https://bob-assistant.example.com';

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
  db.run('DELETE FROM assistant_ingress_invites');
  db.run('DELETE FROM external_conversation_bindings');
}

function resetMocks(): void {
  emittedSignals.length = 0;
  deliveredMessages.length = 0;
  revocationDeliveries.length = 0;
  deliverMessageShouldSucceed = true;
  revocationDeliveryShouldSucceed = true;
}

/**
 * Walk through the full handshake to produce an active connection.
 * Returns the connectionId and the verification code used.
 */
function fullHandshakeToActive(params?: {
  aliceGatewayUrl?: string;
  bobGatewayUrl?: string;
  peerAssistantId?: string;
}) {
  const aliceGw = params?.aliceGatewayUrl ?? ALICE_GATEWAY_URL;
  const bobGw = params?.bobGatewayUrl ?? BOB_GATEWAY_URL;
  const peerId = params?.peerAssistantId ?? 'bob-assistant-001';

  // Step 1: Alice generates an invite
  const inviteResult = generateInvite({ gatewayUrl: aliceGw });
  if (!inviteResult.ok) throw new Error(`generateInvite failed: ${inviteResult.reason}`);

  // Step 2: Bob redeems the invite (decodes it to get the token)
  const decoded = decodeInviteCode(inviteResult.inviteCode);
  if (!decoded) throw new Error('decodeInviteCode returned null');

  // Step 3: Bob initiates a connection request
  const initResult = initiateConnection({
    peerGatewayUrl: bobGw,
    peerAssistantId: peerId,
    inviteToken: decoded.t,
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: ['message'],
  });
  if (!initResult.ok) throw new Error(`initiateConnection failed: ${initResult.reason}`);

  // Step 4: Alice approves the connection (guardian decision)
  const approveResult = approveConnection({
    connectionId: initResult.connectionId,
    decision: 'approve',
  });
  if (!approveResult.ok) throw new Error(`approveConnection failed: ${(approveResult as { reason: string }).reason}`);

  const verificationCode = (approveResult as { ok: true; verificationCode: string }).verificationCode;

  // Step 5: Bob submits the verification code (IRL code exchange)
  const peerIdentity = peerId;
  const verifyResult = submitVerificationCode({
    connectionId: initResult.connectionId,
    code: verificationCode,
    peerIdentity,
  });
  if (!verifyResult.ok) throw new Error(`submitVerificationCode failed: ${verifyResult.reason}`);

  return {
    connectionId: initResult.connectionId,
    verificationCode,
    connection: (verifyResult as { ok: true; connection: unknown }).connection,
  };
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('A2A E2E Integration', () => {
  beforeEach(() => {
    resetTables();
    resetMocks();
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

  // =========================================================================
  // 1. Happy path: full lifecycle
  // =========================================================================

  describe('happy path: invite -> redeem -> connect -> approve -> verify -> active -> message', () => {
    test('complete lifecycle produces an active connection and allows messaging', async () => {
      // -- Step 1: Alice generates an invite --
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      expect(inviteResult.ok).toBe(true);
      if (!inviteResult.ok) return;

      // Verify the invite code can be decoded
      const decoded = decodeInviteCode(inviteResult.inviteCode);
      expect(decoded).not.toBeNull();
      expect(decoded!.g).toBe(ALICE_GATEWAY_URL);
      expect(decoded!.v).toBe(A2A_PROTOCOL_VERSION);

      // -- Step 2: Bob redeems the invite --
      const redeemResult = redeemInvite({ inviteCode: inviteResult.inviteCode });
      expect(redeemResult.ok).toBe(true);
      if (!redeemResult.ok) return;
      expect(redeemResult.peerGatewayUrl).toBe(ALICE_GATEWAY_URL);

      // -- Step 3: Bob initiates a connection request --
      const initResult = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        peerAssistantId: 'bob-assistant-001',
        inviteToken: decoded!.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: ['message'],
      });
      expect(initResult.ok).toBe(true);
      if (!initResult.ok) return;

      // Verify connection is pending
      const pendingConn = getConnection(initResult.connectionId);
      expect(pendingConn).not.toBeNull();
      expect(pendingConn!.status).toBe('pending');
      expect(pendingConn!.peerGatewayUrl).toBe(BOB_GATEWAY_URL);
      expect(pendingConn!.peerAssistantId).toBe('bob-assistant-001');

      // Verify connection_requested notification was emitted
      const requestedSignal = emittedSignals.find(
        (s) => s.sourceEventName === 'a2a.connection_requested',
      );
      expect(requestedSignal).toBeDefined();

      // -- Step 4: Alice's guardian approves --
      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      expect(approveResult.ok).toBe(true);
      if (!approveResult.ok) return;

      const verificationCode = (approveResult as { ok: true; verificationCode: string }).verificationCode;
      expect(verificationCode).toMatch(/^\d{6}$/);

      // Verify approval and code-ready notifications
      const approvedSignal = emittedSignals.find(
        (s) => s.sourceEventName === 'a2a.connection_approved',
      );
      expect(approvedSignal).toBeDefined();
      const codeReadySignal = emittedSignals.find(
        (s) => s.sourceEventName === 'a2a.verification_code_ready',
      );
      expect(codeReadySignal).toBeDefined();

      // -- Step 5: Bob submits the IRL verification code --
      const verifyResult = submitVerificationCode({
        connectionId: initResult.connectionId,
        code: verificationCode,
        peerIdentity: 'bob-assistant-001',
      });
      expect(verifyResult.ok).toBe(true);
      if (!verifyResult.ok) return;

      // Verify connection is now active with credentials
      const activeConn = getConnection(initResult.connectionId);
      expect(activeConn).not.toBeNull();
      expect(activeConn!.status).toBe('active');
      expect(activeConn!.outboundCredentialHash).toBeTruthy();
      expect(activeConn!.inboundCredentialHash).toBeTruthy();
      expect(activeConn!.outboundCredential).toBeTruthy();
      expect(activeConn!.inboundCredential).toBeTruthy();

      // Verify connection_established notification
      const establishedSignal = emittedSignals.find(
        (s) => s.sourceEventName === 'a2a.connection_established',
      );
      expect(establishedSignal).toBeDefined();

      // -- Step 6: Send a message --
      const sendResult = await sendMessage({
        connectionId: initResult.connectionId,
        content: { type: 'text', text: 'Hello from Alice!' },
      });
      expect(sendResult.ok).toBe(true);
      if (!sendResult.ok) return;
      expect(sendResult.messageId).toBeTruthy();
      expect(sendResult.conversationId).toBeTruthy();

      // Verify the outbound delivery adapter was called
      expect(deliveredMessages.length).toBe(1);
      expect(deliveredMessages[0].connectionId).toBe(initResult.connectionId);
    });

    test('listConnections returns the active connection', () => {
      const { connectionId } = fullHandshakeToActive();

      const list = listConnectionsFiltered({ status: 'active' });
      expect(list.connections.length).toBe(1);
      expect(list.connections[0].id).toBe(connectionId);
    });
  });

  // =========================================================================
  // 2. Malformed invite
  // =========================================================================

  describe('malformed invite', () => {
    test('redeemInvite rejects garbage invite code', () => {
      const result = redeemInvite({ inviteCode: '!!!garbage-not-base64!!!' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('malformed_invite');
      }
    });

    test('redeemInvite rejects valid base64 but invalid payload', () => {
      const code = Buffer.from('just a string').toString('base64url');
      const result = redeemInvite({ inviteCode: code });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('malformed_invite');
      }
    });

    test('redeemInvite rejects base64 JSON with missing fields', () => {
      const code = Buffer.from(JSON.stringify({ g: 'url-only' })).toString('base64url');
      const result = redeemInvite({ inviteCode: code });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('malformed_invite');
      }
    });
  });

  // =========================================================================
  // 3. Expired invite
  // =========================================================================

  describe('expired invite', () => {
    test('redeemInvite rejects expired invite', async () => {
      // Generate with a very short TTL so it expires immediately
      const inviteResult = generateInvite({
        gatewayUrl: ALICE_GATEWAY_URL,
        expiresInMs: 1, // 1ms TTL
      });
      expect(inviteResult.ok).toBe(true);
      if (!inviteResult.ok) return;

      // Wait to ensure the 1ms TTL has elapsed — without this, execution
      // may stay within the same millisecond and the invite remains valid.
      await Bun.sleep(5);

      const result = redeemInvite({ inviteCode: inviteResult.inviteCode });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_or_expired');
      }
    });

    test('initiateConnection rejects expired invite token', async () => {
      const inviteResult = generateInvite({
        gatewayUrl: ALICE_GATEWAY_URL,
        expiresInMs: 1,
      });
      expect(inviteResult.ok).toBe(true);
      if (!inviteResult.ok) return;

      // Wait to ensure the 1ms TTL has elapsed — without this, execution
      // may stay within the same millisecond and the invite remains valid.
      await Bun.sleep(5);

      const decoded = decodeInviteCode(inviteResult.inviteCode);
      expect(decoded).not.toBeNull();

      const result = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        inviteToken: decoded!.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invite_not_found');
      }
    });
  });

  // =========================================================================
  // 4. Bad verification code
  // =========================================================================

  describe('bad verification code', () => {
    test('submitVerificationCode rejects wrong code', () => {
      // Walk through to the approval step
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;
      const initResult = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        peerAssistantId: 'bob-001',
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      if (!initResult.ok) throw new Error('init failed');

      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      if (!approveResult.ok) throw new Error('approve failed');

      // Submit the wrong code
      const verifyResult = submitVerificationCode({
        connectionId: initResult.connectionId,
        code: '000000',
        peerIdentity: 'bob-001',
      });
      expect(verifyResult.ok).toBe(false);
      if (!verifyResult.ok) {
        expect(verifyResult.reason).toBe('invalid_code');
      }

      // Connection should still be pending — not active
      const conn = getConnection(initResult.connectionId);
      expect(conn!.status).toBe('pending');
    });
  });

  // =========================================================================
  // 5. Expired verification code
  // =========================================================================

  describe('expired verification code', () => {
    test('submitVerificationCode rejects code after session expires', () => {
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;
      const initResult = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        peerAssistantId: 'bob-001',
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      if (!initResult.ok) throw new Error('init failed');

      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      if (!approveResult.ok) throw new Error('approve failed');
      const verificationCode = (approveResult as { ok: true; verificationCode: string }).verificationCode;

      // Manually expire the handshake session by manipulating its expiresAt.
      // The handshake session is stored in-memory inside the connection service.
      // We cannot directly access it, but we can test by using the actual TTL
      // mechanism: the verification code TTL is 5 minutes. Instead of waiting,
      // we submit the code after resetting the handshake sessions (simulating
      // expiry/session loss).
      _resetHandshakeSessions();

      const verifyResult = submitVerificationCode({
        connectionId: initResult.connectionId,
        code: verificationCode,
        peerIdentity: 'bob-001',
      });
      expect(verifyResult.ok).toBe(false);
      if (!verifyResult.ok) {
        // Session no longer exists, so it returns not_found
        expect(verifyResult.reason).toBe('not_found');
      }
    });
  });

  // =========================================================================
  // 6. Replayed code (submit same valid code twice)
  // =========================================================================

  describe('replayed verification code', () => {
    test('second submission of valid code is rejected', () => {
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;
      const initResult = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        peerAssistantId: 'bob-001',
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      if (!initResult.ok) throw new Error('init failed');

      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      if (!approveResult.ok) throw new Error('approve failed');
      const verificationCode = (approveResult as { ok: true; verificationCode: string }).verificationCode;

      // First submission — should succeed
      const firstResult = submitVerificationCode({
        connectionId: initResult.connectionId,
        code: verificationCode,
        peerIdentity: 'bob-001',
      });
      expect(firstResult.ok).toBe(true);

      // Second submission — should be rejected (connection already active,
      // handshake session cleaned up)
      const secondResult = submitVerificationCode({
        connectionId: initResult.connectionId,
        code: verificationCode,
        peerIdentity: 'bob-001',
      });
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) {
        // Connection is already active so the session is gone
        expect(['not_found', 'invalid_state']).toContain(secondResult.reason);
      }
    });
  });

  // =========================================================================
  // 7. Revoked connection — message rejected
  // =========================================================================

  describe('revoked connection', () => {
    test('sendMessage rejected after connection is revoked', async () => {
      const { connectionId } = fullHandshakeToActive();

      // Revoke the connection
      const revokeResult = await revokeConnection({ connectionId });
      expect(revokeResult.ok).toBe(true);

      // Attempt to send a message — should be rejected
      const sendResult = await sendMessage({
        connectionId,
        content: { type: 'text', text: 'This should fail' },
      });
      expect(sendResult.ok).toBe(false);
      if (!sendResult.ok) {
        expect(sendResult.reason).toBe('not_active');
      }
    });

    test('revocation emits connection_revoked notification', async () => {
      const { connectionId } = fullHandshakeToActive();
      emittedSignals.length = 0; // Clear signals from setup

      await revokeConnection({ connectionId });

      const revokedSignal = emittedSignals.find(
        (s) => s.sourceEventName === 'a2a.connection_revoked',
      );
      expect(revokedSignal).toBeDefined();
      expect(revokedSignal!.contextPayload.connectionId).toBe(connectionId);
    });
  });

  // =========================================================================
  // 8. Stale/duplicate decision handling
  // =========================================================================

  describe('stale/duplicate decision handling', () => {
    test('approving an already-approved connection is rejected', () => {
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;
      const initResult = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        peerAssistantId: 'bob-001',
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      if (!initResult.ok) throw new Error('init failed');

      // First approval
      const firstApprove = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      expect(firstApprove.ok).toBe(true);

      // Complete the handshake to move to active
      const verificationCode = (firstApprove as { ok: true; verificationCode: string }).verificationCode;
      submitVerificationCode({
        connectionId: initResult.connectionId,
        code: verificationCode,
        peerIdentity: 'bob-001',
      });

      // Second approval — already resolved
      const secondApprove = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      expect(secondApprove.ok).toBe(false);
      if (!secondApprove.ok) {
        expect(secondApprove.reason).toBe('already_resolved');
      }
    });

    test('denying an already-active connection is rejected', () => {
      const { connectionId } = fullHandshakeToActive();

      const denyResult = approveConnection({
        connectionId,
        decision: 'deny',
      });
      expect(denyResult.ok).toBe(false);
      if (!denyResult.ok) {
        expect(denyResult.reason).toBe('already_resolved');
      }
    });

    test('double revocation is idempotent', async () => {
      const { connectionId } = fullHandshakeToActive();

      const first = await revokeConnection({ connectionId });
      expect(first.ok).toBe(true);

      const second = await revokeConnection({ connectionId });
      expect(second.ok).toBe(true);
    });
  });

  // =========================================================================
  // 10. Surface-agnosticism — service methods work directly
  // =========================================================================

  describe('surface-agnosticism', () => {
    test('all service methods work when called directly (no HTTP layer)', async () => {
      // This test IS the surface-agnosticism proof — every call in the happy
      // path above goes through service methods, not HTTP endpoints.
      const { connectionId } = fullHandshakeToActive();

      // Message sending via direct service call
      const sendResult = await sendMessage({
        connectionId,
        content: { type: 'text', text: 'Direct service call' },
      });
      expect(sendResult.ok).toBe(true);

      // List connections via direct service call
      const list = listConnectionsFiltered({ status: 'active' });
      expect(list.connections.length).toBe(1);

      // Revocation via direct service call
      const revokeResult = await revokeConnection({ connectionId });
      expect(revokeResult.ok).toBe(true);

      const afterRevoke = listConnectionsFiltered({ status: 'active' });
      expect(afterRevoke.connections.length).toBe(0);
    });
  });

  // =========================================================================
  // 11. Revocation propagation
  // =========================================================================

  describe('revocation propagation', () => {
    test('revokeConnection tombstones local credentials', async () => {
      const { connectionId } = fullHandshakeToActive();

      // Verify credentials exist before revocation
      const before = getConnection(connectionId);
      expect(before!.outboundCredential).toBeTruthy();
      expect(before!.inboundCredential).toBeTruthy();

      await revokeConnection({ connectionId });

      const after = getConnection(connectionId);
      // Inbound credential is tombstoned immediately
      expect(after!.inboundCredentialHash).toBe('');
      expect(after!.inboundCredential).toBe('');
      // Outbound is also tombstoned when delivery succeeds
      expect(after!.outboundCredentialHash).toBe('');
      expect(after!.outboundCredential).toBe('');
    });

    test('revokeConnection attempts peer notification delivery', async () => {
      const { connectionId } = fullHandshakeToActive();
      revocationDeliveries.length = 0;

      await revokeConnection({ connectionId });

      expect(revocationDeliveries.length).toBe(1);
      expect(revocationDeliveries[0].connectionId).toBe(connectionId);
      expect(revocationDeliveries[0].peerGatewayUrl).toBe(BOB_GATEWAY_URL);
    });

    test('revokeConnection marks as revocation_pending when peer unreachable', async () => {
      const { connectionId } = fullHandshakeToActive();
      revocationDeliveryShouldSucceed = false;

      const result = await revokeConnection({ connectionId });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe('revocation_pending');
      }

      const conn = getConnection(connectionId);
      expect(conn!.status).toBe('revocation_pending');

      // Outbound credential should be preserved for sweep retries
      expect(conn!.outboundCredential).toBeTruthy();
    });

    test('handlePeerRevocationNotification transitions to revoked_by_peer', () => {
      const { connectionId } = fullHandshakeToActive();

      const result = handlePeerRevocationNotification({ connectionId });
      expect(result.ok).toBe(true);

      const conn = getConnection(connectionId);
      expect(conn!.status).toBe('revoked_by_peer');
      // Credentials should be tombstoned
      expect(conn!.outboundCredentialHash).toBe('');
      expect(conn!.inboundCredentialHash).toBe('');
    });

    test('handlePeerRevocationNotification is idempotent', () => {
      const { connectionId } = fullHandshakeToActive();

      const first = handlePeerRevocationNotification({ connectionId });
      expect(first.ok).toBe(true);

      const second = handlePeerRevocationNotification({ connectionId });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.reason).toBe('already_revoked');
      }
    });
  });

  // =========================================================================
  // 12. Post-revoke reconnection
  // =========================================================================

  describe('post-revoke reconnection', () => {
    test('after revoking, a new invite is required to reconnect', async () => {
      // Establish and revoke
      const { connectionId } = fullHandshakeToActive();
      await revokeConnection({ connectionId });

      // Verify the old connection is revoked
      const old = getConnection(connectionId);
      expect(old!.status).toBe('revoked');

      // A fresh invite + handshake cycle should work to create a NEW connection
      const newInvite = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      expect(newInvite.ok).toBe(true);
      if (!newInvite.ok) return;

      const decoded = decodeInviteCode(newInvite.inviteCode)!;
      const initResult = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        peerAssistantId: 'bob-assistant-001',
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: ['message'],
      });
      expect(initResult.ok).toBe(true);
      if (!initResult.ok) return;

      // The new connection is a different connection ID
      expect(initResult.connectionId).not.toBe(connectionId);

      // Complete the handshake
      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      expect(approveResult.ok).toBe(true);

      const verificationCode = (approveResult as { ok: true; verificationCode: string }).verificationCode;
      const verifyResult = submitVerificationCode({
        connectionId: initResult.connectionId,
        code: verificationCode,
        peerIdentity: 'bob-assistant-001',
      });
      expect(verifyResult.ok).toBe(true);

      // New connection is active
      const newConn = getConnection(initResult.connectionId);
      expect(newConn!.status).toBe('active');

      // Old connection is still revoked
      const oldConn = getConnection(connectionId);
      expect(oldConn!.status).toBe('revoked');
    });

    test('trying to reuse a consumed invite token fails', () => {
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;

      // First use — succeeds
      const first = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      expect(first.ok).toBe(true);

      // Second use — invite already consumed
      const second = initiateConnection({
        peerGatewayUrl: 'https://mallory.example.com',
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.reason).toBe('invite_consumed');
      }
    });
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  describe('additional edge cases', () => {
    test('initiateConnection rejects incompatible protocol version', () => {
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;

      const result = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        inviteToken: decoded.t,
        protocolVersion: '99.0.0',
        capabilities: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('version_mismatch');
      }
    });

    test('initiateConnection rejects self-loop to own gateway', () => {
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;

      // Attempt to connect to own gateway
      const result = initiateConnection({
        peerGatewayUrl: ALICE_GATEWAY_URL,
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
        ownGatewayUrl: ALICE_GATEWAY_URL,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_target');
      }
    });

    test('deny decision revokes connection and cleans up', () => {
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;
      const initResult = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        peerAssistantId: 'bob-001',
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      if (!initResult.ok) throw new Error('init failed');

      const denyResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'deny',
      });
      expect(denyResult.ok).toBe(true);

      const conn = getConnection(initResult.connectionId);
      expect(conn!.status).toBe('revoked');

      // Verify denial notification was emitted
      const deniedSignal = emittedSignals.find(
        (s) => s.sourceEventName === 'a2a.connection_denied',
      );
      expect(deniedSignal).toBeDefined();
    });

    test('sendMessage handles delivery failure gracefully', async () => {
      const { connectionId } = fullHandshakeToActive();

      deliverMessageShouldSucceed = false;

      const result = await sendMessage({
        connectionId,
        content: { type: 'text', text: 'Will fail to deliver' },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('delivery_failed');
      }
    });

    test('idempotent invite generation with same key returns same result', () => {
      const first = generateInvite({
        gatewayUrl: ALICE_GATEWAY_URL,
        idempotencyKey: 'test-key-123',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = generateInvite({
        gatewayUrl: ALICE_GATEWAY_URL,
        idempotencyKey: 'test-key-123',
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.inviteCode).toBe(first.inviteCode);
      expect(second.inviteId).toBe(first.inviteId);
    });

    test('notification signals flow for complete lifecycle', async () => {
      emittedSignals.length = 0;

      const { connectionId } = fullHandshakeToActive();

      // Collect the event names emitted during the handshake
      const handshakeEventNames = emittedSignals.map((s) => s.sourceEventName);

      // Should have: connection_requested, connection_approved,
      // verification_code_ready, connection_established
      expect(handshakeEventNames).toContain('a2a.connection_requested');
      expect(handshakeEventNames).toContain('a2a.connection_approved');
      expect(handshakeEventNames).toContain('a2a.verification_code_ready');
      expect(handshakeEventNames).toContain('a2a.connection_established');

      // Now revoke and check
      await revokeConnection({ connectionId });
      const allEventNames = emittedSignals.map((s) => s.sourceEventName);
      expect(allEventNames).toContain('a2a.connection_revoked');
    });

    test('multiple concurrent connections can coexist', () => {
      // First connection: Alice <-> Bob
      const conn1 = fullHandshakeToActive({
        bobGatewayUrl: 'https://bob.example.com',
        peerAssistantId: 'bob-001',
      });

      // Second connection: Alice <-> Charlie
      const conn2 = fullHandshakeToActive({
        bobGatewayUrl: 'https://charlie.example.com',
        peerAssistantId: 'charlie-001',
      });

      expect(conn1.connectionId).not.toBe(conn2.connectionId);

      const list = listConnectionsFiltered({ status: 'active' });
      expect(list.connections.length).toBe(2);

      // Both connections are independently active
      const c1 = getConnection(conn1.connectionId);
      const c2 = getConnection(conn2.connectionId);
      expect(c1!.status).toBe('active');
      expect(c2!.status).toBe('active');
    });

    test('identity mismatch in verification code submission', () => {
      const inviteResult = generateInvite({ gatewayUrl: ALICE_GATEWAY_URL });
      if (!inviteResult.ok) throw new Error('invite gen failed');

      const decoded = decodeInviteCode(inviteResult.inviteCode)!;
      const initResult = initiateConnection({
        peerGatewayUrl: BOB_GATEWAY_URL,
        peerAssistantId: 'bob-001',
        inviteToken: decoded.t,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: [],
      });
      if (!initResult.ok) throw new Error('init failed');

      const approveResult = approveConnection({
        connectionId: initResult.connectionId,
        decision: 'approve',
      });
      if (!approveResult.ok) throw new Error('approve failed');

      const verificationCode = (approveResult as { ok: true; verificationCode: string }).verificationCode;

      // Submit with a different peer identity — anti-hijack check
      const result = submitVerificationCode({
        connectionId: initResult.connectionId,
        code: verificationCode,
        peerIdentity: 'mallory-evil-001',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('identity_mismatch');
      }
    });
  });
});

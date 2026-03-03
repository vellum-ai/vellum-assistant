import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-outbound-delivery-test-'));

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
const emittedSignals: Array<{ sourceEventName: string; contextPayload: unknown }> = [];
mock.module('../../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async (params: { sourceEventName: string; contextPayload: unknown }) => {
    emittedSignals.push({ sourceEventName: params.sourceEventName, contextPayload: params.contextPayload });
    return { signalId: 'test-signal', deduplicated: false, dispatched: true, reason: 'ok', deliveryResults: [] };
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  createConnection,
  getConnection,
  updateConnectionCredentials,
  updateConnectionStatus,
} from '../a2a-peer-connection-store.js';
import { generateCredentialPair } from '../a2a-peer-auth.js';
import {
  sendMessage,
  _resetHandshakeSessions,
  _resetIdempotencyStore,
  A2A_SOURCE_CHANNEL,
} from '../a2a-connection-service.js';
import { deliverMessage, MAX_RETRIES } from '../a2a-outbound-delivery.js';
import { createTextMessage } from '../a2a-message-schema.js';
import { getDb, initializeDb, resetDb } from '../../memory/db.js';
import { getBindingByChannelChat } from '../../memory/external-conversation-store.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
  db.run('DELETE FROM assistant_ingress_invites');
  db.run('DELETE FROM external_conversation_bindings');
}

/** Create an active connection with valid credentials for testing. */
function createActiveConnection(overrides?: { peerGatewayUrl?: string }) {
  const credentials = generateCredentialPair();
  const conn = createConnection({
    peerGatewayUrl: overrides?.peerGatewayUrl ?? 'https://peer.example.com',
    peerAssistantId: 'peer-001',
    status: 'active',
  });
  updateConnectionCredentials(conn.id, {
    outboundCredentialHash: credentials.outboundCredentialHash,
    outboundCredential: credentials.outboundCredential,
    inboundCredentialHash: credentials.inboundCredentialHash,
    inboundCredential: credentials.inboundCredential,
  });
  return { connection: getConnection(conn.id)!, credentials };
}

describe('a2a-outbound-delivery', () => {
  beforeEach(() => {
    resetTables();
    _resetHandshakeSessions();
    _resetIdempotencyStore();
    emittedSignals.length = 0;
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
  // sendMessage — connection validation
  // ========================================================================

  describe('sendMessage connection validation', () => {
    test('returns not_found for missing connection', async () => {


      const result = await sendMessage({
        connectionId: 'nonexistent-id',
        content: { type: 'text', text: 'hello' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    test('returns not_active for pending connection', async () => {

      const conn = createConnection({
        peerGatewayUrl: 'https://peer.example.com',
        status: 'pending',
      });

      const result = await sendMessage({
        connectionId: conn.id,
        content: { type: 'text', text: 'hello' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_active');
      }
    });

    test('returns not_active for revoked connection', async () => {

      const conn = createConnection({
        peerGatewayUrl: 'https://peer.example.com',
        status: 'active',
      });
      updateConnectionStatus(conn.id, 'revoked');

      const result = await sendMessage({
        connectionId: conn.id,
        content: { type: 'text', text: 'hello' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_active');
      }
    });

    test('returns no_credential when outbound credential is missing', async () => {

      const conn = createConnection({
        peerGatewayUrl: 'https://peer.example.com',
        status: 'active',
      });

      const result = await sendMessage({
        connectionId: conn.id,
        content: { type: 'text', text: 'hello' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('no_credential');
      }
    });
  });

  // ========================================================================
  // sendMessage — conversation binding
  // ========================================================================

  describe('sendMessage conversation binding', () => {
    test('creates external conversation binding on first send', async () => {

      const { connection } = createActiveConnection();

      // Verify no binding exists before send
      const bindingBefore = getBindingByChannelChat(A2A_SOURCE_CHANNEL, connection.id);
      expect(bindingBefore).toBeNull();

      // Send will fail at delivery but should create the binding
      await sendMessage({
        connectionId: connection.id,
        content: { type: 'text', text: 'hello' },
      });

      const bindingAfter = getBindingByChannelChat(A2A_SOURCE_CHANNEL, connection.id);
      expect(bindingAfter).not.toBeNull();
      expect(bindingAfter!.sourceChannel).toBe(A2A_SOURCE_CHANNEL);
      expect(bindingAfter!.externalChatId).toBe(connection.id);
    });
  });

  // ========================================================================
  // deliverMessage — URL validation
  // ========================================================================

  describe('deliverMessage URL validation', () => {
    test('rejects HTTP for public target', async () => {
      const envelope = createTextMessage({
        connectionId: 'conn-001',
        senderAssistantId: 'self',
        text: 'hello',
      });

      const result = await deliverMessage({
        envelope,
        peerGatewayUrl: 'http://public.example.com',
        outboundCredential: 'test-credential',
        connectionId: 'conn-001',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('target_validation_failed');
      }
    });

    test('allows HTTPS for public target (fails at network level)', async () => {
      const envelope = createTextMessage({
        connectionId: 'conn-001',
        senderAssistantId: 'self',
        text: 'hello',
      });

      const result = await deliverMessage({
        envelope,
        peerGatewayUrl: 'https://peer.example.com',
        outboundCredential: 'test-credential',
        connectionId: 'conn-001',
      });

      // Should pass URL validation but fail at delivery (no actual server)
      if (!result.ok) {
        expect(result.reason).toBe('delivery_failed');
      }
    });
  });

  // ========================================================================
  // deliverMessage — dead-letter emission
  // ========================================================================

  describe('deliverMessage dead-letter', () => {
    test('emits message_failed event after exhausting retries', async () => {
      const envelope = createTextMessage({
        connectionId: 'conn-dead-letter',
        senderAssistantId: 'self',
        text: 'hello',
      });

      const result = await deliverMessage({
        envelope,
        peerGatewayUrl: 'https://peer.example.com',
        outboundCredential: 'test-credential',
        connectionId: 'conn-dead-letter',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('delivery_failed');
      }

      // Check that a message_failed notification was emitted
      const failedSignal = emittedSignals.find(
        s => s.sourceEventName === 'a2a.message_failed',
      );
      expect(failedSignal).toBeDefined();
      const payload = failedSignal!.contextPayload as { connectionId: string; messageId: string };
      expect(payload.connectionId).toBe('conn-dead-letter');
      expect(payload.messageId).toBe(envelope.messageId);
    });
  });

  // ========================================================================
  // Message construction
  // ========================================================================

  describe('message construction', () => {
    test('createTextMessage produces valid envelope', () => {
      const envelope = createTextMessage({
        connectionId: 'conn-001',
        senderAssistantId: 'self',
        text: 'hello world',
      });

      expect(envelope.messageId).toBeDefined();
      expect(envelope.connectionId).toBe('conn-001');
      expect(envelope.senderAssistantId).toBe('self');
      expect(envelope.content.type).toBe('text');
      if (envelope.content.type === 'text') {
        expect(envelope.content.text).toBe('hello world');
      }
      expect(envelope.nonce).toBeDefined();
      expect(envelope.status).toBe('pending');
    });

    test('createTextMessage with delivery metadata', () => {
      const envelope = createTextMessage({
        connectionId: 'conn-001',
        senderAssistantId: 'self',
        text: 'reply',
        delivery: { correlationId: 'orig-msg-001' },
      });

      expect(envelope.delivery).toBeDefined();
      expect(envelope.delivery!.correlationId).toBe('orig-msg-001');
    });
  });
});

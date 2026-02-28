/**
 * Tests for the non-member access request notification flow.
 *
 * When a non-member messages the assistant on a channel, the system should:
 * 1. Deny the message with the standard rejection reply
 * 2. Notify the guardian (if a guardian binding exists)
 * 3. Create a guardian approval request for the access request
 * 4. Deduplicate: don't create duplicate requests for repeated messages
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'non-member-access-request-test-'));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  readHttpToken: () => 'test-bearer-token',
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// Mock security check to always pass
mock.module('../security/secret-ingress.js', () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

// Mock ingress member store: findMember always returns null (non-member),
// updateLastSeen is a no-op.
mock.module('../memory/ingress-member-store.js', () => ({
  findMember: () => null,
  updateLastSeen: () => {},
  upsertMember: () => {},
}));

mock.module('../config/env.js', () => ({
  getGatewayInternalBaseUrl: () => 'http://127.0.0.1:7830',
}));

// Track emitNotificationSignal calls
const emitSignalCalls: Array<Record<string, unknown>> = [];
let mockEmitResult: {
  signalId: string;
  deduplicated: boolean;
  dispatched: boolean;
  reason: string;
  deliveryResults: Array<Record<string, unknown>>;
} = {
  signalId: 'mock-signal-id',
  deduplicated: false,
  dispatched: true,
  reason: 'mock',
  deliveryResults: [],
};
mock.module('../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return mockEmitResult;
  },
}));

// Track deliverChannelReply calls
const deliverReplyCalls: Array<{ url: string; payload: Record<string, unknown> }> = [];
mock.module('../runtime/gateway-client.js', () => ({
  deliverChannelReply: async (url: string, payload: Record<string, unknown>) => {
    deliverReplyCalls.push({ url, payload });
  },
}));

import {
  listCanonicalGuardianDeliveries,
  listCanonicalGuardianRequests,
} from '../memory/canonical-guardian-store.js';
import {
  createBinding,
} from '../memory/channel-guardian-store.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { notifyGuardianOfAccessRequest } from '../runtime/access-request-helper.js';
import { handleChannelInbound } from '../runtime/routes/channel-routes.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BEARER_TOKEN = 'test-token';

function resetState(): void {
  const db = getDb();
  db.run('DELETE FROM channel_guardian_approval_requests');
  db.run('DELETE FROM channel_guardian_bindings');
  db.run('DELETE FROM channel_inbound_events');
  db.run('DELETE FROM conversations');
  db.run('DELETE FROM notification_events');
  db.run('DELETE FROM canonical_guardian_requests');
  db.run('DELETE FROM canonical_guardian_deliveries');
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
  mockEmitResult = {
    signalId: 'mock-signal-id',
    deduplicated: false,
    dispatched: true,
    reason: 'mock',
    deliveryResults: [],
  };
}

async function flushAsyncAccessRequestBookkeeping(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildInboundRequest(overrides: Record<string, unknown> = {}): Request {
  const body: Record<string, unknown> = {
    sourceChannel: 'telegram',
    interface: 'telegram',
    externalChatId: 'chat-123',
    externalMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: 'Hello, can I use this assistant?',
    senderExternalUserId: 'user-unknown-456',
    senderName: 'Alice Unknown',
    senderUsername: 'alice_unknown',
    replyCallbackUrl: 'http://localhost:7830/deliver/telegram',
    ...overrides,
  };

  return new Request('http://localhost:8080/channels/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gateway-Origin': TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('non-member access request notification', () => {
  beforeEach(() => {
    resetState();
  });

  test('non-member message is denied with rejection reply', async () => {
    const req = buildInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = await resp.json() as Record<string, unknown>;

    expect(json.denied).toBe(true);
    expect(json.reason).toBe('not_a_member');

    // Rejection reply was delivered — always-notify behavior means the reply
    // indicates the guardian will be notified, even without a same-channel binding.
    expect(deliverReplyCalls.length).toBe(1);
    expect((deliverReplyCalls[0].payload as Record<string, unknown>).text).toContain("let them know");
  });

  test('guardian is notified when a non-member messages and a guardian binding exists', async () => {
    // Set up a guardian binding for this channel
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-789',
      guardianDeliveryChatId: 'guardian-chat-789',
    });

    const req = buildInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = await resp.json() as Record<string, unknown>;

    // Message is still denied
    expect(json.denied).toBe(true);
    expect(json.reason).toBe('not_a_member');

    // Rejection reply was delivered
    expect(deliverReplyCalls.length).toBe(1);

    // A notification signal was emitted
    expect(emitSignalCalls.length).toBe(1);
    expect(emitSignalCalls[0].sourceEventName).toBe('ingress.access_request');
    expect(emitSignalCalls[0].sourceChannel).toBe('telegram');
    const payload = emitSignalCalls[0].contextPayload as Record<string, unknown>;
    expect(payload.senderExternalUserId).toBe('user-unknown-456');
    expect(payload.senderName).toBe('Alice Unknown');

    // A canonical access request was created
    const pending = listCanonicalGuardianRequests({
      status: 'pending',
      requesterExternalUserId: 'user-unknown-456',
      sourceChannel: 'telegram',
      kind: 'access_request',
    });
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe('pending');
    expect(pending[0].requesterExternalUserId).toBe('user-unknown-456');
    expect(pending[0].guardianExternalUserId).toBe('guardian-user-789');
    expect(pending[0].toolName).toBe('ingress_access_request');
  });

  test('no duplicate approval requests for repeated messages from same non-member', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-789',
      guardianDeliveryChatId: 'guardian-chat-789',
    });

    // First message
    const req1 = buildInboundRequest();
    await handleChannelInbound(req1, undefined, TEST_BEARER_TOKEN);

    // Second message from the same user
    const req2 = buildInboundRequest({
      externalMessageId: `msg-second-${Date.now()}`,
      content: 'Please let me in!',
    });
    await handleChannelInbound(req2, undefined, TEST_BEARER_TOKEN);

    // Both messages should be denied with rejection replies
    expect(deliverReplyCalls.length).toBe(2);

    // Only one notification signal should be emitted (second is deduplicated)
    expect(emitSignalCalls.length).toBe(1);

    // Only one canonical request should exist
    const pending = listCanonicalGuardianRequests({
      status: 'pending',
      requesterExternalUserId: 'user-unknown-456',
      sourceChannel: 'telegram',
      kind: 'access_request',
    });
    expect(pending.length).toBe(1);
  });

  test('access request is created and signal emitted even without same-channel guardian binding', async () => {
    // No guardian binding on any channel — access request should still be
    // created and notification signal emitted (null guardianExternalUserId).
    const req = buildInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = await resp.json() as Record<string, unknown>;

    expect(json.denied).toBe(true);
    expect(json.reason).toBe('not_a_member');

    // Rejection reply indicates guardian was notified
    expect(deliverReplyCalls.length).toBe(1);
    expect((deliverReplyCalls[0].payload as Record<string, unknown>).text).toContain("let them know");

    // Notification signal was emitted
    expect(emitSignalCalls.length).toBe(1);
    expect(emitSignalCalls[0].sourceEventName).toBe('ingress.access_request');

    // Canonical request was created with null guardianExternalUserId
    const pending = listCanonicalGuardianRequests({
      status: 'pending',
      requesterExternalUserId: 'user-unknown-456',
      sourceChannel: 'telegram',
      kind: 'access_request',
    });
    expect(pending.length).toBe(1);
    expect(pending[0].guardianExternalUserId).toBeNull();
  });

  test('cross-channel fallback: SMS guardian binding resolves for Telegram access request', async () => {
    // Only an SMS guardian binding exists — no Telegram binding
    createBinding({
      assistantId: 'self',
      channel: 'sms',
      guardianExternalUserId: 'guardian-sms-user',
      guardianDeliveryChatId: 'guardian-sms-chat',
    });

    const req = buildInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = await resp.json() as Record<string, unknown>;

    expect(json.denied).toBe(true);
    expect(json.reason).toBe('not_a_member');

    // Notification signal emitted
    expect(emitSignalCalls.length).toBe(1);
    const payload = emitSignalCalls[0].contextPayload as Record<string, unknown>;
    expect(payload.guardianBindingChannel).toBe('sms');

    // Canonical request has the SMS guardian's external user ID
    const pending = listCanonicalGuardianRequests({
      status: 'pending',
      requesterExternalUserId: 'user-unknown-456',
      sourceChannel: 'telegram',
      kind: 'access_request',
    });
    expect(pending.length).toBe(1);
    expect(pending[0].guardianExternalUserId).toBe('guardian-sms-user');
  });

  test('no notification when senderExternalUserId is absent', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-789',
      guardianDeliveryChatId: 'guardian-chat-789',
    });

    // Message without senderExternalUserId — can't identify the requester.
    // The ACL check requires senderExternalUserId to look up members,
    // so without it the non-member gate is bypassed entirely.
    const req = buildInboundRequest({
      senderExternalUserId: undefined,
    });
    await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);

    // No access request notification should fire (no identity to notify about)
    expect(emitSignalCalls.length).toBe(0);
  });
});

describe('access-request-helper unit tests', () => {
  beforeEach(() => {
    resetState();
  });

  test('notifyGuardianOfAccessRequest returns no_sender_id when senderExternalUserId is absent', () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: 'self',
      sourceChannel: 'telegram',
      externalChatId: 'chat-123',
      senderExternalUserId: undefined,
    });

    expect(result.notified).toBe(false);
    if (!result.notified) {
      expect(result.reason).toBe('no_sender_id');
    }

    // No canonical request created
    const pending = listCanonicalGuardianRequests({ status: 'pending', kind: 'access_request' });
    expect(pending.length).toBe(0);
  });

  test('notifyGuardianOfAccessRequest creates request with null guardianExternalUserId when no binding exists', () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: 'self',
      sourceChannel: 'telegram',
      externalChatId: 'chat-123',
      senderExternalUserId: 'unknown-user',
      senderName: 'Bob',
    });

    expect(result.notified).toBe(true);
    if (result.notified) {
      expect(result.created).toBe(true);
    }

    const pending = listCanonicalGuardianRequests({
      status: 'pending',
      requesterExternalUserId: 'unknown-user',
      kind: 'access_request',
    });
    expect(pending.length).toBe(1);
    expect(pending[0].guardianExternalUserId).toBeNull();

    // Signal was emitted
    expect(emitSignalCalls.length).toBe(1);
  });

  test('notifyGuardianOfAccessRequest uses cross-channel binding when source-channel binding is missing', () => {
    // Only SMS binding exists
    createBinding({
      assistantId: 'self',
      channel: 'sms',
      guardianExternalUserId: 'guardian-sms',
      guardianDeliveryChatId: 'sms-chat',
    });

    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: 'self',
      sourceChannel: 'telegram',
      externalChatId: 'tg-chat',
      senderExternalUserId: 'unknown-tg-user',
    });

    expect(result.notified).toBe(true);

    const pending = listCanonicalGuardianRequests({
      status: 'pending',
      requesterExternalUserId: 'unknown-tg-user',
      kind: 'access_request',
    });
    expect(pending.length).toBe(1);
    expect(pending[0].guardianExternalUserId).toBe('guardian-sms');

    // Signal payload includes fallback channel
    const payload = emitSignalCalls[0].contextPayload as Record<string, unknown>;
    expect(payload.guardianBindingChannel).toBe('sms');
  });

  test('notifyGuardianOfAccessRequest prefers source-channel binding over cross-channel fallback', () => {
    // Both Telegram and SMS bindings exist
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-tg',
      guardianDeliveryChatId: 'tg-chat',
    });
    createBinding({
      assistantId: 'self',
      channel: 'sms',
      guardianExternalUserId: 'guardian-sms',
      guardianDeliveryChatId: 'sms-chat',
    });

    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: 'self',
      sourceChannel: 'telegram',
      externalChatId: 'chat-123',
      senderExternalUserId: 'unknown-user',
    });

    expect(result.notified).toBe(true);

    const pending = listCanonicalGuardianRequests({
      status: 'pending',
      requesterExternalUserId: 'unknown-user',
      kind: 'access_request',
    });
    expect(pending.length).toBe(1);
    // Should use the Telegram binding, not SMS fallback
    expect(pending[0].guardianExternalUserId).toBe('guardian-tg');

    const payload = emitSignalCalls[0].contextPayload as Record<string, unknown>;
    expect(payload.guardianBindingChannel).toBe('telegram');
  });

  test('notifyGuardianOfAccessRequest for voice channel includes senderName in contextPayload', () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: 'self',
      sourceChannel: 'voice',
      externalChatId: '+15559998888',
      senderExternalUserId: '+15559998888',
      senderName: 'Alice Caller',
    });

    expect(result.notified).toBe(true);
    expect(emitSignalCalls.length).toBe(1);

    const payload = emitSignalCalls[0].contextPayload as Record<string, unknown>;
    expect(payload.sourceChannel).toBe('voice');
    expect(payload.senderName).toBe('Alice Caller');
    expect(payload.senderExternalUserId).toBe('+15559998888');
    expect(payload.senderIdentifier).toBe('Alice Caller');

    // Canonical request should exist
    const pending = listCanonicalGuardianRequests({
      status: 'pending',
      requesterExternalUserId: '+15559998888',
      sourceChannel: 'voice',
      kind: 'access_request',
    });
    expect(pending.length).toBe(1);
  });

  test('notifyGuardianOfAccessRequest includes requestCode in contextPayload', () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: 'self',
      sourceChannel: 'telegram',
      externalChatId: 'chat-123',
      senderExternalUserId: 'unknown-user',
      senderName: 'Test User',
    });

    expect(result.notified).toBe(true);
    expect(emitSignalCalls.length).toBe(1);

    const payload = emitSignalCalls[0].contextPayload as Record<string, unknown>;
    expect(payload.requestCode).toBeDefined();
    expect(typeof payload.requestCode).toBe('string');
    expect((payload.requestCode as string).length).toBe(6);
  });

  test('notifyGuardianOfAccessRequest persists canonical delivery rows from notification results', async () => {
    mockEmitResult = {
      signalId: 'sig-deliveries',
      deduplicated: false,
      dispatched: true,
      reason: 'ok',
      deliveryResults: [
        {
          channel: 'vellum',
          destination: 'vellum',
          status: 'sent',
          conversationId: 'conv-guardian-access-request',
        },
        {
          channel: 'telegram',
          destination: 'guardian-chat-123',
          status: 'sent',
        },
      ],
    };

    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: 'self',
      sourceChannel: 'voice',
      externalChatId: '+15556667777',
      senderExternalUserId: '+15556667777',
      senderName: 'Noah',
    });

    expect(result.notified).toBe(true);
    if (!result.notified) return;

    await flushAsyncAccessRequestBookkeeping();

    const deliveries = listCanonicalGuardianDeliveries(result.requestId);
    const vellum = deliveries.find((d) => d.destinationChannel === 'vellum');
    const telegram = deliveries.find((d) => d.destinationChannel === 'telegram');

    expect(vellum).toBeDefined();
    expect(vellum!.destinationConversationId).toBe('conv-guardian-access-request');
    expect(vellum!.status).toBe('sent');
    expect(telegram).toBeDefined();
    expect(telegram!.destinationChatId).toBe('guardian-chat-123');
    expect(telegram!.status).toBe('sent');
  });

  test('notifyGuardianOfAccessRequest records failed vellum fallback when pipeline has no vellum delivery', async () => {
    mockEmitResult = {
      signalId: 'sig-no-vellum',
      deduplicated: false,
      dispatched: true,
      reason: 'telegram-only',
      deliveryResults: [
        {
          channel: 'telegram',
          destination: 'guardian-chat-456',
          status: 'sent',
        },
      ],
    };

    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: 'self',
      sourceChannel: 'telegram',
      externalChatId: 'chat-123',
      senderExternalUserId: 'unknown-user',
      senderName: 'Alice',
    });

    expect(result.notified).toBe(true);
    if (!result.notified) return;

    await flushAsyncAccessRequestBookkeeping();

    const deliveries = listCanonicalGuardianDeliveries(result.requestId);
    const vellum = deliveries.find((d) => d.destinationChannel === 'vellum');
    const telegram = deliveries.find((d) => d.destinationChannel === 'telegram');

    expect(vellum).toBeDefined();
    expect(vellum!.status).toBe('failed');
    expect(telegram).toBeDefined();
    expect(telegram!.destinationChatId).toBe('guardian-chat-456');
    expect(telegram!.status).toBe('sent');
  });
});

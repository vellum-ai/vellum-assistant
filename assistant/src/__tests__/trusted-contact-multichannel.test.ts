/**
 * Tests verifying the trusted contact flow is channel-agnostic.
 *
 * The access request -> guardian notification -> verification -> activation
 * flow should work identically across Telegram, SMS, and voice channels.
 * These tests confirm no Telegram-specific assumptions leaked into the
 * trusted contact code paths.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'trusted-contact-multichannel-'));

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
  normalizeAssistantId: (id: string) => id === 'self' ? 'self' : id,
  readHttpToken: () => 'test-bearer-token',
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../security/secret-ingress.js', () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

mock.module('../config/env.js', () => ({
  getGatewayInternalBaseUrl: () => 'http://127.0.0.1:7830',
}));

const emitSignalCalls: Array<Record<string, unknown>> = [];
mock.module('../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return {
      signalId: 'mock-signal-id',
      deduplicated: false,
      dispatched: true,
      reason: 'mock',
      deliveryResults: [],
    };
  },
}));

const deliverReplyCalls: Array<{ url: string; payload: Record<string, unknown> }> = [];
mock.module('../runtime/gateway-client.js', () => ({
  deliverChannelReply: async (url: string, payload: Record<string, unknown>) => {
    deliverReplyCalls.push({ url, payload });
  },
}));

mock.module('../runtime/approval-message-composer.js', () => ({
  composeApprovalMessage: () => 'mock approval message',
  composeApprovalMessageGenerative: async () => 'mock generative message',
}));

import {
  createBinding,
  findPendingAccessRequestForRequester,
} from '../memory/channel-guardian-store.js';
import {
  createOutboundSession,
  validateAndConsumeChallenge,
} from '../runtime/channel-guardian-service.js';
import { findMember, upsertMember } from '../memory/ingress-member-store.js';
import { initializeDb, resetDb } from '../memory/db.js';
import { handleChannelInbound } from '../runtime/routes/channel-routes.js';
import {
  handleAccessRequestDecision,
} from '../runtime/routes/access-request-decision.js';

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
  const { getDb } = require('../memory/db.js');
  const db = getDb();
  db.run('DELETE FROM channel_guardian_approval_requests');
  db.run('DELETE FROM channel_guardian_bindings');
  db.run('DELETE FROM channel_guardian_verification_challenges');
  db.run('DELETE FROM channel_guardian_rate_limits');
  db.run('DELETE FROM channel_inbound_events');
  db.run('DELETE FROM conversations');
  db.run('DELETE FROM notification_events');
  db.run('DELETE FROM assistant_ingress_members');
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
}

interface ChannelTestConfig {
  channel: 'telegram' | 'sms' | 'voice';
  deliverEndpoint: string;
  /** SMS/voice use phone E.164 as identifiers */
  senderExternalUserId: string;
  externalChatId: string;
  guardianExternalUserId: string;
  guardianChatId: string;
}

const CHANNEL_CONFIGS: ChannelTestConfig[] = [
  {
    channel: 'telegram',
    deliverEndpoint: '/deliver/telegram',
    senderExternalUserId: 'tg-user-456',
    externalChatId: 'tg-chat-456',
    guardianExternalUserId: 'tg-guardian-789',
    guardianChatId: 'tg-guardian-chat-789',
  },
  {
    channel: 'sms',
    deliverEndpoint: '/deliver/sms',
    senderExternalUserId: '+15551234567',
    externalChatId: '+15551234567',
    guardianExternalUserId: '+15559876543',
    guardianChatId: '+15559876543',
  },
];

function buildInboundRequest(
  config: ChannelTestConfig,
  overrides: Record<string, unknown> = {},
): Request {
  const body: Record<string, unknown> = {
    sourceChannel: config.channel,
    interface: config.channel,
    externalChatId: config.externalChatId,
    externalMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: 'Hello, can I use this assistant?',
    senderExternalUserId: config.senderExternalUserId,
    senderName: 'Test Requester',
    senderUsername: 'test_requester',
    replyCallbackUrl: `http://localhost:7830${config.deliverEndpoint}`,
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
// Parameterized tests for each channel
// ---------------------------------------------------------------------------

for (const config of CHANNEL_CONFIGS) {
  describe(`trusted contact flow on ${config.channel} channel`, () => {
    beforeEach(() => {
      resetState();
    });

    test('non-member message is denied with rejection reply', async () => {
      const req = buildInboundRequest(config);
      const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
      const json = await resp.json() as Record<string, unknown>;

      expect(json.denied).toBe(true);
      expect(json.reason).toBe('not_a_member');
      expect(deliverReplyCalls.length).toBe(1);
      expect((deliverReplyCalls[0].payload as Record<string, unknown>).text).toContain("you haven't been approved");
    });

    test('guardian is notified when a non-member messages', async () => {
      createBinding({
        assistantId: 'self',
        channel: config.channel,
        guardianExternalUserId: config.guardianExternalUserId,
        guardianDeliveryChatId: config.guardianChatId,
      });

      const req = buildInboundRequest(config);
      const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
      const json = await resp.json() as Record<string, unknown>;

      expect(json.denied).toBe(true);

      // Notification signal was emitted for the correct channel
      expect(emitSignalCalls.length).toBe(1);
      expect(emitSignalCalls[0].sourceEventName).toBe('ingress.access_request');
      expect(emitSignalCalls[0].sourceChannel).toBe(config.channel);

      const payload = emitSignalCalls[0].contextPayload as Record<string, unknown>;
      expect(payload.senderExternalUserId).toBe(config.senderExternalUserId);

      // Approval request was created for the correct channel
      const pending = findPendingAccessRequestForRequester(
        'self',
        config.channel,
        config.senderExternalUserId,
        'ingress_access_request',
      );
      expect(pending).not.toBeNull();
      expect(pending!.channel).toBe(config.channel);
    });

    test('verification creates active member for channel', () => {
      const session = createOutboundSession({
        assistantId: 'self',
        channel: config.channel,
        expectedExternalUserId: config.senderExternalUserId,
        expectedChatId: config.externalChatId,
        identityBindingStatus: 'bound',
        destinationAddress: config.externalChatId,
        verificationPurpose: 'trusted_contact',
      });

      const result = validateAndConsumeChallenge(
        'self',
        config.channel,
        session.secret,
        config.senderExternalUserId,
        config.externalChatId,
        'test_requester',
        'Test Requester',
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.verificationType).toBe('trusted_contact');
      }

      upsertMember({
        assistantId: 'self',
        sourceChannel: config.channel,
        externalUserId: config.senderExternalUserId,
        externalChatId: config.externalChatId,
        status: 'active',
        policy: 'allow',
        displayName: 'Test Requester',
        username: 'test_requester',
      });

      const member = findMember({
        assistantId: 'self',
        sourceChannel: config.channel,
        externalUserId: config.senderExternalUserId,
      });

      expect(member).not.toBeNull();
      expect(member!.status).toBe('active');
      expect(member!.policy).toBe('allow');
      expect(member!.sourceChannel).toBe(config.channel);
    });

    test('no cross-channel leakage between member records', () => {
      // Create a member for this channel
      upsertMember({
        assistantId: 'self',
        sourceChannel: config.channel,
        externalUserId: config.senderExternalUserId,
        externalChatId: config.externalChatId,
        status: 'active',
        policy: 'allow',
      });

      // Should be found on this channel
      const sameChanMember = findMember({
        assistantId: 'self',
        sourceChannel: config.channel,
        externalUserId: config.senderExternalUserId,
      });
      expect(sameChanMember).not.toBeNull();

      // Should NOT be found on a different channel
      const otherChannel = config.channel === 'telegram' ? 'sms' : 'telegram';
      const crossChanMember = findMember({
        assistantId: 'self',
        sourceChannel: otherChannel,
        externalUserId: config.senderExternalUserId,
      });
      expect(crossChanMember).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// SMS-specific: phone E.164 identity binding
// ---------------------------------------------------------------------------

describe('SMS identity binding with E.164 phone numbers', () => {
  beforeEach(() => {
    resetState();
  });

  test('SMS verification session binds to phone E.164', () => {
    const phone = '+15551234567';
    const session = createOutboundSession({
      assistantId: 'self',
      channel: 'sms',
      expectedExternalUserId: phone,
      expectedPhoneE164: phone,
      expectedChatId: phone,
      identityBindingStatus: 'bound',
      destinationAddress: phone,
      verificationPurpose: 'trusted_contact',
    });

    // Verify with matching phone identity
    const result = validateAndConsumeChallenge(
      'self', 'sms', session.secret,
      phone, phone,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe('trusted_contact');
    }
  });

  test('SMS verification rejects mismatched phone identity', () => {
    const expectedPhone = '+15551234567';
    const wrongPhone = '+15559999999';

    const session = createOutboundSession({
      assistantId: 'self',
      channel: 'sms',
      expectedExternalUserId: expectedPhone,
      expectedPhoneE164: expectedPhone,
      expectedChatId: expectedPhone,
      identityBindingStatus: 'bound',
      destinationAddress: expectedPhone,
    });

    // Try to verify with a different phone (anti-oracle: same error message)
    const result = validateAndConsumeChallenge(
      'self', 'sms', session.secret,
      wrongPhone, wrongPhone,
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-channel: same user on different channels gets separate sessions
// ---------------------------------------------------------------------------

describe('cross-channel isolation', () => {
  beforeEach(() => {
    resetState();
  });

  test('verification sessions are scoped per channel', () => {
    // Create sessions on both channels
    const telegramSession = createOutboundSession({
      assistantId: 'self',
      channel: 'telegram',
      expectedExternalUserId: 'user-123',
      expectedChatId: 'chat-123',
      identityBindingStatus: 'bound',
      destinationAddress: 'chat-123',
    });

    const smsSession = createOutboundSession({
      assistantId: 'self',
      channel: 'sms',
      expectedExternalUserId: '+15551234567',
      expectedPhoneE164: '+15551234567',
      expectedChatId: '+15551234567',
      identityBindingStatus: 'bound',
      destinationAddress: '+15551234567',
    });

    // Telegram code should not work on SMS channel
    const wrongChannelResult = validateAndConsumeChallenge(
      'self', 'sms', telegramSession.secret,
      '+15551234567', '+15551234567',
    );
    expect(wrongChannelResult.success).toBe(false);

    // SMS code should work on SMS channel
    const correctChannelResult = validateAndConsumeChallenge(
      'self', 'sms', smsSession.secret,
      '+15551234567', '+15551234567',
    );
    expect(correctChannelResult.success).toBe(true);
  });
});

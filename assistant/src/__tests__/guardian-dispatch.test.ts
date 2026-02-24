import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'guardian-dispatch-test-'));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  readHttpToken: () => null,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module('../config/env.js', () => ({
  getGatewayInternalBaseUrl: () => 'http://localhost:3000',
}));

let mockTelegramBinding: unknown = null;
let mockSmsBinding: unknown = null;

mock.module('../memory/channel-guardian-store.js', () => ({
  getActiveBinding: (_assistantId: string, channel: string) => {
    if (channel === 'telegram') return mockTelegramBinding;
    if (channel === 'sms') return mockSmsBinding;
    return null;
  },
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    calls: {
      userConsultTimeoutSeconds: 120,
    },
  }),
}));

const deliveredMessages: Array<{ url: string; body: Record<string, unknown> }> = [];

mock.module('../runtime/gateway-client.js', () => ({
  deliverChannelReply: async (url: string, body: Record<string, unknown>) => {
    deliveredMessages.push({ url, body });
  },
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import { createCallSession, createPendingQuestion } from '../calls/call-store.js';
import {
  getGuardianActionRequest,
  getDeliveriesByRequestId,
} from '../memory/guardian-action-store.js';
import { dispatchGuardianQuestion } from '../calls/guardian-dispatch.js';
import { getMessages } from '../memory/conversation-store.js';

initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations).values({
    id,
    title: `Conversation ${id}`,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM guardian_action_deliveries');
  db.run('DELETE FROM guardian_action_requests');
  db.run('DELETE FROM call_pending_questions');
  db.run('DELETE FROM call_events');
  db.run('DELETE FROM call_sessions');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  mockTelegramBinding = null;
  mockSmsBinding = null;
  deliveredMessages.length = 0;
}

describe('guardian-dispatch', () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
  });

  test('creates a guardian action request with mac delivery', async () => {
    const convId = 'conv-dispatch-1';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'What is the gate code?');

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
    });

    // Should have created a guardian action request in the DB
    const db = getDb();
    const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
    const requests = raw.query('SELECT * FROM guardian_action_requests WHERE call_session_id = ?').all(session.id) as Array<{ id: string; status: string; question_text: string }>;
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('pending');
    expect(requests[0].question_text).toBe('What is the gate code?');

    // Should have at least a mac delivery
    const deliveries = raw.query('SELECT * FROM guardian_action_deliveries WHERE request_id = ?').all(requests[0].id) as Array<{ destination_channel: string; status: string }>;
    const macDelivery = deliveries.find(d => d.destination_channel === 'macos');
    expect(macDelivery).toBeDefined();
    expect(macDelivery!.status).toBe('sent');
  });

  test('creates telegram delivery when binding exists', async () => {
    const convId = 'conv-dispatch-2';
    ensureConversation(convId);

    mockTelegramBinding = {
      guardianDeliveryChatId: 'tg-chat-999',
      guardianExternalUserId: 'tg-user-888',
    };

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Should I proceed?');

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
    });

    // Wait briefly for async delivery
    await new Promise(resolve => setTimeout(resolve, 50));

    // Should have sent to telegram via gateway
    expect(deliveredMessages.length).toBeGreaterThanOrEqual(1);
    const telegramMessage = deliveredMessages.find(m => m.url.includes('/deliver/telegram'));
    expect(telegramMessage).toBeDefined();
    expect(telegramMessage!.body.chatId).toBe('tg-chat-999');
  });

  test('emits IPC event via broadcast for mac delivery', async () => {
    const convId = 'conv-dispatch-3';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Approve action?');

    const broadcastedMessages: unknown[] = [];
    const broadcastFn = (msg: unknown) => { broadcastedMessages.push(msg); };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
      broadcast: broadcastFn,
    });

    expect(broadcastedMessages).toHaveLength(1);
    const msg = broadcastedMessages[0] as Record<string, unknown>;
    expect(msg.type).toBe('guardian_request_thread_created');
    expect(msg.callSessionId).toBe(session.id);
  });

  test('adds initial guardian message to mac conversation', async () => {
    const convId = 'conv-dispatch-4';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'What is the password?');

    const broadcastedMessages: unknown[] = [];
    const broadcastFn = (msg: unknown) => { broadcastedMessages.push(msg); };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
      broadcast: broadcastFn,
    });

    // Get the mac conversation ID from the broadcast
    const msg = broadcastedMessages[0] as Record<string, unknown>;
    const macConvId = msg.conversationId as string;

    // The mac conversation should have a message with the question text
    const messages = getMessages(macConvId);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const content = messages[0].content;
    expect(content).toContain('What is the password?');
  });

  test('does not throw on dispatch errors (fire-and-forget)', async () => {
    const convId = 'conv-dispatch-5';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'This should not throw');

    // Even without any bindings, dispatch should complete without throwing
    await expect(dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
    })).resolves.toBeUndefined();
  });
});

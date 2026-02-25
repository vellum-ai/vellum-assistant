import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ThreadCreatedInfo } from '../notifications/broadcaster.js';
import type { NotificationDeliveryResult } from '../notifications/types.js';

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

const emitCalls: unknown[] = [];
let threadCreatedFromMock: ThreadCreatedInfo | null = null;
let mockEmitResult: {
  signalId: string;
  deduplicated: boolean;
  dispatched: boolean;
  reason: string;
  deliveryResults: NotificationDeliveryResult[];
} = {
  signalId: 'sig-1',
  deduplicated: false,
  dispatched: true,
  reason: 'ok',
  deliveryResults: [
    {
      channel: 'vellum',
      destination: 'vellum',
      status: 'sent',
      conversationId: 'conv-vellum-1',
    },
  ],
};

mock.module('../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitCalls.push(params);
    const callback = params.onThreadCreated;
    if (typeof callback === 'function' && threadCreatedFromMock) {
      callback(threadCreatedFromMock);
    }
    return mockEmitResult;
  },
  registerBroadcastFn: () => {},
}));

import { createCallSession, createPendingQuestion } from '../calls/call-store.js';
import { dispatchGuardianQuestion } from '../calls/guardian-dispatch.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';

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
  db.run('DELETE FROM conversations');
  mockTelegramBinding = null;
  mockSmsBinding = null;
  emitCalls.length = 0;
  threadCreatedFromMock = null;
  mockEmitResult = {
    signalId: 'sig-1',
    deduplicated: false,
    dispatched: true,
    reason: 'ok',
    deliveryResults: [
      {
        channel: 'vellum',
        destination: 'vellum',
        status: 'sent',
        conversationId: 'conv-vellum-1',
      },
    ],
  };
}

describe('guardian-dispatch', () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
  });

  test('creates a guardian action request and vellum delivery from pipeline results', async () => {
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

    const db = getDb();
    const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
    const request = raw.query('SELECT * FROM guardian_action_requests WHERE call_session_id = ?').get(session.id) as
      | { id: string; status: string; question_text: string }
      | undefined;
    expect(request).toBeDefined();
    expect(request!.status).toBe('pending');
    expect(request!.question_text).toBe('What is the gate code?');

    const vellumDelivery = raw.query(
      'SELECT * FROM guardian_action_deliveries WHERE request_id = ? AND destination_channel = ?',
    ).get(request!.id, 'vellum') as { status: string; destination_conversation_id: string | null } | undefined;
    expect(vellumDelivery).toBeDefined();
    expect(vellumDelivery!.status).toBe('sent');
    expect(vellumDelivery!.destination_conversation_id).toBe('conv-vellum-1');

    const signalParams = emitCalls[0] as Record<string, unknown>;
    expect(signalParams.skipVellumThread).toBeUndefined();
    expect(typeof signalParams.onThreadCreated).toBe('function');
  });

  test('creates a telegram guardian delivery with binding metadata when pipeline sends telegram', async () => {
    const convId = 'conv-dispatch-2';
    ensureConversation(convId);

    mockTelegramBinding = {
      guardianDeliveryChatId: 'tg-chat-999',
      guardianExternalUserId: 'tg-user-888',
    };
    mockEmitResult = {
      signalId: 'sig-2',
      deduplicated: false,
      dispatched: true,
      reason: 'ok',
      deliveryResults: [
        {
          channel: 'vellum',
          destination: 'vellum',
          status: 'sent',
          conversationId: 'conv-vellum-2',
        },
        {
          channel: 'telegram',
          destination: 'tg-chat-999',
          status: 'sent',
        },
      ],
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

    const db = getDb();
    const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
    const request = raw.query('SELECT * FROM guardian_action_requests WHERE call_session_id = ?').get(session.id) as
      | { id: string }
      | undefined;
    const telegramDelivery = raw.query(
      'SELECT * FROM guardian_action_deliveries WHERE request_id = ? AND destination_channel = ?',
    ).get(request!.id, 'telegram') as
      | { status: string; destination_chat_id: string | null; destination_external_user_id: string | null }
      | undefined;
    expect(telegramDelivery).toBeDefined();
    expect(telegramDelivery!.status).toBe('sent');
    expect(telegramDelivery!.destination_chat_id).toBe('tg-chat-999');
    expect(telegramDelivery!.destination_external_user_id).toBe('tg-user-888');
  });

  test('marks non-sent pipeline delivery results as failed', async () => {
    const convId = 'conv-dispatch-3';
    ensureConversation(convId);

    mockEmitResult = {
      signalId: 'sig-3',
      deduplicated: false,
      dispatched: true,
      reason: 'partial',
      deliveryResults: [
        {
          channel: 'vellum',
          destination: 'vellum',
          status: 'failed',
          errorMessage: 'IPC unavailable',
          conversationId: 'conv-vellum-3',
        },
      ],
    };

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Error case');

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
    });

    const db = getDb();
    const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
    const request = raw.query('SELECT * FROM guardian_action_requests WHERE call_session_id = ?').get(session.id) as
      | { id: string }
      | undefined;
    const vellumDelivery = raw.query(
      'SELECT * FROM guardian_action_deliveries WHERE request_id = ? AND destination_channel = ?',
    ).get(request!.id, 'vellum') as { status: string; last_error: string | null } | undefined;
    expect(vellumDelivery).toBeDefined();
    expect(vellumDelivery!.status).toBe('failed');
    expect(vellumDelivery!.last_error).toContain('IPC unavailable');
  });

  test('uses onThreadCreated callback conversation when delivery result omits conversationId', async () => {
    const convId = 'conv-dispatch-4';
    ensureConversation(convId);

    threadCreatedFromMock = {
      conversationId: 'conv-from-thread-created',
      title: 'Guardian alert',
      sourceEventName: 'guardian.question',
    };
    mockEmitResult = {
      signalId: 'sig-4',
      deduplicated: false,
      dispatched: true,
      reason: 'ok',
      deliveryResults: [
        {
          channel: 'vellum',
          destination: 'vellum',
          status: 'sent',
        },
      ],
    };

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Need callback conversation');

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
    });

    const db = getDb();
    const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
    const request = raw.query('SELECT * FROM guardian_action_requests WHERE call_session_id = ?').get(session.id) as
      | { id: string }
      | undefined;
    const vellumDelivery = raw.query(
      'SELECT * FROM guardian_action_deliveries WHERE request_id = ? AND destination_channel = ?',
    ).get(request!.id, 'vellum') as { destination_conversation_id: string | null } | undefined;
    expect(vellumDelivery).toBeDefined();
    expect(vellumDelivery!.destination_conversation_id).toBe('conv-from-thread-created');
  });
});

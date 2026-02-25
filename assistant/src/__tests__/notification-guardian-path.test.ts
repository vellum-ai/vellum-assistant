/**
 * Regression tests for the ASK_GUARDIAN notification path.
 *
 * Validates that guardian dispatch:
 * 1. Emits a notification signal through the standard notification pipeline
 * 2. Creates a server-side conversation BEFORE emitting the IPC event
 * 3. Emits guardian_request_thread_created IPC (not a special notification type)
 * 4. LLM-generated copy is used for the thread title and initial message
 *
 * The ASK_GUARDIAN flow uses the same `emitNotificationSignal()` entry point
 * as all other producers, plus its own conversation materialization for the
 * vellum channel. This test validates the canonical path has no special-casing
 * beyond what's needed for the guardian-specific conversation thread.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'notification-guardian-path-'));

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

mock.module('../memory/channel-guardian-store.js', () => ({
  getActiveBinding: () => null,
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    calls: {
      userConsultTimeoutSeconds: 120,
    },
  }),
}));

mock.module('../runtime/gateway-client.js', () => ({
  deliverChannelReply: async () => {},
}));

mock.module('../calls/guardian-question-copy.js', () => ({
  generateGuardianCopy: async (questionText: string) => ({
    threadTitle: `Test: ${questionText.slice(0, 30)}`,
    initialMessage: `Test message for: ${questionText}`,
  }),
  buildFallbackCopy: (questionText: string) => ({
    threadTitle: `Fallback: ${questionText.slice(0, 30)}`,
    initialMessage: `Fallback message for: ${questionText}`,
  }),
}));

// Track calls to emitNotificationSignal
const emitCalls: unknown[] = [];
mock.module('../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async (params: unknown) => {
    emitCalls.push(params);
  },
  registerBroadcastFn: () => {},
}));

import { createCallSession, createPendingQuestion } from '../calls/call-store.js';
import { dispatchGuardianQuestion } from '../calls/guardian-dispatch.js';
import { getMessages } from '../memory/conversation-store.js';
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
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  emitCalls.length = 0;
}

describe('ASK_GUARDIAN canonical notification path', () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
  });

  test('guardian dispatch emits a notification signal through the standard pipeline', async () => {
    const convId = 'conv-guardian-notif-1';
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

    // The dispatch should have called emitNotificationSignal
    expect(emitCalls.length).toBeGreaterThanOrEqual(1);
    const signalParams = emitCalls[0] as Record<string, unknown>;
    expect(signalParams.sourceEventName).toBe('guardian.question');
    expect(signalParams.sourceChannel).toBe('voice');
  });

  test('notification signal includes correct attention hints for guardian questions', async () => {
    const convId = 'conv-guardian-notif-2';
    ensureConversation(convId);

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

    const signalParams = emitCalls[0] as Record<string, unknown>;
    const hints = signalParams.attentionHints as Record<string, unknown>;

    // Guardian questions are high urgency and require action
    expect(hints.requiresAction).toBe(true);
    expect(hints.urgency).toBe('high');
    expect(hints.isAsyncBackground).toBe(false);
    expect(hints.visibleInSourceNow).toBe(false);
  });

  test('notification signal context payload includes request metadata', async () => {
    const convId = 'conv-guardian-notif-3';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'What is the WiFi password?');

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
    });

    const signalParams = emitCalls[0] as Record<string, unknown>;
    const payload = signalParams.contextPayload as Record<string, unknown>;

    expect(payload.questionText).toBe('What is the WiFi password?');
    expect(payload.callSessionId).toBe(session.id);
    expect(payload.requestId).toBeDefined();
    expect(payload.requestCode).toBeDefined();
  });

  test('notification signal has a dedupe key based on the request ID', async () => {
    const convId = 'conv-guardian-notif-4';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Approve entry?');

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
    });

    const signalParams = emitCalls[0] as Record<string, unknown>;
    expect(signalParams.dedupeKey).toBeDefined();
    expect(typeof signalParams.dedupeKey).toBe('string');
    // The dedupe key should include 'guardian:' prefix
    expect((signalParams.dedupeKey as string).startsWith('guardian:')).toBe(true);
  });

  test('guardian dispatch creates conversation before IPC event', async () => {
    const convId = 'conv-guardian-notif-5';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'What is the passcode?');

    let ipcConversationId: string | null = null;
    const broadcastFn = (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (m.type === 'guardian_request_thread_created') {
        ipcConversationId = m.conversationId as string;

        // At this point, the conversation and message should already exist
        const messages = getMessages(ipcConversationId);
        expect(messages.length).toBeGreaterThanOrEqual(1);
      }
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
      broadcast: broadcastFn,
    });

    // The IPC event should have been emitted
    expect(ipcConversationId).not.toBeNull();
  });

  test('IPC event type is guardian_request_thread_created (not a generic notification event)', async () => {
    const convId = 'conv-guardian-notif-6';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Grant access?');

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

    // The IPC event is the specific guardian_request_thread_created type,
    // not a generic notification_intent or notification_thread_created
    expect(msg.type).toBe('guardian_request_thread_created');
    expect(msg.conversationId).toBeDefined();
    expect(msg.requestId).toBeDefined();
    expect(msg.callSessionId).toBe(session.id);
    expect(msg.title).toBeDefined();
    expect(msg.questionText).toBe('Grant access?');
  });

  test('guardian dispatch is fire-and-forget (no throw on errors)', async () => {
    const convId = 'conv-guardian-notif-7';
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Error test');

    // Should complete without throwing
    await expect(dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: 'self',
      pendingQuestion: pq,
    })).resolves.toBeUndefined();
  });
});

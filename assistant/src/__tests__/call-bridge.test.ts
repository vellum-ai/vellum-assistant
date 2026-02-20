import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const testDir = mkdtempSync(join(tmpdir(), 'call-bridge-test-'));

// ── Platform + logger mocks (must come before any source imports) ────

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
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Config mock ─────────────────────────────────────────────────────

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    apiKeys: { anthropic: 'test-key' },
    memory: { enabled: false },
    calls: {
      enabled: true,
      provider: 'twilio',
      maxDurationSeconds: 3600,
      userConsultTimeoutSeconds: 120,
      disclosure: { enabled: false, text: '' },
      safety: { denyCategories: [] },
    },
  }),
}));

// ── Anthropic SDK mock ──────────────────────────────────────────────

function createMockStream(tokens: string[]) {
  const emitter = new EventEmitter();
  const fullText = tokens.join('');

  const stream = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
      return stream;
    },
    finalMessage: () => {
      for (const token of tokens) {
        emitter.emit('text', token);
      }
      return Promise.resolve({
        content: [{ type: 'text', text: fullText }],
      });
    },
  };

  return stream;
}

const mockStreamFn = mock((..._args: unknown[]) => createMockStream(['Hello']));

mock.module('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      stream: (...args: unknown[]) => mockStreamFn(...args),
    };
  },
}));

// ── Import source modules after all mocks ───────────────────────────

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import {
  createCallSession,
  getPendingQuestion,
  updateCallSession,
  recordCallEvent,
  createPendingQuestion,
} from '../calls/call-store.js';
import {
  registerCallQuestionNotifier,
  unregisterCallQuestionNotifier,
  registerCallTranscriptNotifier,
  unregisterCallTranscriptNotifier,
  fireCallTranscriptNotifier,
  registerCallCompletionNotifier,
  unregisterCallCompletionNotifier,
  fireCallQuestionNotifier,
  fireCallCompletionNotifier,
} from '../calls/call-state.js';
import { CallOrchestrator } from '../calls/call-orchestrator.js';
import { tryHandlePendingCallAnswer } from '../calls/call-bridge.js';
import * as conversationStore from '../memory/conversation-store.js';
import type { RelayConnection } from '../calls/relay-server.js';

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ── Relay mock factory ──────────────────────────────────────────────

interface MockRelay extends RelayConnection {
  sentTokens: Array<{ token: string; last: boolean }>;
  endCalled: boolean;
}

function createMockRelay(): MockRelay {
  const state = {
    sentTokens: [] as Array<{ token: string; last: boolean }>,
    _endCalled: false,
  };

  return {
    get sentTokens() { return state.sentTokens; },
    get endCalled() { return state._endCalled; },
    sendTextToken(token: string, last: boolean) {
      state.sentTokens.push({ token, last });
    },
    endSession(_reason?: string) {
      state._endCalled = true;
    },
  } as unknown as MockRelay;
}

// ── Helpers ─────────────────────────────────────────────────────────

let ensuredConvIds = new Set<string>();
function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations).values({
    id,
    title: `Test conversation ${id}`,
    createdAt: now,
    updatedAt: now,
  }).run();
  ensuredConvIds.add(id);
}

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM call_pending_questions');
  db.run('DELETE FROM call_events');
  db.run('DELETE FROM call_sessions');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  ensuredConvIds = new Set();
}

function getMessagesForConversation(conversationId: string) {
  return conversationStore.getMessages(conversationId);
}

describe('call-bridge', () => {
  beforeEach(() => {
    resetTables();
    mockStreamFn.mockImplementation(() => createMockStream(['Hello']));
  });

  // ── tryHandlePendingCallAnswer ──────────────────────────────────

  test('returns handled:false when no active call exists', async () => {
    ensureConversation('conv-no-call');
    const result = await tryHandlePendingCallAnswer('conv-no-call', 'some answer');
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('no_active_call');
  });

  test('returns handled:false when call exists but no pending question', async () => {
    ensureConversation('conv-no-question');
    createCallSession({
      conversationId: 'conv-no-question',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });
    const result = await tryHandlePendingCallAnswer('conv-no-question', 'some answer');
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('no_pending_question');
  });

  test('returns handled:false when orchestrator is not found (call still active but no orchestrator)', async () => {
    ensureConversation('conv-ended');
    const callSession = createCallSession({
      conversationId: 'conv-ended',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });
    // Leave the session in an active (non-terminal) state but do NOT register an orchestrator.
    // This simulates a race where the orchestrator was destroyed but the session hasn't
    // been marked terminal yet.
    updateCallSession(callSession.id, { status: 'in_progress' });

    // Create a pending question without an orchestrator
    createPendingQuestion(callSession.id, 'What time?');

    const result = await tryHandlePendingCallAnswer('conv-ended', 'Too late');
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('orchestrator_not_found');
  });

  test('returns no_active_call when call has already completed', async () => {
    ensureConversation('conv-completed');
    const callSession = createCallSession({
      conversationId: 'conv-completed',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });
    // Mark the call as completed — getActiveCallSessionForConversation will return null
    updateCallSession(callSession.id, { status: 'completed', endedAt: Date.now() });

    const result = await tryHandlePendingCallAnswer('conv-completed', 'Too late');
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('no_active_call');
  });

  test('returns handled:false when orchestrator is not in waiting_on_user state', async () => {
    ensureConversation('conv-not-waiting');
    const callSession = createCallSession({
      conversationId: 'conv-not-waiting',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    // Create orchestrator (state=idle by default)
    const relay = createMockRelay();
    const orchestrator = new CallOrchestrator(callSession.id, relay as unknown as RelayConnection, null);

    // Create a pending question in the DB but orchestrator is idle, not waiting_on_user
    createPendingQuestion(callSession.id, 'What time?');

    const result = await tryHandlePendingCallAnswer('conv-not-waiting', 'answer');
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('orchestrator_not_waiting');

    orchestrator.destroy();
  });

  test('routes answer to orchestrator when waiting and returns handled:true', async () => {
    // Setup: trigger ASK_USER to put orchestrator in waiting_on_user state
    mockStreamFn.mockImplementation(() =>
      createMockStream(['Hold on. [ASK_USER: Preferred date?]']),
    );

    ensureConversation('conv-bridge');
    const callSession = createCallSession({
      conversationId: 'conv-bridge',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const relay = createMockRelay();
    const orchestrator = new CallOrchestrator(callSession.id, relay as unknown as RelayConnection, 'test task');

    await orchestrator.handleCallerUtterance('I need a reservation');

    // Verify the orchestrator is now waiting
    expect(orchestrator.getState()).toBe('waiting_on_user');

    // Now provide the answer — set up mock for the LLM call after answer
    mockStreamFn.mockImplementation(() => createMockStream(['Great, booking for tomorrow.']));

    const result = await tryHandlePendingCallAnswer('conv-bridge', 'Tomorrow at noon');
    expect(result.handled).toBe(true);

    // Wait for the fire-and-forget LLM call
    await new Promise((r) => setTimeout(r, 50));

    // Verify the pending question was answered
    const question = getPendingQuestion(callSession.id);
    // After answering, there should be no pending question left
    expect(question).toBeNull();

    orchestrator.destroy();
  });

  // ── Call question notifier ──────────────────────────────────────

  test('call question notifier persists assistant message and emits events', () => {
    ensureConversation('conv-notifier-q');

    const emittedEvents: Array<{ type: string; text?: string }> = [];
    const sendToClient = (msg: { type: string; text?: string }) => {
      emittedEvents.push(msg);
    };

    // Register notifier (as Session would)
    registerCallQuestionNotifier('conv-notifier-q', (_callSessionId: string, question: string) => {
      const questionText = `**Live call question**:\n\n${question}\n\n_Reply in this thread to answer._`;
      conversationStore.addMessage(
        'conv-notifier-q',
        'assistant',
        JSON.stringify([{ type: 'text', text: questionText }]),
      );
      sendToClient({ type: 'assistant_text_delta', text: questionText });
      sendToClient({ type: 'message_complete' });
    });

    // Fire the notifier
    fireCallQuestionNotifier('conv-notifier-q', 'call-session-1', 'What time works best?');

    // Verify message was persisted
    const msgs = getMessagesForConversation('conv-notifier-q');
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toContain('What time works best?');

    // Verify events were emitted
    expect(emittedEvents.length).toBe(2);
    expect(emittedEvents[0].type).toBe('assistant_text_delta');
    expect(emittedEvents[0].text).toContain('What time works best?');
    expect(emittedEvents[1].type).toBe('message_complete');

    unregisterCallQuestionNotifier('conv-notifier-q');
  });

  // ── Call transcript notifier ─────────────────────────────────────

  test('call transcript notifier persists transcript line and emits events', () => {
    ensureConversation('conv-notifier-t');

    const emittedEvents: Array<{ type: string; text?: string }> = [];
    const sendToClient = (msg: { type: string; text?: string }) => {
      emittedEvents.push(msg);
    };

    registerCallTranscriptNotifier('conv-notifier-t', (_callSessionId: string, speaker: 'caller' | 'assistant', text: string) => {
      const speakerLabel = speaker === 'caller' ? 'Caller' : 'Assistant';
      const transcriptText = `**Live call transcript**\n${speakerLabel}: ${text}`;
      conversationStore.addMessage(
        'conv-notifier-t',
        'assistant',
        JSON.stringify([{ type: 'text', text: transcriptText }]),
      );
      sendToClient({ type: 'assistant_text_delta', text: transcriptText });
      sendToClient({ type: 'message_complete' });
    });

    fireCallTranscriptNotifier('conv-notifier-t', 'call-session-1', 'caller', 'Can you confirm the appointment?');

    const msgs = getMessagesForConversation('conv-notifier-t');
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toContain('Caller: Can you confirm the appointment?');

    expect(emittedEvents.length).toBe(2);
    expect(emittedEvents[0].type).toBe('assistant_text_delta');
    expect(emittedEvents[0].text).toContain('Live call transcript');
    expect(emittedEvents[1].type).toBe('message_complete');

    unregisterCallTranscriptNotifier('conv-notifier-t');
  });

  // ── Call completion notifier ────────────────────────────────────

  test('call completion notifier persists summary and emits events', () => {
    ensureConversation('conv-notifier-c');

    const emittedEvents: Array<{ type: string; text?: string }> = [];
    const sendToClient = (msg: { type: string; text?: string }) => {
      emittedEvents.push(msg);
    };

    // Create a call session so getCallSession works
    const callSession = createCallSession({
      conversationId: 'conv-notifier-c',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });
    updateCallSession(callSession.id, { status: 'completed', startedAt: Date.now() - 30000, endedAt: Date.now() });
    recordCallEvent(callSession.id, 'call_started', {});
    recordCallEvent(callSession.id, 'call_ended', {});

    registerCallCompletionNotifier('conv-notifier-c', (_callSessionId: string) => {
      const summaryText = `**Call completed**. Events recorded.`;
      conversationStore.addMessage(
        'conv-notifier-c',
        'assistant',
        JSON.stringify([{ type: 'text', text: summaryText }]),
      );
      sendToClient({ type: 'assistant_text_delta', text: summaryText });
      sendToClient({ type: 'message_complete' });
    });

    fireCallCompletionNotifier('conv-notifier-c', callSession.id);

    // Verify message persisted
    const msgs = getMessagesForConversation('conv-notifier-c');
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toContain('Call completed');

    // Verify events emitted
    expect(emittedEvents.length).toBe(2);
    expect(emittedEvents[0].type).toBe('assistant_text_delta');
    expect(emittedEvents[1].type).toBe('message_complete');

    unregisterCallCompletionNotifier('conv-notifier-c');
  });
});

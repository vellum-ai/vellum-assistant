/**
 * Tests for RelayConnection — the WebSocket handler for Twilio
 * ConversationRelay protocol.
 *
 * Tests:
 * - Setup message handling (callSid association, event recording, orchestrator creation)
 * - Prompt message handling (final vs partial, routing to orchestrator)
 * - Interrupt handling (abort propagation)
 * - Error handling (event recording)
 * - DTMF handling (event recording)
 * - sendTextToken / endSession (outbound WebSocket messages)
 * - Conversation history tracking
 * - destroy cleanup
 * - Malformed message resilience
 */
import { describe, test, expect, beforeEach, afterAll, mock, type Mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const testDir = mkdtempSync(join(tmpdir(), 'relay-server-test-'));

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
  readHttpToken: () => null,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Config mock ─────────────────────────────────────────────────────

const mockConfig = {
  apiKeys: { anthropic: 'test-key' },
  calls: {
    enabled: true,
    provider: 'twilio',
    maxDurationSeconds: 3600,
    userConsultTimeoutSeconds: 120,
    disclosure: { enabled: false, text: '' },
    safety: { denyCategories: [] },
    verification: {
      enabled: false,
      maxAttempts: 3,
      codeLength: 6,
    },
  },
  memory: { enabled: false },
};

mock.module('../config/loader.js', () => ({
  getConfig: () => mockConfig,
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

let mockStreamFn: Mock<(...args: unknown[]) => unknown>;

mock.module('@anthropic-ai/sdk', () => {
  mockStreamFn = mock((..._args: unknown[]) => createMockStream(['Hello']));
  return {
    default: class MockAnthropic {
      messages = {
        stream: (...args: unknown[]) => mockStreamFn(...args),
      };
    },
  };
});

// ── Import source modules after all mocks ────────────────────────────

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import {
  createCallSession,
  getCallSession,
  getCallEvents,
} from '../calls/call-store.js';
import { getMessages } from '../memory/conversation-store.js';
import { registerCallCompletionNotifier, unregisterCallCompletionNotifier } from '../calls/call-state.js';
import { RelayConnection, activeRelayConnections } from '../calls/relay-server.js';
import type { RelayWebSocketData } from '../calls/relay-server.js';

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ── Mock WebSocket factory ──────────────────────────────────────────

interface MockWs {
  sentMessages: string[];
  readyState: number;
}

function createMockWs(callSessionId: string): { ws: MockWs; relay: RelayConnection } {
  const sentMessages: string[] = [];
  const ws = {
    sentMessages,
    readyState: 1, // WebSocket.OPEN
    send(data: string) {
      sentMessages.push(data);
    },
    data: { callSessionId } as RelayWebSocketData,
  };

  const relay = new RelayConnection(ws as unknown as import('bun').ServerWebSocket<RelayWebSocketData>, callSessionId);
  return { ws, relay };
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
  db.run('DELETE FROM tool_invocations');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  ensuredConvIds = new Set();
}

function getLatestAssistantText(conversationId: string): string | null {
  const messages = getMessages(conversationId).filter((m) => m.role === 'assistant');
  if (messages.length === 0) return null;
  const latest = messages[messages.length - 1];
  try {
    const parsed = JSON.parse(latest.content) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null)
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
    }
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Ignore parse failures and fall back to raw content.
  }
  return latest.content;
}

describe('relay-server', () => {
  beforeEach(() => {
    resetTables();
    activeRelayConnections.clear();
    mockStreamFn.mockImplementation(() => createMockStream(['Hello']));
    mockConfig.calls.verification.enabled = false;
    mockConfig.calls.verification.maxAttempts = 3;
    mockConfig.calls.verification.codeLength = 6;
  });

  // ── Setup message handling ──────────────────────────────────────

  test('handleMessage: setup message associates callSid and records event', async () => {
    ensureConversation('conv-relay-1');
    const session = createCallSession({
      conversationId: 'conv-relay-1',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(JSON.stringify({
      type: 'setup',
      callSid: 'CA_relay_setup_123',
      from: '+15551111111',
      to: '+15552222222',
    }));

    // Verify callSid was stored on the session
    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.providerCallSid).toBe('CA_relay_setup_123');
    expect(updated!.status).toBe('in_progress');
    expect(updated!.startedAt).not.toBeNull();

    // Verify event was recorded
    const events = getCallEvents(session.id);
    const connectedEvents = events.filter(e => e.eventType === 'call_connected');
    expect(connectedEvents.length).toBe(1);

    // Verify orchestrator was created
    expect(relay.getOrchestrator()).not.toBeNull();

    relay.destroy();
  });

  test('handleMessage: setup triggers initial assistant greeting turn', async () => {
    ensureConversation('conv-relay-setup-greet');
    const session = createCallSession({
      conversationId: 'conv-relay-setup-greet',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
      task: 'Confirm appointment time',
    });

    mockStreamFn.mockImplementation(() => createMockStream(['Hello, I am calling to confirm your appointment.']));

    const { ws, relay } = createMockWs(session.id);

    await relay.handleMessage(JSON.stringify({
      type: 'setup',
      callSid: 'CA_setup_greet_123',
      from: '+15551111111',
      to: '+15552222222',
    }));

    await new Promise((resolve) => setTimeout(resolve, 10));

    const textMessages = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; token?: string; last?: boolean })
      .filter((m) => m.type === 'text');
    expect(textMessages.some((m) => (m.token ?? '').includes('confirm your appointment'))).toBe(true);
    expect(textMessages.some((m) => m.last === true)).toBe(true);

    const events = getCallEvents(session.id).filter((e) => e.eventType === 'assistant_spoke');
    expect(events.length).toBeGreaterThan(0);

    relay.destroy();
  });

  test('handleTransportClosed: normal close marks call completed and notifies completion', () => {
    ensureConversation('conv-relay-close-normal');
    const session = createCallSession({
      conversationId: 'conv-relay-close-normal',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);
    let completionCount = 0;
    registerCallCompletionNotifier('conv-relay-close-normal', () => {
      completionCount += 1;
    });

    relay.handleTransportClosed(1000, 'Closing websocket session');

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
    expect(updated!.endedAt).not.toBeNull();
    const endedEvents = getCallEvents(session.id).filter((e) => e.eventType === 'call_ended');
    expect(endedEvents.length).toBe(1);
    expect(completionCount).toBe(1);
    expect(getLatestAssistantText('conv-relay-close-normal')).toContain('**Call completed**');

    unregisterCallCompletionNotifier('conv-relay-close-normal');
    relay.destroy();
  });

  test('handleTransportClosed: abnormal close marks call failed', () => {
    ensureConversation('conv-relay-close-abnormal');
    const session = createCallSession({
      conversationId: 'conv-relay-close-abnormal',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);
    relay.handleTransportClosed(1006, 'abnormal closure');

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('failed');
    expect(updated!.endedAt).not.toBeNull();
    expect(updated!.lastError).toContain('abnormal closure');
    const failEvents = getCallEvents(session.id).filter((e) => e.eventType === 'call_failed');
    expect(failEvents.length).toBe(1);
    expect(getLatestAssistantText('conv-relay-close-abnormal')).toContain('**Call failed**');

    relay.destroy();
  });

  test('handleMessage: setup message with custom parameters', async () => {
    ensureConversation('conv-relay-custom');
    const session = createCallSession({
      conversationId: 'conv-relay-custom',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
      task: 'Book appointment',
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(JSON.stringify({
      type: 'setup',
      callSid: 'CA_relay_custom_123',
      from: '+15551111111',
      to: '+15552222222',
      customParameters: { taskId: 'task-1', priority: 'high' },
    }));

    // Verify event recorded with custom parameters
    const events = getCallEvents(session.id);
    const connectedEvents = events.filter((e) => e.eventType === 'call_connected');
    expect(connectedEvents.length).toBe(1);
    const payload = JSON.parse(connectedEvents[0].payloadJson);
    expect(payload.customParameters).toEqual({ taskId: 'task-1', priority: 'high' });

    relay.destroy();
  });

  // ── Prompt message handling ─────────────────────────────────────

  test('handleMessage: final prompt routes to orchestrator and records event', async () => {
    ensureConversation('conv-relay-prompt');
    const session = createCallSession({
      conversationId: 'conv-relay-prompt',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { ws, relay } = createMockWs(session.id);

    // First, setup to create orchestrator
    await relay.handleMessage(JSON.stringify({
      type: 'setup',
      callSid: 'CA_prompt_123',
      from: '+15551111111',
      to: '+15552222222',
    }));

    // Now send a final prompt
    await relay.handleMessage(JSON.stringify({
      type: 'prompt',
      voicePrompt: 'Hello, I need to make a reservation',
      lang: 'en-US',
      last: true,
    }));

    // Verify event was recorded
    const events = getCallEvents(session.id);
    const spokeEvents = events.filter(e => e.eventType === 'caller_spoke');
    expect(spokeEvents.length).toBe(1);
    const payload = JSON.parse(spokeEvents[0].payloadJson);
    expect(payload.transcript).toBe('Hello, I need to make a reservation');

    // Verify conversation history was updated
    const history = relay.getConversationHistory();
    expect(history.length).toBe(1);
    expect(history[0].role).toBe('caller');
    expect(history[0].text).toBe('Hello, I need to make a reservation');

    // Verify tokens were sent through the WebSocket
    expect(ws.sentMessages.length).toBeGreaterThan(0);

    relay.destroy();
  });

  test('handleMessage: partial prompt (last=false) does not route to orchestrator', async () => {
    ensureConversation('conv-relay-partial');
    const session = createCallSession({
      conversationId: 'conv-relay-partial',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { ws, relay } = createMockWs(session.id);

    // Setup
    await relay.handleMessage(JSON.stringify({
      type: 'setup',
      callSid: 'CA_partial_123',
      from: '+15551111111',
      to: '+15552222222',
    }));

    // Let any async initial-greeting turn settle so we can compare only
    // the effect of the partial prompt itself.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const messagesBeforePrompt = ws.sentMessages.length;

    // Send a partial prompt (last=false)
    await relay.handleMessage(JSON.stringify({
      type: 'prompt',
      voicePrompt: 'Hello, I need...',
      lang: 'en-US',
      last: false,
    }));

    // Should not have generated any new text tokens (no LLM call for partials)
    // Only the setup-related messages should exist
    expect(ws.sentMessages.length).toBe(messagesBeforePrompt);

    // Conversation history should not have been updated for partials
    const history = relay.getConversationHistory();
    expect(history.length).toBe(0);

    relay.destroy();
  });

  test('handleMessage: prompt without orchestrator sends fallback', async () => {
    ensureConversation('conv-relay-no-orch');
    const session = createCallSession({
      conversationId: 'conv-relay-no-orch',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { ws, relay } = createMockWs(session.id);
    // Note: no setup message, so no orchestrator

    await relay.handleMessage(JSON.stringify({
      type: 'prompt',
      voicePrompt: 'Hello',
      lang: 'en-US',
      last: true,
    }));

    // Should have sent a fallback message
    const textMessages = ws.sentMessages
      .map(m => JSON.parse(m))
      .filter((m: { type: string }) => m.type === 'text');
    expect(textMessages.length).toBe(1);
    expect(textMessages[0].token).toContain('still setting up');
    expect(textMessages[0].last).toBe(true);

    relay.destroy();
  });

  // ── Interrupt handling ──────────────────────────────────────────

  test('handleMessage: interrupt message is handled without error', async () => {
    ensureConversation('conv-relay-int');
    const session = createCallSession({
      conversationId: 'conv-relay-int',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    // Setup
    await relay.handleMessage(JSON.stringify({
      type: 'setup',
      callSid: 'CA_int_123',
      from: '+15551111111',
      to: '+15552222222',
    }));

    // Interrupt should not throw
    await relay.handleMessage(JSON.stringify({
      type: 'interrupt',
      utteranceUntilInterrupt: 'Hello, I was saying...',
    }));

    relay.destroy();
  });

  // ── DTMF handling ───────────────────────────────────────────────

  test('handleMessage: dtmf digit records event', async () => {
    ensureConversation('conv-relay-dtmf');
    const session = createCallSession({
      conversationId: 'conv-relay-dtmf',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(JSON.stringify({
      type: 'dtmf',
      digit: '5',
    }));

    const events = getCallEvents(session.id);
    const dtmfEvents = events.filter(e => e.eventType === 'caller_spoke');
    expect(dtmfEvents.length).toBe(1);
    const payload = JSON.parse(dtmfEvents[0].payloadJson);
    expect(payload.dtmfDigit).toBe('5');

    relay.destroy();
  });

  test('verification failure remains failed if transport closes during goodbye delay', async () => {
    ensureConversation('conv-relay-verify-race');
    const session = createCallSession({
      conversationId: 'conv-relay-verify-race',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    mockConfig.calls.verification.enabled = true;
    mockConfig.calls.verification.maxAttempts = 1;
    mockConfig.calls.verification.codeLength = 1;

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(JSON.stringify({
      type: 'setup',
      callSid: 'CA_verify_race_123',
      from: '+15551111111',
      to: '+15552222222',
    }));

    const verificationCode = relay.getVerificationCode();
    expect(verificationCode).not.toBeNull();
    const wrongDigit = verificationCode === '0' ? '1' : '0';

    await relay.handleMessage(JSON.stringify({
      type: 'dtmf',
      digit: wrongDigit,
    }));

    // Simulate the callee hanging up before the delayed endSession executes.
    relay.handleTransportClosed(1000, 'callee hung up');

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('failed');
    expect(updated!.lastError).toContain('max attempts exceeded');
    expect(getLatestAssistantText('conv-relay-verify-race')).toContain('**Call failed**');

    // Let the delayed endSession callback flush to avoid timer bleed across tests.
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const finalState = getCallSession(session.id);
    expect(finalState).not.toBeNull();
    expect(finalState!.status).toBe('failed');

    relay.destroy();
  });

  // ── Error handling ──────────────────────────────────────────────

  test('handleMessage: error message records call_failed event', async () => {
    ensureConversation('conv-relay-err');
    const session = createCallSession({
      conversationId: 'conv-relay-err',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    await relay.handleMessage(JSON.stringify({
      type: 'error',
      description: 'Audio stream disconnected',
    }));

    const events = getCallEvents(session.id);
    const failEvents = events.filter(e => e.eventType === 'call_failed');
    expect(failEvents.length).toBe(1);
    const payload = JSON.parse(failEvents[0].payloadJson);
    expect(payload.error).toBe('Audio stream disconnected');

    relay.destroy();
  });

  // ── Malformed message resilience ────────────────────────────────

  test('handleMessage: malformed JSON does not throw', async () => {
    ensureConversation('conv-relay-malformed');
    const session = createCallSession({
      conversationId: 'conv-relay-malformed',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    // Should not throw
    await relay.handleMessage('not-valid-json{{{');

    relay.destroy();
  });

  test('handleMessage: unknown message type does not throw', async () => {
    ensureConversation('conv-relay-unknown');
    const session = createCallSession({
      conversationId: 'conv-relay-unknown',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    // Should not throw
    await relay.handleMessage(JSON.stringify({
      type: 'some_future_type',
      data: 'whatever',
    }));

    relay.destroy();
  });

  // ── sendTextToken / endSession ──────────────────────────────────

  test('sendTextToken: sends correctly formatted text message', () => {
    ensureConversation('conv-relay-send');
    const session = createCallSession({
      conversationId: 'conv-relay-send',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { ws, relay } = createMockWs(session.id);

    relay.sendTextToken('Hello there', false);
    relay.sendTextToken('', true);

    expect(ws.sentMessages.length).toBe(2);

    const msg1 = JSON.parse(ws.sentMessages[0]);
    expect(msg1.type).toBe('text');
    expect(msg1.token).toBe('Hello there');
    expect(msg1.last).toBe(false);

    const msg2 = JSON.parse(ws.sentMessages[1]);
    expect(msg2.type).toBe('text');
    expect(msg2.token).toBe('');
    expect(msg2.last).toBe(true);

    relay.destroy();
  });

  test('endSession: sends end message without reason', () => {
    ensureConversation('conv-relay-end');
    const session = createCallSession({
      conversationId: 'conv-relay-end',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { ws, relay } = createMockWs(session.id);

    relay.endSession();

    expect(ws.sentMessages.length).toBe(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('end');
    expect(msg.handoffData).toBeUndefined();

    relay.destroy();
  });

  test('endSession: sends end message with reason as handoffData', () => {
    ensureConversation('conv-relay-end-reason');
    const session = createCallSession({
      conversationId: 'conv-relay-end-reason',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { ws, relay } = createMockWs(session.id);

    relay.endSession('Call completed');

    expect(ws.sentMessages.length).toBe(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('end');
    const handoff = JSON.parse(msg.handoffData);
    expect(handoff.reason).toBe('Call completed');

    relay.destroy();
  });

  // ── Conversation history ────────────────────────────────────────

  test('getConversationHistory: returns role and text without timestamps', () => {
    ensureConversation('conv-relay-hist');
    const session = createCallSession({
      conversationId: 'conv-relay-hist',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    // Empty initially
    expect(relay.getConversationHistory()).toEqual([]);

    relay.destroy();
  });

  // ── Accessors ───────────────────────────────────────────────────

  test('getCallSessionId: returns the call session ID', () => {
    ensureConversation('conv-relay-id');
    const session = createCallSession({
      conversationId: 'conv-relay-id',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);
    expect(relay.getCallSessionId()).toBe(session.id);

    relay.destroy();
  });

  // ── destroy ─────────────────────────────────────────────────────

  test('destroy: cleans up orchestrator', async () => {
    ensureConversation('conv-relay-destroy');
    const session = createCallSession({
      conversationId: 'conv-relay-destroy',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    // Setup creates orchestrator
    await relay.handleMessage(JSON.stringify({
      type: 'setup',
      callSid: 'CA_destroy_123',
      from: '+15551111111',
      to: '+15552222222',
    }));

    expect(relay.getOrchestrator()).not.toBeNull();

    relay.destroy();

    expect(relay.getOrchestrator()).toBeNull();
  });

  test('destroy: can be called multiple times without error', () => {
    ensureConversation('conv-relay-destroy2');
    const session = createCallSession({
      conversationId: 'conv-relay-destroy2',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const { relay } = createMockWs(session.id);

    relay.destroy();
    expect(() => relay.destroy()).not.toThrow();
  });
});

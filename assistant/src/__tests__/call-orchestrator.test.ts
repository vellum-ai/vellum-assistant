import { describe, test, expect, beforeEach, afterAll, mock, type Mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const testDir = mkdtempSync(join(tmpdir(), 'call-orchestrator-test-'));

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
  getConfig: () => ({ apiKeys: { anthropic: 'test-key' } }),
}));

// ── Helpers for building mock streaming responses ───────────────────

/**
 * Creates a mock Anthropic stream object that emits 'text' events
 * for each token and resolves `finalMessage()` with the full response.
 */
function createMockStream(tokens: string[]) {
  const emitter = new EventEmitter();
  const fullText = tokens.join('');

  const stream = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
      return stream;
    },
    finalMessage: () => {
      // Emit tokens synchronously so the on('text') handler has fired
      // before finalMessage resolves.
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

// ── Anthropic SDK mock ──────────────────────────────────────────────

let mockStreamFn: Mock<(...args: unknown[]) => unknown>;

mock.module('@anthropic-ai/sdk', () => {
  mockStreamFn = mock((..._args: unknown[]) => createMockStream(['Hello', ' there']));
  return {
    default: class MockAnthropic {
      messages = {
        stream: (...args: unknown[]) => mockStreamFn(...args),
      };
    },
  };
});

// ── Import source modules after all mocks are registered ────────────

import { initializeDb, getDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import {
  createCallSession,
  getCallSession,
  updateCallSession,
  recordCallEvent,
  createPendingQuestion,
  getPendingQuestion,
} from '../calls/call-store.js';
import {
  registerCallOrchestrator,
  unregisterCallOrchestrator,
  getCallOrchestrator,
} from '../calls/call-state.js';
import { CallOrchestrator } from '../calls/call-orchestrator.js';
import type { RelayConnection } from '../calls/relay-server.js';

initializeDb();

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ── RelayConnection mock factory ────────────────────────────────────

interface MockRelay extends RelayConnection {
  sentTokens: Array<{ token: string; last: boolean }>;
  endCalled: boolean;
  endReason: string | undefined;
}

function createMockRelay(): MockRelay {
  const state = {
    sentTokens: [] as Array<{ token: string; last: boolean }>,
    _endCalled: false,
    _endReason: undefined as string | undefined,
  };

  return {
    get sentTokens() { return state.sentTokens; },
    get endCalled() { return state._endCalled; },
    get endReason() { return state._endReason; },
    sendTextToken(token: string, last: boolean) {
      state.sentTokens.push({ token, last });
    },
    endSession(reason?: string) {
      state._endCalled = true;
      state._endReason = reason;
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
  db.run('DELETE FROM conversations');
  ensuredConvIds = new Set();
}

/**
 * Create a call session and an orchestrator wired to a mock relay.
 */
function setupOrchestrator(task?: string) {
  ensureConversation('conv-orch-test');
  const session = createCallSession({
    conversationId: 'conv-orch-test',
    provider: 'twilio',
    fromNumber: '+15551111111',
    toNumber: '+15552222222',
    task,
  });
  const relay = createMockRelay();
  const orchestrator = new CallOrchestrator(session.id, relay as unknown as RelayConnection, task ?? null);
  return { session, relay, orchestrator };
}

describe('call-orchestrator', () => {
  beforeEach(() => {
    resetTables();
    // Reset the stream mock to default behaviour
    mockStreamFn.mockImplementation(() => createMockStream(['Hello', ' there']));
  });

  // ── handleCallerUtterance ─────────────────────────────────────────

  test('handleCallerUtterance: streams tokens via sendTextToken', async () => {
    mockStreamFn.mockImplementation(() => createMockStream(['Hi', ', how', ' are you?']));
    const { relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('Hello');

    // Verify tokens were sent to the relay
    const nonEmptyTokens = relay.sentTokens.filter((t) => t.token.length > 0);
    expect(nonEmptyTokens.length).toBeGreaterThan(0);
    // The last token should have last=true (empty string token signaling end)
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken.last).toBe(true);

    orchestrator.destroy();
  });

  test('handleCallerUtterance: sends last=true at end of turn', async () => {
    mockStreamFn.mockImplementation(() => createMockStream(['Simple response.']));
    const { relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('Test');

    // Find the final empty-string token that marks end of turn
    const endMarkers = relay.sentTokens.filter((t) => t.last === true);
    expect(endMarkers.length).toBeGreaterThanOrEqual(1);

    orchestrator.destroy();
  });

  // ── ASK_USER pattern ──────────────────────────────────────────────

  test('ASK_USER pattern: detects pattern, creates pending question, enters waiting_on_user', async () => {
    mockStreamFn.mockImplementation(() =>
      createMockStream(['Let me check on that. ', '[ASK_USER: What date works best?]']),
    );
    const { session, relay, orchestrator } = setupOrchestrator('Book appointment');

    await orchestrator.handleCallerUtterance('I need to schedule something');

    // Verify a pending question was created
    const question = getPendingQuestion(session.id);
    expect(question).not.toBeNull();
    expect(question!.questionText).toBe('What date works best?');
    expect(question!.status).toBe('pending');

    // Verify session status was updated to waiting_on_user
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe('waiting_on_user');

    // The ASK_USER marker text should NOT appear in the relay tokens
    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).not.toContain('[ASK_USER:');

    orchestrator.destroy();
  });

  // ── END_CALL pattern ──────────────────────────────────────────────

  test('END_CALL pattern: detects marker, calls endSession, updates status to completed', async () => {
    mockStreamFn.mockImplementation(() =>
      createMockStream(['Thank you for calling, goodbye! ', '[END_CALL]']),
    );
    const { session, relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('That is all, thanks');

    // endSession should have been called
    expect(relay.endCalled).toBe(true);

    // Session status should be completed
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe('completed');
    expect(updatedSession!.endedAt).not.toBeNull();

    // The END_CALL marker text should NOT appear in the relay tokens
    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).not.toContain('[END_CALL]');

    orchestrator.destroy();
  });

  // ── handleUserAnswer ──────────────────────────────────────────────

  test('handleUserAnswer: appends USER_ANSWERED to history and runs LLM', async () => {
    // First utterance triggers ASK_USER
    mockStreamFn.mockImplementation(() =>
      createMockStream(['Hold on. [ASK_USER: Preferred time?]']),
    );
    const { session, relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('I need an appointment');

    // Now provide the answer — reset mock for second LLM call
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      // Verify the messages include the USER_ANSWERED marker
      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      const lastUserMsg = firstArg.messages.filter((m: { role: string }) => m.role === 'user').pop();
      expect(lastUserMsg?.content).toContain('[USER_ANSWERED: 3pm tomorrow]');
      return createMockStream(['Great, I have scheduled for 3pm tomorrow.']);
    });

    await orchestrator.handleUserAnswer('3pm tomorrow');

    // Should have streamed a response for the answer
    const tokensAfterAnswer = relay.sentTokens.filter((t) => t.token.includes('3pm'));
    expect(tokensAfterAnswer.length).toBeGreaterThan(0);

    orchestrator.destroy();
  });

  // ── handleInterrupt ───────────────────────────────────────────────

  test('handleInterrupt: resets state to idle', () => {
    const { orchestrator } = setupOrchestrator();

    // Calling handleInterrupt should not throw
    orchestrator.handleInterrupt();

    orchestrator.destroy();
  });

  // ── destroy ───────────────────────────────────────────────────────

  test('destroy: unregisters orchestrator', () => {
    const { session, orchestrator } = setupOrchestrator();

    // Orchestrator should be registered
    expect(getCallOrchestrator(session.id)).toBeDefined();

    orchestrator.destroy();

    // After destroy, orchestrator should be unregistered
    expect(getCallOrchestrator(session.id)).toBeUndefined();
  });

  test('destroy: can be called multiple times without error', () => {
    const { orchestrator } = setupOrchestrator();

    orchestrator.destroy();
    // Second destroy should not throw
    expect(() => orchestrator.destroy()).not.toThrow();
  });
});

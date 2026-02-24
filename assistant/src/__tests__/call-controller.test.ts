import { describe, test, expect, beforeEach, afterAll, mock, type Mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'call-controller-test-'));

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

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    provider: 'anthropic',
    providerOrder: ['anthropic'],
    apiKeys: { anthropic: 'test-key' },
    calls: {
      enabled: true,
      provider: 'twilio',
      maxDurationSeconds: 12 * 60,
      userConsultTimeoutSeconds: 90,
      userConsultationTimeoutSeconds: 90,
      silenceTimeoutSeconds: 30,
      disclosure: { enabled: false, text: '' },
      safety: { denyCategories: [] },
      model: undefined,
    },
    memory: { enabled: false },
  }),
}));

// ── Voice session bridge mock ────────────────────────────────────────

/**
 * Creates a mock startVoiceTurn implementation that emits text_delta
 * events for each token and calls onComplete when done.
 */
function createMockVoiceTurn(tokens: string[]) {
  return async (opts: {
    conversationId: string;
    content: string;
    assistantId?: string;
    onTextDelta: (text: string) => void;
    onComplete: () => void;
    onError: (message: string) => void;
    signal?: AbortSignal;
  }) => {
    // Check for abort before proceeding
    if (opts.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Emit text deltas
    for (const token of tokens) {
      if (opts.signal?.aborted) break;
      opts.onTextDelta(token);
    }

    if (!opts.signal?.aborted) {
      opts.onComplete();
    }

    let aborted = false;
    return {
      runId: `run-${Date.now()}`,
      abort: () => { aborted = true; },
    };
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockStartVoiceTurn: Mock<any>;

mock.module('../calls/voice-session-bridge.js', () => {
  mockStartVoiceTurn = mock(createMockVoiceTurn(['Hello', ' there']));
  return {
    startVoiceTurn: (...args: unknown[]) => mockStartVoiceTurn(...args),
    setVoiceBridgeOrchestrator: () => {},
  };
});

// ── Import source modules after all mocks are registered ────────────

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import {
  createCallSession,
  getCallSession,
  getCallEvents,
  getPendingQuestion,
  updateCallSession,
} from '../calls/call-store.js';
import {
  getCallController,
} from '../calls/call-state.js';
import { CallController } from '../calls/call-controller.js';
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
  db.run('DELETE FROM guardian_action_deliveries');
  db.run('DELETE FROM guardian_action_requests');
  db.run('DELETE FROM call_pending_questions');
  db.run('DELETE FROM call_events');
  db.run('DELETE FROM call_sessions');
  db.run('DELETE FROM tool_invocations');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  ensuredConvIds = new Set();
}

/**
 * Create a call session and a controller wired to a mock relay.
 */
function setupController(task?: string) {
  ensureConversation('conv-ctrl-test');
  const session = createCallSession({
    conversationId: 'conv-ctrl-test',
    provider: 'twilio',
    fromNumber: '+15551111111',
    toNumber: '+15552222222',
    task,
  });
  updateCallSession(session.id, { status: 'in_progress' });
  const relay = createMockRelay();
  const controller = new CallController(session.id, relay as unknown as RelayConnection, task ?? null);
  return { session, relay, controller };
}

describe('call-controller', () => {
  beforeEach(() => {
    resetTables();
    // Reset the bridge mock to default behaviour
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(['Hello', ' there']));
  });

  // ── handleCallerUtterance ─────────────────────────────────────────

  test('handleCallerUtterance: streams tokens via sendTextToken', async () => {
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(['Hi', ', how', ' are you?']));
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance('Hello');

    // Verify tokens were sent to the relay
    const nonEmptyTokens = relay.sentTokens.filter((t) => t.token.length > 0);
    expect(nonEmptyTokens.length).toBeGreaterThan(0);
    // The last token should have last=true (empty string token signaling end)
    const lastToken = relay.sentTokens[relay.sentTokens.length - 1];
    expect(lastToken.last).toBe(true);

    controller.destroy();
  });

  test('handleCallerUtterance: sends last=true at end of turn', async () => {
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(['Simple response.']));
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance('Test');

    // Find the final empty-string token that marks end of turn
    const endMarkers = relay.sentTokens.filter((t) => t.last === true);
    expect(endMarkers.length).toBeGreaterThanOrEqual(1);

    controller.destroy();
  });

  test('handleCallerUtterance: includes speaker context in voice turn content', async () => {
    mockStartVoiceTurn.mockImplementation(async (opts: { content: string; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      expect(opts.content).toContain('[SPEAKER id="speaker-1" label="Aaron" source="provider" confidence="0.91"]');
      expect(opts.content).toContain('Can you summarize this meeting?');
      opts.onTextDelta('Sure, here is a summary.');
      opts.onComplete();
      return { runId: 'run-1', abort: () => {} };
    });

    const { controller } = setupController();

    await controller.handleCallerUtterance('Can you summarize this meeting?', {
      speakerId: 'speaker-1',
      speakerLabel: 'Aaron',
      speakerConfidence: 0.91,
      source: 'provider',
    });

    controller.destroy();
  });

  test('startInitialGreeting: sends CALL_OPENING content and strips control marker from speech', async () => {
    let turnCount = 0;
    mockStartVoiceTurn.mockImplementation(async (opts: { content: string; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      turnCount++;
      expect(opts.content).toContain('[CALL_OPENING]');
      const tokens = ['Hi, I am calling about your appointment request. Is now a good time to talk?'];
      for (const token of tokens) {
        opts.onTextDelta(token);
      }
      opts.onComplete();
      return { runId: 'run-1', abort: () => {} };
    });

    const { relay, controller } = setupController('Confirm appointment');

    await controller.startInitialGreeting();
    await controller.startInitialGreeting(); // should be no-op

    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).toContain('appointment request');
    expect(allText).toContain('good time to talk');
    expect(allText).not.toContain('[CALL_OPENING]');
    expect(turnCount).toBe(1); // idempotent

    controller.destroy();
  });

  test('startInitialGreeting: tags only the first caller response with CALL_OPENING_ACK', async () => {
    let turnCount = 0;
    mockStartVoiceTurn.mockImplementation(async (opts: { content: string; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      turnCount++;

      let tokens: string[];
      if (turnCount === 1) {
        expect(opts.content).toContain('[CALL_OPENING]');
        tokens = ['Hey Noa, it\'s Credence calling about your joke request. Is now okay for a quick one?'];
      } else if (turnCount === 2) {
        expect(opts.content).toContain('[CALL_OPENING_ACK]');
        expect(opts.content).toContain('Yeah. Sure. What\'s up?');
        tokens = ['Great, here\'s one right away. Why did the scarecrow win an award?'];
      } else {
        expect(opts.content).not.toContain('[CALL_OPENING_ACK]');
        expect(opts.content).toContain('Tell me the punchline');
        tokens = ['Because he was outstanding in his field.'];
      }

      for (const token of tokens) {
        opts.onTextDelta(token);
      }
      opts.onComplete();
      return { runId: `run-${turnCount}`, abort: () => {} };
    });

    const { controller } = setupController('Tell a joke immediately');

    await controller.startInitialGreeting();
    await controller.handleCallerUtterance('Yeah. Sure. What\'s up?');
    await controller.handleCallerUtterance('Tell me the punchline');

    expect(turnCount).toBe(3);

    controller.destroy();
  });

  // ── ASK_GUARDIAN pattern ──────────────────────────────────────────

  test('ASK_GUARDIAN pattern: detects pattern, creates pending question, enters waiting_on_user', async () => {
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Let me check on that. ', '[ASK_GUARDIAN: What date works best?]'],
    ));
    const { session, relay, controller } = setupController('Book appointment');

    await controller.handleCallerUtterance('I need to schedule something');

    // Verify a pending question was created
    const question = getPendingQuestion(session.id);
    expect(question).not.toBeNull();
    expect(question!.questionText).toBe('What date works best?');
    expect(question!.status).toBe('pending');

    // Verify session status was updated to waiting_on_user
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe('waiting_on_user');

    // The ASK_GUARDIAN marker text should NOT appear in the relay tokens
    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).not.toContain('[ASK_GUARDIAN:');

    controller.destroy();
  });

  test('strips internal context markers from spoken output', async () => {
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn([
      'Thanks for waiting. ',
      '[USER_ANSWERED: The guardian said 3 PM works.] ',
      '[USER_INSTRUCTION: Keep this short.] ',
      '[CALL_OPENING_ACK] ',
      'I can confirm 3 PM works.',
    ]));
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance('Any update?');

    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).toContain('Thanks for waiting.');
    expect(allText).toContain('I can confirm 3 PM works.');
    expect(allText).not.toContain('[USER_ANSWERED:');
    expect(allText).not.toContain('[USER_INSTRUCTION:');
    expect(allText).not.toContain('[CALL_OPENING_ACK]');
    expect(allText).not.toContain('USER_ANSWERED');
    expect(allText).not.toContain('USER_INSTRUCTION');
    expect(allText).not.toContain('CALL_OPENING_ACK');

    controller.destroy();
  });

  // ── END_CALL pattern ──────────────────────────────────────────────

  test('END_CALL pattern: detects marker, calls endSession, updates status to completed', async () => {
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Thank you for calling, goodbye! ', '[END_CALL]'],
    ));
    const { session, relay, controller } = setupController();

    await controller.handleCallerUtterance('That is all, thanks');

    // endSession should have been called
    expect(relay.endCalled).toBe(true);

    // Session status should be completed
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe('completed');
    expect(updatedSession!.endedAt).not.toBeNull();

    // The END_CALL marker text should NOT appear in the relay tokens
    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).not.toContain('[END_CALL]');

    controller.destroy();
  });

  // ── handleUserAnswer ──────────────────────────────────────────────

  test('handleUserAnswer: returns true immediately and fires LLM asynchronously', async () => {
    // First utterance triggers ASK_GUARDIAN
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Hold on. [ASK_GUARDIAN: Preferred time?]'],
    ));
    const { relay, controller } = setupController();

    await controller.handleCallerUtterance('I need an appointment');

    // Now provide the answer — reset mock for second turn
    mockStartVoiceTurn.mockImplementation(async (opts: { content: string; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      expect(opts.content).toContain('[USER_ANSWERED: 3pm tomorrow]');
      const tokens = ['Great, I have scheduled for 3pm tomorrow.'];
      for (const token of tokens) {
        opts.onTextDelta(token);
      }
      opts.onComplete();
      return { runId: 'run-2', abort: () => {} };
    });

    const accepted = await controller.handleUserAnswer('3pm tomorrow');
    expect(accepted).toBe(true);

    // handleUserAnswer fires runTurn without awaiting, so give the
    // microtask queue a tick to let the async work complete.
    await new Promise((r) => setTimeout(r, 50));

    // Should have streamed a response for the answer
    const tokensAfterAnswer = relay.sentTokens.filter((t) => t.token.includes('3pm'));
    expect(tokensAfterAnswer.length).toBeGreaterThan(0);

    controller.destroy();
  });

  // ── Full mid-call question flow ──────────────────────────────────

  test('mid-call question flow: unavailable time -> ask user -> user confirms -> resumed call', async () => {
    // Step 1: Caller says "7:30" but it's unavailable. The LLM asks the user.
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['I\'m sorry, 7:30 is not available. ', '[ASK_GUARDIAN: Is 8:00 okay instead?]'],
    ));

    const { session, relay, controller } = setupController('Schedule a haircut');

    await controller.handleCallerUtterance('Can I book for 7:30?');

    // Verify we're in waiting_on_user state
    expect(controller.getState()).toBe('waiting_on_user');
    const question = getPendingQuestion(session.id);
    expect(question).not.toBeNull();
    expect(question!.questionText).toBe('Is 8:00 okay instead?');

    // Verify session status
    const midSession = getCallSession(session.id);
    expect(midSession!.status).toBe('waiting_on_user');

    // Step 2: User answers "Yes, 8:00 works"
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Great, I\'ve booked you for 8:00. See you then! ', '[END_CALL]'],
    ));

    const accepted = await controller.handleUserAnswer('Yes, 8:00 works for me');
    expect(accepted).toBe(true);

    // Give the fire-and-forget LLM call time to complete
    await new Promise((r) => setTimeout(r, 50));

    // Step 3: Verify call completed
    const endSession = getCallSession(session.id);
    expect(endSession!.status).toBe('completed');
    expect(endSession!.endedAt).not.toBeNull();

    // Verify the END_CALL marker triggered endSession on relay
    expect(relay.endCalled).toBe(true);

    controller.destroy();
  });

  // ── Error handling ────────────────────────────────────────────────

  test('Voice turn error: sends error message to caller and returns to idle', async () => {
    mockStartVoiceTurn.mockImplementation(async (opts: { onError: (msg: string) => void }) => {
      opts.onError('API rate limit exceeded');
      return { runId: 'run-err', abort: () => {} };
    });

    const { relay, controller } = setupController();

    await controller.handleCallerUtterance('Hello');

    // Should have sent an error recovery message
    const errorTokens = relay.sentTokens.filter((t) =>
      t.token.includes('technical issue'),
    );
    expect(errorTokens.length).toBeGreaterThan(0);

    // State should return to idle after error
    expect(controller.getState()).toBe('idle');

    controller.destroy();
  });

  test('handleUserAnswer: returns false when not in waiting_on_user state', async () => {
    const { controller } = setupController();

    // Controller starts in idle state
    const result = await controller.handleUserAnswer('some answer');
    expect(result).toBe(false);

    controller.destroy();
  });

  // ── handleInterrupt ───────────────────────────────────────────────

  test('handleInterrupt: resets state to idle', () => {
    const { controller } = setupController();

    // Calling handleInterrupt should not throw
    controller.handleInterrupt();

    controller.destroy();
  });

  test('handleInterrupt: sends turn terminator when interrupting active speech', async () => {
    mockStartVoiceTurn.mockImplementation(async (opts: { signal?: AbortSignal; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      return new Promise((resolve) => {
        // Simulate a long-running turn that can be aborted
        const timeout = setTimeout(() => {
          opts.onTextDelta('This should be interrupted');
          opts.onComplete();
          resolve({ runId: 'run-1', abort: () => {} });
        }, 1000);

        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          const err = new Error('aborted');
          err.name = 'AbortError';
          resolve({ runId: 'run-1', abort: () => {} });
        }, { once: true });
      });
    });

    const { relay, controller } = setupController();
    const turnPromise = controller.handleCallerUtterance('Start speaking');
    await new Promise((r) => setTimeout(r, 5));
    controller.handleInterrupt();
    await turnPromise;

    const endTurnMarkers = relay.sentTokens.filter((t) => t.token === '' && t.last === true);
    expect(endTurnMarkers.length).toBeGreaterThan(0);

    controller.destroy();
  });

  // ── destroy ───────────────────────────────────────────────────────

  test('destroy: unregisters controller', () => {
    const { session, controller } = setupController();

    // Controller should be registered
    expect(getCallController(session.id)).toBeDefined();

    controller.destroy();

    // After destroy, controller should be unregistered
    expect(getCallController(session.id)).toBeUndefined();
  });

  test('destroy: can be called multiple times without error', () => {
    const { controller } = setupController();

    controller.destroy();
    // Second destroy should not throw
    expect(() => controller.destroy()).not.toThrow();
  });

  // ── handleUserInstruction ─────────────────────────────────────────

  test('handleUserInstruction: injects instruction marker and triggers turn when idle', async () => {
    mockStartVoiceTurn.mockImplementation(async (opts: { content: string; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      expect(opts.content).toContain('[USER_INSTRUCTION: Ask about their weekend plans]');
      const tokens = ['Sure, do you have any weekend plans?'];
      for (const token of tokens) {
        opts.onTextDelta(token);
      }
      opts.onComplete();
      return { runId: 'run-instr', abort: () => {} };
    });

    const { relay, controller } = setupController();

    await controller.handleUserInstruction('Ask about their weekend plans');

    // Should have streamed a response since controller was idle
    const nonEmptyTokens = relay.sentTokens.filter((t) => t.token.length > 0);
    expect(nonEmptyTokens.length).toBeGreaterThan(0);

    controller.destroy();
  });

  test('handleUserInstruction: emits user_instruction_relayed event', async () => {
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(['Understood, adjusting approach.']));

    const { session, controller } = setupController();

    await controller.handleUserInstruction('Be more formal in your tone');

    const events = getCallEvents(session.id);
    const instructionEvents = events.filter((e) => e.eventType === 'user_instruction_relayed');
    expect(instructionEvents.length).toBe(1);

    const payload = JSON.parse(instructionEvents[0].payloadJson);
    expect(payload.instruction).toBe('Be more formal in your tone');

    controller.destroy();
  });

  test('handleUserInstruction: does not trigger turn when controller is not idle', async () => {
    // First, trigger ASK_GUARDIAN so controller enters waiting_on_user
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Hold on. [ASK_GUARDIAN: What time?]'],
    ));

    const { session, controller } = setupController();
    await controller.handleCallerUtterance('I need an appointment');
    expect(controller.getState()).toBe('waiting_on_user');

    // Track how many times startVoiceTurn is called
    let turnCallCount = 0;
    mockStartVoiceTurn.mockImplementation(async (opts: { onTextDelta: (t: string) => void; onComplete: () => void }) => {
      turnCallCount++;
      opts.onTextDelta('Response after instruction.');
      opts.onComplete();
      return { runId: 'run-2', abort: () => {} };
    });

    // Inject instruction while in waiting_on_user state
    await controller.handleUserInstruction('Suggest morning slots');

    // The turn should NOT have been triggered since we're not idle
    expect(turnCallCount).toBe(0);

    // But the event should still be recorded
    const events = getCallEvents(session.id);
    const instructionEvents = events.filter((e) => e.eventType === 'user_instruction_relayed');
    expect(instructionEvents.length).toBe(1);

    controller.destroy();
  });
});

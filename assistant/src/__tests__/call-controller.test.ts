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

// ── Call constants mock ──────────────────────────────────────────────

let mockConsultationTimeoutMs = 90_000;

mock.module('../calls/call-constants.js', () => ({
  getMaxCallDurationMs: () => 12 * 60 * 1000,
  getUserConsultationTimeoutMs: () => mockConsultationTimeoutMs,
  SILENCE_TIMEOUT_MS: 30_000,
  MAX_CALL_DURATION_MS: 3600 * 1000,
  USER_CONSULTATION_TIMEOUT_MS: 120 * 1000,
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

    return {
      runId: `run-${Date.now()}`,
      abort: () => {},
    };
  };
}

 
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
function setupController(task?: string, opts?: { assistantId?: string; guardianContext?: import('../daemon/session-runtime-assembly.js').GuardianRuntimeContext }) {
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
  const controller = new CallController(session.id, relay as unknown as RelayConnection, task ?? null, {
    assistantId: opts?.assistantId,
    guardianContext: opts?.guardianContext,
  });
  return { session, relay, controller };
}

describe('call-controller', () => {
  beforeEach(() => {
    resetTables();
    // Reset the bridge mock to default behaviour
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(['Hello', ' there']));
    // Reset consultation timeout to the default (long) value
    mockConsultationTimeoutMs = 90_000;
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
          // In the real system, generation_cancelled triggers
          // onComplete via the event sink. The AbortSignal listener
          // in call-controller also resolves turnComplete defensively.
          opts.onComplete();
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

  test('handleInterrupt: turnComplete settles even when event sink callbacks are not called', async () => {
    // Simulate a turn that never calls onComplete or onError on abort —
    // the defensive AbortSignal listener in runTurn() should settle the promise.
    mockStartVoiceTurn.mockImplementation(async (opts: { signal?: AbortSignal; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          opts.onTextDelta('Long running turn');
          opts.onComplete();
          resolve({ runId: 'run-1', abort: () => {} });
        }, 5000);

        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          // Intentionally do NOT call onComplete — simulates the old
          // broken path where generation_cancelled was not forwarded.
          resolve({ runId: 'run-1', abort: () => {} });
        }, { once: true });
      });
    });

    const { controller } = setupController();
    const turnPromise = controller.handleCallerUtterance('Start speaking');
    await new Promise((r) => setTimeout(r, 5));
    controller.handleInterrupt();

    // Should not hang — the AbortSignal listener resolves the promise
    await turnPromise;

    expect(controller.getState()).toBe('idle');

    controller.destroy();
  });

  // ── Guardian context pass-through ──────────────────────────────────

  test('handleCallerUtterance: passes guardian context to startVoiceTurn', async () => {
    const guardianCtx = {
      sourceChannel: 'voice' as const,
      actorRole: 'non-guardian' as const,
      guardianExternalUserId: '+15550009999',
      guardianChatId: '+15550009999',
      requesterExternalUserId: '+15550002222',
    };

    let capturedGuardianContext: unknown = undefined;
    mockStartVoiceTurn.mockImplementation(async (opts: {
      guardianContext?: unknown;
      onTextDelta: (t: string) => void;
      onComplete: () => void;
    }) => {
      capturedGuardianContext = opts.guardianContext;
      opts.onTextDelta('Hello.');
      opts.onComplete();
      return { runId: 'run-gc', abort: () => {} };
    });

    const { controller } = setupController(undefined, { guardianContext: guardianCtx });

    await controller.handleCallerUtterance('Hello');

    expect(capturedGuardianContext).toEqual(guardianCtx);

    controller.destroy();
  });

  test('handleCallerUtterance: passes assistantId to startVoiceTurn', async () => {
    let capturedAssistantId: string | undefined;
    mockStartVoiceTurn.mockImplementation(async (opts: {
      assistantId?: string;
      onTextDelta: (t: string) => void;
      onComplete: () => void;
    }) => {
      capturedAssistantId = opts.assistantId;
      opts.onTextDelta('Hello.');
      opts.onComplete();
      return { runId: 'run-aid', abort: () => {} };
    });

    const { controller } = setupController(undefined, { assistantId: 'my-assistant' });

    await controller.handleCallerUtterance('Hello');

    expect(capturedAssistantId).toBe('my-assistant');

    controller.destroy();
  });

  test('setGuardianContext: subsequent turns use updated guardian context', async () => {
    const initialCtx = {
      sourceChannel: 'voice' as const,
      actorRole: 'unverified_channel' as const,
      denialReason: 'no_binding' as const,
    };

    const upgradedCtx = {
      sourceChannel: 'voice' as const,
      actorRole: 'guardian' as const,
      guardianExternalUserId: '+15550003333',
      guardianChatId: '+15550003333',
    };

    const capturedContexts: unknown[] = [];
    mockStartVoiceTurn.mockImplementation(async (opts: {
      guardianContext?: unknown;
      onTextDelta: (t: string) => void;
      onComplete: () => void;
    }) => {
      capturedContexts.push(opts.guardianContext);
      opts.onTextDelta('Response.');
      opts.onComplete();
      return { runId: `run-${capturedContexts.length}`, abort: () => {} };
    });

    const { controller } = setupController(undefined, { guardianContext: initialCtx });

    // First turn: unverified
    await controller.handleCallerUtterance('Hello');
    expect(capturedContexts[0]).toEqual(initialCtx);

    // Simulate guardian verification succeeding
    controller.setGuardianContext(upgradedCtx);

    // Second turn: should use upgraded guardian context
    await controller.handleCallerUtterance('I verified');
    expect(capturedContexts[1]).toEqual(upgradedCtx);

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

  test('destroy: during active turn does not trigger post-turn side effects', async () => {
    // Simulate a turn that completes after destroy() is called
    mockStartVoiceTurn.mockImplementation(async (opts: { signal?: AbortSignal; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          opts.onTextDelta('This is a long response');
          opts.onComplete();
          resolve({ runId: 'run-1', abort: () => {} });
        }, 1000);

        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          // The defensive abort listener in runTurn resolves turnComplete
          opts.onComplete();
          resolve({ runId: 'run-1', abort: () => {} });
        }, { once: true });
      });
    });

    const { relay, controller } = setupController();
    const turnPromise = controller.handleCallerUtterance('Start speaking');

    // Let the turn start
    await new Promise((r) => setTimeout(r, 5));

    // Destroy the controller while the turn is active
    controller.destroy();

    // Wait for the turn to settle
    await turnPromise;

    // Verify that NO spurious post-turn side effects occurred after destroy:
    // - No final empty-string sendTextToken('', true) call after abort
    // The only end marker should be from handleInterrupt, not from post-turn logic
    const endMarkers = relay.sentTokens.filter((t) => t.token === '' && t.last === true);

    // destroy() increments llmRunVersion, so isCurrentRun() returns false
    // for the aborted turn, preventing post-turn side effects including
    // the spurious relay.sendTextToken('', true) on line 418.
    expect(endMarkers.length).toBe(0);
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

  // ── waiting_on_user re-entry guard ────────────────────────────────

  test('handleCallerUtterance: does NOT trigger startVoiceTurn when waiting_on_user', async () => {
    // Trigger ASK_GUARDIAN to enter waiting_on_user state
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Hold on. [ASK_GUARDIAN: What time works?]'],
    ));
    const { controller } = setupController();
    await controller.handleCallerUtterance('Book me in');
    expect(controller.getState()).toBe('waiting_on_user');

    // Track calls to startVoiceTurn from this point
    let turnCallCount = 0;
    mockStartVoiceTurn.mockImplementation(async (opts: { onTextDelta: (t: string) => void; onComplete: () => void }) => {
      turnCallCount++;
      opts.onTextDelta('Should not appear.');
      opts.onComplete();
      return { runId: 'run-blocked', abort: () => {} };
    });

    // Caller speaks while waiting — should be queued, not processed
    await controller.handleCallerUtterance('Hello? Are you still there?');
    expect(turnCallCount).toBe(0);
    expect(controller.getState()).toBe('waiting_on_user');

    controller.destroy();
  });

  test('queued caller utterance IS processed after handleUserAnswer resolves', async () => {
    // Trigger ASK_GUARDIAN to enter waiting_on_user state
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Checking. [ASK_GUARDIAN: Confirm appointment?]'],
    ));
    const { controller } = setupController();
    await controller.handleCallerUtterance('I want to schedule');
    expect(controller.getState()).toBe('waiting_on_user');

    // Caller speaks while waiting — queued
    await controller.handleCallerUtterance('Actually make it 4pm');

    // Set up mocks for the answer turn and subsequent queued utterance turn
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(async (opts: { content: string; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      turnContents.push(opts.content);
      if (opts.content.includes('[USER_ANSWERED:')) {
        opts.onTextDelta('Confirmed.');
      } else {
        opts.onTextDelta('Got it, 4pm.');
      }
      opts.onComplete();
      return { runId: `run-${turnContents.length}`, abort: () => {} };
    });

    const accepted = await controller.handleUserAnswer('Yes, confirmed');
    expect(accepted).toBe(true);

    // Give fire-and-forget turns time to complete
    await new Promise((r) => setTimeout(r, 100));

    // The answer turn should have fired
    expect(turnContents.some((c) => c.includes('[USER_ANSWERED: Yes, confirmed]'))).toBe(true);
    // The queued caller utterance should also have been processed
    expect(turnContents.some((c) => c.includes('Actually make it 4pm'))).toBe(true);

    controller.destroy();
  });

  test('no duplicate guardian dispatch: subsequent handleCallerUtterance during waiting_on_user does not produce another ASK_GUARDIAN', async () => {
    // Trigger ASK_GUARDIAN to enter waiting_on_user
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Let me ask. [ASK_GUARDIAN: Preferred date?]'],
    ));
    const { controller } = setupController();
    await controller.handleCallerUtterance('Schedule please');
    expect(controller.getState()).toBe('waiting_on_user');

    // Count how many times startVoiceTurn is invoked after this point
    let postGuardianTurnCount = 0;
    mockStartVoiceTurn.mockImplementation(async (opts: { onTextDelta: (t: string) => void; onComplete: () => void }) => {
      postGuardianTurnCount++;
      // Simulate the model trying to emit another ASK_GUARDIAN
      opts.onTextDelta('[ASK_GUARDIAN: Preferred date again?]');
      opts.onComplete();
      return { runId: 'run-dup', abort: () => {} };
    });

    // Multiple caller utterances during waiting_on_user — all should be queued
    await controller.handleCallerUtterance('Hello?');
    await controller.handleCallerUtterance('Anyone there?');

    // No turns should have started
    expect(postGuardianTurnCount).toBe(0);
    // State should still be waiting_on_user
    expect(controller.getState()).toBe('waiting_on_user');

    controller.destroy();
  });

  test('handleUserAnswer: returns false when not in waiting_on_user state (stale/duplicate guard)', async () => {
    const { controller } = setupController();

    // idle state
    expect(await controller.handleUserAnswer('some answer')).toBe(false);

    // processing state — trigger a turn first
    mockStartVoiceTurn.mockImplementation(async (opts: { onTextDelta: (t: string) => void; onComplete: () => void }) => {
      // Slow turn — give time to call handleUserAnswer while processing
      await new Promise((r) => setTimeout(r, 200));
      opts.onTextDelta('Response.');
      opts.onComplete();
      return { runId: 'run-proc', abort: () => {} };
    });
    const turnPromise = controller.handleCallerUtterance('Test');
    // Give it a moment to enter processing state
    await new Promise((r) => setTimeout(r, 10));
    expect(await controller.handleUserAnswer('stale answer')).toBe(false);

    // Clean up
    await turnPromise.catch(() => {});
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

  // ── Post-end-call drain guard ───────────────────────────────────

  test('handleUserAnswer: queued caller utterances are discarded (not processed) when answer turn ends the call', async () => {
    // Trigger ASK_GUARDIAN to enter waiting_on_user state
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Checking. [ASK_GUARDIAN: Confirm cancellation?]'],
    ));
    const { session, relay, controller } = setupController();
    await controller.handleCallerUtterance('I want to cancel');
    expect(controller.getState()).toBe('waiting_on_user');

    // Queue a caller utterance while waiting
    await controller.handleCallerUtterance('Never mind, just cancel it');

    // Set up mock so the answer turn ends the call with [END_CALL]
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(async (opts: { content: string; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      turnContents.push(opts.content);
      opts.onTextDelta('Alright, your appointment is cancelled. Goodbye! [END_CALL]');
      opts.onComplete();
      return { runId: `run-${turnContents.length}`, abort: () => {} };
    });

    const accepted = await controller.handleUserAnswer('Yes, cancel it');
    expect(accepted).toBe(true);

    // Give fire-and-forget turns time to complete
    await new Promise((r) => setTimeout(r, 100));

    // The answer turn should have fired
    expect(turnContents.some((c) => c.includes('[USER_ANSWERED: Yes, cancel it]'))).toBe(true);
    // The queued caller utterance should NOT have been processed — only the answer turn
    expect(turnContents.length).toBe(1);

    // Call should be completed
    const updatedSession = getCallSession(session.id);
    expect(updatedSession!.status).toBe('completed');
    expect(relay.endCalled).toBe(true);

    controller.destroy();
  });

  // ── Consultation timeout with merged instructions + utterances ──

  test('consultation timeout: merges pending instructions and caller utterances into a single turn', async () => {
    // Use a short consultation timeout so we can wait for it in the test
    mockConsultationTimeoutMs = 50;

    // Trigger ASK_GUARDIAN to enter waiting_on_user state
    mockStartVoiceTurn.mockImplementation(createMockVoiceTurn(
      ['Let me check. [ASK_GUARDIAN: What time works?]'],
    ));
    const { controller } = setupController();
    await controller.handleCallerUtterance('Book me in');
    expect(controller.getState()).toBe('waiting_on_user');

    // Queue an instruction and a caller utterance while waiting
    await controller.handleUserInstruction('Suggest morning slots');
    await controller.handleCallerUtterance('Actually, I prefer 10am');

    // Set up mock to capture what content the merged turn receives
    const turnContents: string[] = [];
    mockStartVoiceTurn.mockImplementation(async (opts: { content: string; onTextDelta: (t: string) => void; onComplete: () => void }) => {
      turnContents.push(opts.content);
      opts.onTextDelta('Got it, let me check 10am availability.');
      opts.onComplete();
      return { runId: `run-${turnContents.length}`, abort: () => {} };
    });

    // Wait for the short consultation timeout to fire
    await new Promise((r) => setTimeout(r, 200));

    // A single merged turn should have been fired containing both the
    // instruction marker and the caller utterance
    expect(turnContents.length).toBe(1);
    expect(turnContents[0]).toContain('[USER_INSTRUCTION: Suggest morning slots]');
    expect(turnContents[0]).toContain('Actually, I prefer 10am');

    controller.destroy();
  });
});

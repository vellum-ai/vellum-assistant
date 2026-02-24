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

// ── User reference mock ──────────────────────────────────────────────

let mockUserReference = 'my human';

mock.module('../config/user-reference.js', () => ({
  resolveUserReference: () => mockUserReference,
}));

// ── Config mock ─────────────────────────────────────────────────────

let mockCallModel: string | undefined = undefined;
let mockDisclosure: { enabled: boolean; text: string } = { enabled: false, text: '' };

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    apiKeys: { anthropic: 'test-key' },
    calls: {
      enabled: true,
      provider: 'twilio',
      maxDurationSeconds: 12 * 60,
      userConsultTimeoutSeconds: 90,
      userConsultationTimeoutSeconds: 90,
      silenceTimeoutSeconds: 30,
      disclosure: mockDisclosure,
      safety: { denyCategories: [] },
      model: mockCallModel,
    },
  }),
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
  getCallOrchestrator,
} from '../calls/call-state.js';
import { CallOrchestrator } from '../calls/call-orchestrator.js';
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
  updateCallSession(session.id, { status: 'in_progress' });
  const relay = createMockRelay();
  const orchestrator = new CallOrchestrator(session.id, relay as unknown as RelayConnection, task ?? null);
  return { session, relay, orchestrator };
}

describe('call-orchestrator', () => {
  beforeEach(() => {
    resetTables();
    mockCallModel = undefined;
    mockUserReference = 'my human';
    mockDisclosure = { enabled: false, text: '' };
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

  test('handleCallerUtterance: includes speaker context in model message', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      const userMessage = firstArg.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toContain('[SPEAKER id="speaker-1" label="Aaron" source="provider" confidence="0.91"]');
      expect(userMessage?.content).toContain('Can you summarize this meeting?');
      return createMockStream(['Sure, here is a summary.']);
    });

    const { orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('Can you summarize this meeting?', {
      speakerId: 'speaker-1',
      speakerLabel: 'Aaron',
      speakerConfidence: 0.91,
      source: 'provider',
    });

    orchestrator.destroy();
  });

  test('startInitialGreeting: generates model-driven opening and strips control marker from speech', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      const firstUser = firstArg.messages.find((m) => m.role === 'user');
      expect(firstUser?.content).toContain('[CALL_OPENING]');
      return createMockStream(['Hi, I am calling about your appointment request. Is now a good time to talk?']);
    });

    const { relay, orchestrator } = setupOrchestrator('Confirm appointment');

    const callCountBefore = mockStreamFn.mock.calls.length;
    await orchestrator.startInitialGreeting();
    await orchestrator.startInitialGreeting();

    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).toContain('appointment request');
    expect(allText).toContain('good time to talk');
    expect(allText).not.toContain('[CALL_OPENING]');
    expect(mockStreamFn.mock.calls.length - callCountBefore).toBe(1);

    orchestrator.destroy();
  });

  test('startInitialGreeting: tags only the first caller response with CALL_OPENING_ACK', async () => {
    let callCount = 0;
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      callCount++;
      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      const userMessages = firstArg.messages.filter((m) => m.role === 'user');
      const lastUser = userMessages[userMessages.length - 1]?.content ?? '';

      if (callCount === 1) {
        expect(lastUser).toContain('[CALL_OPENING]');
        return createMockStream(['Hey Noa, it\'s Credence calling about your joke request. Is now okay for a quick one?']);
      }

      if (callCount === 2) {
        expect(lastUser).toContain('[CALL_OPENING_ACK]');
        expect(lastUser).toContain('Yeah. Sure. What\'s up?');
        return createMockStream(['Great, here\'s one right away. Why did the scarecrow win an award?']);
      }

      expect(lastUser).not.toContain('[CALL_OPENING_ACK]');
      expect(lastUser).toContain('Tell me the punchline');
      return createMockStream(['Because he was outstanding in his field.']);
    });

    const { orchestrator } = setupOrchestrator('Tell a joke immediately');

    await orchestrator.startInitialGreeting();
    await orchestrator.handleCallerUtterance('Yeah. Sure. What\'s up?');
    await orchestrator.handleCallerUtterance('Tell me the punchline');

    expect(callCount).toBe(3);

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

  test('strips internal context markers from spoken output', async () => {
    mockStreamFn.mockImplementation(() =>
      createMockStream([
        'Thanks for waiting. ',
        '[USER_ANSWERED: The guardian said 3 PM works.] ',
        '[USER_INSTRUCTION: Keep this short.] ',
        '[CALL_OPENING_ACK] ',
        'I can confirm 3 PM works.',
      ]),
    );
    const { relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('Any update?');

    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).toContain('Thanks for waiting.');
    expect(allText).toContain('I can confirm 3 PM works.');
    expect(allText).not.toContain('[USER_ANSWERED:');
    expect(allText).not.toContain('[USER_INSTRUCTION:');
    expect(allText).not.toContain('[CALL_OPENING_ACK]');
    expect(allText).not.toContain('USER_ANSWERED');
    expect(allText).not.toContain('USER_INSTRUCTION');
    expect(allText).not.toContain('CALL_OPENING_ACK');

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

  test('handleUserAnswer: returns true immediately and fires LLM asynchronously', async () => {
    // First utterance triggers ASK_USER
    mockStreamFn.mockImplementation(() =>
      createMockStream(['Hold on. [ASK_USER: Preferred time?]']),
    );
    const { relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('I need an appointment');

    // Now provide the answer — reset mock for second LLM call
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      // Verify the messages include the USER_ANSWERED marker
      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      const lastUserMsg = firstArg.messages.filter((m: { role: string }) => m.role === 'user').pop();
      expect(lastUserMsg?.content).toContain('[USER_ANSWERED: 3pm tomorrow]');
      return createMockStream(['Great, I have scheduled for 3pm tomorrow.']);
    });

    const accepted = await orchestrator.handleUserAnswer('3pm tomorrow');
    expect(accepted).toBe(true);

    // handleUserAnswer fires runLlm without awaiting, so give the
    // microtask queue a tick to let the async LLM work complete.
    await new Promise((r) => setTimeout(r, 50));

    // Should have streamed a response for the answer
    const tokensAfterAnswer = relay.sentTokens.filter((t) => t.token.includes('3pm'));
    expect(tokensAfterAnswer.length).toBeGreaterThan(0);

    orchestrator.destroy();
  });

  // ── Full mid-call question flow ──────────────────────────────────

  test('mid-call question flow: unavailable time → ask user → user confirms → resumed call', async () => {
    // Step 1: Caller says "7:30" but it's unavailable. The LLM asks the user.
    mockStreamFn.mockImplementation(() =>
      createMockStream(['I\'m sorry, 7:30 is not available. ', '[ASK_USER: Is 8:00 okay instead?]']),
    );

    const { session, relay, orchestrator } = setupOrchestrator('Schedule a haircut');

    await orchestrator.handleCallerUtterance('Can I book for 7:30?');

    // Verify we're in waiting_on_user state
    expect(orchestrator.getState()).toBe('waiting_on_user');
    const question = getPendingQuestion(session.id);
    expect(question).not.toBeNull();
    expect(question!.questionText).toBe('Is 8:00 okay instead?');

    // Verify session status
    const midSession = getCallSession(session.id);
    expect(midSession!.status).toBe('waiting_on_user');

    // Step 2: User answers "Yes, 8:00 works"
    mockStreamFn.mockImplementation(() =>
      createMockStream(['Great, I\'ve booked you for 8:00. See you then! ', '[END_CALL]']),
    );

    const accepted = await orchestrator.handleUserAnswer('Yes, 8:00 works for me');
    expect(accepted).toBe(true);

    // Give the fire-and-forget LLM call time to complete
    await new Promise((r) => setTimeout(r, 50));

    // Step 3: Verify call completed
    const endSession = getCallSession(session.id);
    expect(endSession!.status).toBe('completed');
    expect(endSession!.endedAt).not.toBeNull();

    // Verify the END_CALL marker triggered endSession on relay
    expect(relay.endCalled).toBe(true);

    orchestrator.destroy();
  });

  // ── Provider / LLM failure paths ───────────────────────────────

  test('LLM error: sends error message to caller and returns to idle', async () => {
    // Make the stream throw an error on finalMessage
    mockStreamFn.mockImplementation(() => {
      const emitter = new EventEmitter();
      return {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.on(event, handler);
          return { on: () => ({ on: () => ({}) }) };
        },
        finalMessage: () => Promise.reject(new Error('API rate limit exceeded')),
      };
    });

    const { relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('Hello');

    // Should have sent an error recovery message
    const errorTokens = relay.sentTokens.filter((t) =>
      t.token.includes('technical issue'),
    );
    expect(errorTokens.length).toBeGreaterThan(0);

    // State should return to idle after error
    expect(orchestrator.getState()).toBe('idle');

    orchestrator.destroy();
  });

  test('LLM APIUserAbortError: treats as expected abort without technical-issue fallback', async () => {
    mockStreamFn.mockImplementation(() => {
      const emitter = new EventEmitter();
      return {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.on(event, handler);
          return { on: () => ({ on: () => ({}) }) };
        },
        finalMessage: () => {
          const err = new Error('user abort');
          err.name = 'APIUserAbortError';
          return Promise.reject(err);
        },
      };
    });

    const { relay, orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');

    const errorTokens = relay.sentTokens.filter((t) => t.token.includes('technical issue'));
    expect(errorTokens.length).toBe(0);
    expect(orchestrator.getState()).toBe('idle');

    orchestrator.destroy();
  });

  test('stale superseded turn errors do not emit technical-issue fallback', async () => {
    let callCount = 0;
    mockStreamFn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const emitter = new EventEmitter();
        return {
          on: (event: string, handler: (...args: unknown[]) => void) => {
            emitter.on(event, handler);
            return { on: () => ({ on: () => ({}) }) };
          },
          finalMessage: () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('stale stream failure')), 20);
            }),
        };
      }
      return createMockStream(['Second turn response.']);
    });

    const { relay, orchestrator } = setupOrchestrator();

    const firstTurnPromise = orchestrator.handleCallerUtterance('First utterance');
    // Allow the first turn to enter runLlm before the second utterance interrupts it.
    await new Promise((r) => setTimeout(r, 5));
    const secondTurnPromise = orchestrator.handleCallerUtterance('Second utterance');

    await Promise.all([firstTurnPromise, secondTurnPromise]);

    const allTokens = relay.sentTokens.map((t) => t.token).join('');
    expect(allTokens).toContain('Second turn response.');
    expect(allTokens).not.toContain('technical issue');

    orchestrator.destroy();
  });

  test('rapid caller barge-in coalesces contiguous user turns for role alternation', async () => {
    let callCount = 0;
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        const emitter = new EventEmitter();
        const options = args[1] as { signal?: AbortSignal } | undefined;
        return {
          on: (event: string, handler: (...evtArgs: unknown[]) => void) => {
            emitter.on(event, handler);
            return { on: () => ({ on: () => ({}) }) };
          },
          finalMessage: () =>
            new Promise((_, reject) => {
              options?.signal?.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              }, { once: true });
            }),
        };
      }

      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      const roles = firstArg.messages.map((m) => m.role);
      for (let i = 1; i < roles.length; i++) {
        expect(!(roles[i - 1] === 'user' && roles[i] === 'user')).toBe(true);
      }
      const userMessages = firstArg.messages.filter((m) => m.role === 'user');
      const lastUser = userMessages[userMessages.length - 1];
      expect(lastUser?.content).toContain('First caller utterance');
      expect(lastUser?.content).toContain('Second caller utterance');
      return createMockStream(['Merged turn handled.']);
    });

    const { relay, orchestrator } = setupOrchestrator();
    const firstTurnPromise = orchestrator.handleCallerUtterance('First caller utterance');
    await new Promise((r) => setTimeout(r, 5));
    const secondTurnPromise = orchestrator.handleCallerUtterance('Second caller utterance');

    await Promise.all([firstTurnPromise, secondTurnPromise]);

    const allTokens = relay.sentTokens.map((t) => t.token).join('');
    expect(allTokens).toContain('Merged turn handled.');

    orchestrator.destroy();
  });

  test('interrupt then next caller prompt still preserves role alternation', async () => {
    let callCount = 0;
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        const emitter = new EventEmitter();
        const options = args[1] as { signal?: AbortSignal } | undefined;
        return {
          on: (event: string, handler: (...evtArgs: unknown[]) => void) => {
            emitter.on(event, handler);
            return { on: () => ({ on: () => ({}) }) };
          },
          finalMessage: () =>
            new Promise((_, reject) => {
              options?.signal?.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              }, { once: true });
            }),
        };
      }

      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      const roles = firstArg.messages.map((m) => m.role);
      for (let i = 1; i < roles.length; i++) {
        expect(!(roles[i - 1] === 'user' && roles[i] === 'user')).toBe(true);
      }
      const userMessages = firstArg.messages.filter((m) => m.role === 'user');
      const lastUser = userMessages[userMessages.length - 1];
      expect(lastUser?.content).toContain('First caller utterance');
      expect(lastUser?.content).toContain('Second caller utterance');
      return createMockStream(['Post-interrupt response.']);
    });

    const { relay, orchestrator } = setupOrchestrator();
    const firstTurnPromise = orchestrator.handleCallerUtterance('First caller utterance');
    await new Promise((r) => setTimeout(r, 5));
    orchestrator.handleInterrupt();
    const secondTurnPromise = orchestrator.handleCallerUtterance('Second caller utterance');

    await Promise.all([firstTurnPromise, secondTurnPromise]);

    const allTokens = relay.sentTokens.map((t) => t.token).join('');
    expect(allTokens).toContain('Post-interrupt response.');
    expect(allTokens).not.toContain('technical issue');

    orchestrator.destroy();
  });

  test('handleUserAnswer: returns false when not in waiting_on_user state', async () => {
    const { orchestrator } = setupOrchestrator();

    // Orchestrator starts in idle state
    const result = await orchestrator.handleUserAnswer('some answer');
    expect(result).toBe(false);

    orchestrator.destroy();
  });

  // ── handleInterrupt ───────────────────────────────────────────────

  test('handleInterrupt: resets state to idle', () => {
    const { orchestrator } = setupOrchestrator();

    // Calling handleInterrupt should not throw
    orchestrator.handleInterrupt();

    orchestrator.destroy();
  });

  test('handleInterrupt: increments llmRunVersion to suppress stale turn side effects', async () => {
    // Use a stream whose finalMessage resolves immediately but whose
    // continuation (the code after `await stream.finalMessage()`) will
    // run asynchronously. This simulates the race where the promise
    // microtask is queued right as handleInterrupt fires.
    mockStreamFn.mockImplementation(() => {
      const emitter = new EventEmitter();
      return {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.on(event, handler);
          return { on: () => ({ on: () => ({}) }) };
        },
        finalMessage: () => {
          // Emit some tokens synchronously
          emitter.emit('text', 'Stale response that should be suppressed.');
          return Promise.resolve({
            content: [{ type: 'text', text: 'Stale response that should be suppressed.' }],
          });
        },
      };
    });

    const { relay, orchestrator } = setupOrchestrator();

    // Start an LLM turn (don't await — we want to interrupt mid-flight)
    const turnPromise = orchestrator.handleCallerUtterance('Hello');

    // Interrupt immediately. Because finalMessage resolves as a microtask,
    // its continuation hasn't run yet. handleInterrupt increments
    // llmRunVersion so the continuation's isCurrentRun check will fail.
    orchestrator.handleInterrupt();

    // Let the stale turn's microtask continuation execute
    await turnPromise;

    // The orchestrator should remain idle — the stale turn must not
    // have pushed state to waiting_on_user or any other post-turn state.
    expect(orchestrator.getState()).toBe('idle');

    // No technical-issue fallback should have been sent
    const errorTokens = relay.sentTokens.filter((t) => t.token.includes('technical issue'));
    expect(errorTokens.length).toBe(0);

    // endSession should NOT have been called by the stale turn
    expect(relay.endCalled).toBe(false);

    orchestrator.destroy();
  });

  test('handleInterrupt: sends turn terminator when interrupting active speech', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const emitter = new EventEmitter();
      const options = args[1] as { signal?: AbortSignal } | undefined;
      return {
        on: (event: string, handler: (...evtArgs: unknown[]) => void) => {
          emitter.on(event, handler);
          return { on: () => ({ on: () => ({}) }) };
        },
        finalMessage: () =>
          new Promise((_, reject) => {
            options?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          }),
      };
    });

    const { relay, orchestrator } = setupOrchestrator();
    const turnPromise = orchestrator.handleCallerUtterance('Start speaking');
    await new Promise((r) => setTimeout(r, 5));
    orchestrator.handleInterrupt();
    await turnPromise;

    const endTurnMarkers = relay.sentTokens.filter((t) => t.token === '' && t.last === true);
    expect(endTurnMarkers.length).toBeGreaterThan(0);

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

  // ── Model override from config ──────────────────────────────────────

  test('uses default model when calls.model is not set', async () => {
    mockCallModel = undefined;
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { model: string };
      expect(firstArg.model).toBe('claude-sonnet-4-20250514');
      return createMockStream(['Default model response.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  test('uses calls.model override from config when set', async () => {
    mockCallModel = 'claude-haiku-4-5-20251001';
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { model: string };
      expect(firstArg.model).toBe('claude-haiku-4-5-20251001');
      return createMockStream(['Override model response.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  test('treats empty string calls.model as unset and falls back to default', async () => {
    mockCallModel = '';
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { model: string };
      expect(firstArg.model).toBe('claude-sonnet-4-20250514');
      return createMockStream(['Fallback model response.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  test('treats whitespace-only calls.model as unset and falls back to default', async () => {
    mockCallModel = '   ';
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { model: string };
      expect(firstArg.model).toBe('claude-sonnet-4-20250514');
      return createMockStream(['Fallback model response.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  // ── handleUserInstruction ─────────────────────────────────────────

  test('handleUserInstruction: injects instruction marker into conversation history and triggers LLM when idle', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      const instructionMsg = firstArg.messages.find((m) =>
        m.role === 'user' && m.content.includes('[USER_INSTRUCTION:'),
      );
      expect(instructionMsg).toBeDefined();
      expect(instructionMsg!.content).toContain('[USER_INSTRUCTION: Ask about their weekend plans]');
      return createMockStream(['Sure, do you have any weekend plans?']);
    });

    const { relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleUserInstruction('Ask about their weekend plans');

    // Should have streamed a response since orchestrator was idle
    const nonEmptyTokens = relay.sentTokens.filter((t) => t.token.length > 0);
    expect(nonEmptyTokens.length).toBeGreaterThan(0);

    orchestrator.destroy();
  });

  test('handleUserInstruction: does not break existing answer flow', async () => {
    // Step 1: Caller says something, LLM responds normally
    mockStreamFn.mockImplementation(() => createMockStream(['Hello! How can I help you today?']));
    const { session: _session, relay, orchestrator } = setupOrchestrator('Book appointment');

    await orchestrator.handleCallerUtterance('Hi there');

    // Step 2: Inject an instruction while idle
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { messages: Array<{ role: string; content: string }> };
      // Verify the history contains both the original exchange and the instruction
      const messages = firstArg.messages;
      expect(messages.length).toBeGreaterThanOrEqual(3); // user utterance + assistant response + instruction
      const instructionMsg = messages.find((m) =>
        m.role === 'user' && m.content.includes('[USER_INSTRUCTION:'),
      );
      expect(instructionMsg).toBeDefined();
      return createMockStream(['Of course, let me mention the weekend special.']);
    });

    await orchestrator.handleUserInstruction('Mention the weekend special');

    // Step 3: Caller speaks again — the flow should continue normally
    mockStreamFn.mockImplementation(() =>
      createMockStream(['Great choice! The weekend special is 20% off.']),
    );

    await orchestrator.handleCallerUtterance('Tell me more about that');

    // Verify state is idle after the normal flow
    expect(orchestrator.getState()).toBe('idle');

    // Verify relay received tokens from all exchanges
    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).toContain('Hello');
    expect(allText).toContain('weekend special');

    orchestrator.destroy();
  });

  test('handleUserInstruction: emits user_instruction_relayed event', async () => {
    mockStreamFn.mockImplementation(() => createMockStream(['Understood, adjusting approach.']));

    const { session, orchestrator } = setupOrchestrator();

    await orchestrator.handleUserInstruction('Be more formal in your tone');

    const events = getCallEvents(session.id);
    const instructionEvents = events.filter((e) => e.eventType === 'user_instruction_relayed');
    expect(instructionEvents.length).toBe(1);

    const payload = JSON.parse(instructionEvents[0].payloadJson);
    expect(payload.instruction).toBe('Be more formal in your tone');

    orchestrator.destroy();
  });

  test('handleUserInstruction: does not trigger LLM when orchestrator is not idle', async () => {
    // First, trigger ASK_USER so orchestrator enters waiting_on_user
    mockStreamFn.mockImplementation(() =>
      createMockStream(['Hold on. [ASK_USER: What time?]']),
    );

    const { session, orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('I need an appointment');
    expect(orchestrator.getState()).toBe('waiting_on_user');

    // Track how many times the stream mock is called
    let streamCallCount = 0;
    mockStreamFn.mockImplementation(() => {
      streamCallCount++;
      return createMockStream(['Response after instruction.']);
    });

    // Inject instruction while in waiting_on_user state
    await orchestrator.handleUserInstruction('Suggest morning slots');

    // The LLM should NOT have been triggered since we're not idle
    expect(streamCallCount).toBe(0);

    // But the event should still be recorded
    const events = getCallEvents(session.id);
    const instructionEvents = events.filter((e) => e.eventType === 'user_instruction_relayed');
    expect(instructionEvents.length).toBe(1);

    orchestrator.destroy();
  });

  // ── System prompt: identity phrasing ────────────────────────────────

  test('system prompt contains resolved user reference (default)', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      expect(firstArg.system).toContain('on behalf of my human');
      return createMockStream(['Hello.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('system prompt contains resolved user reference when set to a name', async () => {
    mockUserReference = 'John';
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      expect(firstArg.system).toContain('on behalf of John');
      return createMockStream(['Hello John\'s contact.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('system prompt does not hardcode "your user" in the opening line', async () => {
    mockUserReference = 'Alice';
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      expect(firstArg.system).not.toContain('on behalf of your user');
      expect(firstArg.system).toContain('on behalf of Alice');
      return createMockStream(['Hi there.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  test('system prompt includes assistant identity bias rule', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      expect(firstArg.system).toContain('refer to yourself as an assistant');
      expect(firstArg.system).toContain('Avoid the phrase "AI assistant" unless directly asked');
      return createMockStream(['Sure thing.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('system prompt includes opening-ack guidance to avoid duplicate introductions', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      expect(firstArg.system).toContain('[CALL_OPENING_ACK]');
      expect(firstArg.system).toContain('without re-introducing yourself');
      return createMockStream(['Understood.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('assistant identity rule appears before disclosure rule in prompt', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      const prompt = firstArg.system;
      const identityIdx = prompt.indexOf('refer to yourself as an assistant');
      const disclosureIdx = prompt.indexOf('Be concise');
      expect(identityIdx).toBeGreaterThan(-1);
      expect(disclosureIdx).toBeGreaterThan(-1);
      expect(identityIdx).toBeLessThan(disclosureIdx);
      return createMockStream(['OK.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Test');
    orchestrator.destroy();
  });

  test('system prompt uses disclosure text when disclosure is enabled', async () => {
    mockDisclosure = {
      enabled: true,
      text: 'At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".',
    };
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      expect(firstArg.system).toContain('introduce yourself as an assistant calling on behalf of the person you represent');
      expect(firstArg.system).toContain('Do not say "AI assistant"');
      return createMockStream(['Hello, I am calling on behalf of my human.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Who is this?');
    orchestrator.destroy();
  });

  test('system prompt falls back to "Begin the conversation naturally" when disclosure is disabled', async () => {
    mockDisclosure = { enabled: false, text: '' };
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      expect(firstArg.system).toContain('Begin the conversation naturally');
      expect(firstArg.system).not.toContain('introduce yourself as an assistant calling on behalf of the person');
      return createMockStream(['Hello there.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('system prompt does not use "AI assistant" as a self-identity label', async () => {
    mockStreamFn.mockImplementation((...args: unknown[]) => {
      const firstArg = args[0] as { system: string };
      expect(firstArg.system).not.toMatch(/(?:you are|call yourself|introduce yourself as).*AI assistant/i);
      return createMockStream(['Got it.']);
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });
});

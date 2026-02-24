import { describe, test, expect, beforeEach, afterAll, mock, type Mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      disclosure: mockDisclosure,
      safety: { denyCategories: [] },
      model: mockCallModel,
    },
  }),
}));

// ── Helpers for building mock provider responses ────────────────────

/**
 * Creates a mock provider sendMessage implementation that emits text_delta
 * events for each token and resolves with the full response.
 */
function createMockProviderResponse(tokens: string[]) {
  const fullText = tokens.join('');
  return async (
    _messages: unknown[],
    _tools: unknown[],
    _systemPrompt: string,
    options?: { onEvent?: (event: { type: string; text?: string }) => void; signal?: AbortSignal },
  ) => {
    // Emit text_delta events for each token
    for (const token of tokens) {
      options?.onEvent?.({ type: 'text_delta', text: token });
    }
    return {
      content: [{ type: 'text', text: fullText }],
      model: 'claude-sonnet-4-20250514',
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: 'end_turn',
    };
  };
}

// ── Provider registry mock ──────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSendMessage: Mock<(...args: any[]) => Promise<any>>;

mock.module('../providers/registry.js', () => {
  mockSendMessage = mock(createMockProviderResponse(['Hello', ' there']));
  return {
    listProviders: () => ['anthropic'],
    getFailoverProvider: () => ({
      name: 'anthropic',
      sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    }),
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
    // Reset the provider mock to default behaviour
    mockSendMessage.mockImplementation(createMockProviderResponse(['Hello', ' there']));
  });

  // ── handleCallerUtterance ─────────────────────────────────────────

  test('handleCallerUtterance: streams tokens via sendTextToken', async () => {
    mockSendMessage.mockImplementation(createMockProviderResponse(['Hi', ', how', ' are you?']));
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
    mockSendMessage.mockImplementation(createMockProviderResponse(['Simple response.']));
    const { relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('Test');

    // Find the final empty-string token that marks end of turn
    const endMarkers = relay.sentTokens.filter((t) => t.last === true);
    expect(endMarkers.length).toBeGreaterThanOrEqual(1);

    orchestrator.destroy();
  });

  test('handleCallerUtterance: includes speaker context in model message', async () => {
    mockSendMessage.mockImplementation(async (messages: unknown[], ..._rest: unknown[]) => {
      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      const userMessage = msgs.find((m) => m.role === 'user');
      const userText = userMessage?.content?.[0]?.text ?? '';
      expect(userText).toContain('[SPEAKER id="speaker-1" label="Aaron" source="provider" confidence="0.91"]');
      expect(userText).toContain('Can you summarize this meeting?');
      return {
        content: [{ type: 'text', text: 'Sure, here is a summary.' }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
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
    mockSendMessage.mockImplementation(async (messages: unknown[], ..._rest: unknown[]) => {
      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      const firstUser = msgs.find((m) => m.role === 'user');
      expect(firstUser?.content?.[0]?.text).toContain('[CALL_OPENING]');
      const tokens = ['Hi, I am calling about your appointment request. Is now a good time to talk?'];
      const opts = _rest[2] as { onEvent?: (event: { type: string; text?: string }) => void } | undefined;
      for (const token of tokens) {
        opts?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { relay, orchestrator } = setupOrchestrator('Confirm appointment');

    const callCountBefore = mockSendMessage.mock.calls.length;
    await orchestrator.startInitialGreeting();
    await orchestrator.startInitialGreeting();

    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).toContain('appointment request');
    expect(allText).toContain('good time to talk');
    expect(allText).not.toContain('[CALL_OPENING]');
    expect(mockSendMessage.mock.calls.length - callCountBefore).toBe(1);

    orchestrator.destroy();
  });

  test('startInitialGreeting: tags only the first caller response with CALL_OPENING_ACK', async () => {
    let callCount = 0;
    mockSendMessage.mockImplementation(async (messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      callCount++;
      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      const userMessages = msgs.filter((m) => m.role === 'user');
      const lastUser = userMessages[userMessages.length - 1]?.content?.[0]?.text ?? '';

      let tokens: string[];
      if (callCount === 1) {
        expect(lastUser).toContain('[CALL_OPENING]');
        tokens = ['Hey Noa, it\'s Credence calling about your joke request. Is now okay for a quick one?'];
      } else if (callCount === 2) {
        expect(lastUser).toContain('[CALL_OPENING_ACK]');
        expect(lastUser).toContain('Yeah. Sure. What\'s up?');
        tokens = ['Great, here\'s one right away. Why did the scarecrow win an award?'];
      } else {
        expect(lastUser).not.toContain('[CALL_OPENING_ACK]');
        expect(lastUser).toContain('Tell me the punchline');
        tokens = ['Because he was outstanding in his field.'];
      }

      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator('Tell a joke immediately');

    await orchestrator.startInitialGreeting();
    await orchestrator.handleCallerUtterance('Yeah. Sure. What\'s up?');
    await orchestrator.handleCallerUtterance('Tell me the punchline');

    expect(callCount).toBe(3);

    orchestrator.destroy();
  });

  // ── ASK_GUARDIAN pattern ──────────────────────────────────────────

  test('ASK_GUARDIAN pattern: detects pattern, creates pending question, enters waiting_on_user', async () => {
    mockSendMessage.mockImplementation(createMockProviderResponse(
      ['Let me check on that. ', '[ASK_GUARDIAN: What date works best?]'],
    ));
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

    // The ASK_GUARDIAN marker text should NOT appear in the relay tokens
    const allText = relay.sentTokens.map((t) => t.token).join('');
    expect(allText).not.toContain('[ASK_GUARDIAN:');

    orchestrator.destroy();
  });

  test('strips internal context markers from spoken output', async () => {
    mockSendMessage.mockImplementation(createMockProviderResponse([
      'Thanks for waiting. ',
      '[USER_ANSWERED: The guardian said 3 PM works.] ',
      '[USER_INSTRUCTION: Keep this short.] ',
      '[CALL_OPENING_ACK] ',
      'I can confirm 3 PM works.',
    ]));
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
    mockSendMessage.mockImplementation(createMockProviderResponse(
      ['Thank you for calling, goodbye! ', '[END_CALL]'],
    ));
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
    // First utterance triggers ASK_GUARDIAN
    mockSendMessage.mockImplementation(createMockProviderResponse(
      ['Hold on. [ASK_GUARDIAN: Preferred time?]'],
    ));
    const { relay, orchestrator } = setupOrchestrator();

    await orchestrator.handleCallerUtterance('I need an appointment');

    // Now provide the answer — reset mock for second LLM call
    mockSendMessage.mockImplementation(async (messages: unknown[], ..._rest: unknown[]) => {
      // Verify the messages include the USER_ANSWERED marker
      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      const lastUserMsg = msgs.filter((m) => m.role === 'user').pop();
      expect(lastUserMsg?.content?.[0]?.text).toContain('[USER_ANSWERED: 3pm tomorrow]');
      const tokens = ['Great, I have scheduled for 3pm tomorrow.'];
      const opts = _rest[2] as { onEvent?: (event: { type: string; text?: string }) => void } | undefined;
      for (const token of tokens) {
        opts?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
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
    mockSendMessage.mockImplementation(createMockProviderResponse(
      ['I\'m sorry, 7:30 is not available. ', '[ASK_GUARDIAN: Is 8:00 okay instead?]'],
    ));

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
    mockSendMessage.mockImplementation(createMockProviderResponse(
      ['Great, I\'ve booked you for 8:00. See you then! ', '[END_CALL]'],
    ));

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
    // Make sendMessage reject with an error
    mockSendMessage.mockImplementation(async () => {
      throw new Error('API rate limit exceeded');
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
    mockSendMessage.mockImplementation(async () => {
      const err = new Error('user abort');
      err.name = 'APIUserAbortError';
      throw err;
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
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      callCount++;
      if (callCount === 1) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('stale stream failure')), 20);
        });
      }
      const tokens = ['Second turn response.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
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

  test('barge-in cleanup never sends empty user turns to provider', async () => {
    let callCount = 0;
    mockSendMessage.mockImplementation(async (messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void; signal?: AbortSignal }) => {
      callCount++;

      // Initial outbound opener
      if (callCount === 1) {
        const tokens = ['Hey Noa, this is Credence calling.'];
        for (const token of tokens) {
          options?.onEvent?.({ type: 'text_delta', text: token });
        }
        return {
          content: [{ type: 'text', text: tokens.join('') }],
          model: 'claude-sonnet-4-20250514',
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: 'end_turn',
        };
      }

      // First caller turn enters an in-flight LLM run that gets interrupted
      if (callCount === 2) {
        return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }

      // Second caller turn should never include an empty user message.
      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      const userMessages = msgs.filter((m) => m.role === 'user');
      expect(userMessages.length).toBeGreaterThan(0);
      expect(userMessages.every((m) => m.content?.[0]?.text?.trim().length > 0)).toBe(true);
      const tokens = ['Got it, thanks for clarifying.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { relay, orchestrator } = setupOrchestrator('Quick check-in');
    await orchestrator.startInitialGreeting();

    const firstTurnPromise = orchestrator.handleCallerUtterance('Hello?');
    await new Promise((r) => setTimeout(r, 5));
    const secondTurnPromise = orchestrator.handleCallerUtterance('What have you been up to lately?');

    await Promise.all([firstTurnPromise, secondTurnPromise]);

    const allTokens = relay.sentTokens.map((t) => t.token).join('');
    expect(allTokens).toContain('Got it, thanks for clarifying.');
    expect(allTokens).not.toContain('technical issue');

    orchestrator.destroy();
  });

  test('rapid caller barge-in coalesces contiguous user turns for role alternation', async () => {
    let callCount = 0;
    mockSendMessage.mockImplementation(async (messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void; signal?: AbortSignal }) => {
      callCount++;
      if (callCount === 1) {
        return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }

      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      const roles = msgs.map((m) => m.role);
      for (let i = 1; i < roles.length; i++) {
        expect(!(roles[i - 1] === 'user' && roles[i] === 'user')).toBe(true);
      }
      const userMessages = msgs.filter((m) => m.role === 'user');
      const lastUser = userMessages[userMessages.length - 1];
      expect(lastUser?.content?.[0]?.text).toContain('First caller utterance');
      expect(lastUser?.content?.[0]?.text).toContain('Second caller utterance');
      const tokens = ['Merged turn handled.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
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
    mockSendMessage.mockImplementation(async (messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void; signal?: AbortSignal }) => {
      callCount++;
      if (callCount === 1) {
        return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }

      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      const roles = msgs.map((m) => m.role);
      for (let i = 1; i < roles.length; i++) {
        expect(!(roles[i - 1] === 'user' && roles[i] === 'user')).toBe(true);
      }
      const userMessages = msgs.filter((m) => m.role === 'user');
      const lastUser = userMessages[userMessages.length - 1];
      expect(lastUser?.content?.[0]?.text).toContain('First caller utterance');
      expect(lastUser?.content?.[0]?.text).toContain('Second caller utterance');
      const tokens = ['Post-interrupt response.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
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
    // Use a sendMessage that resolves immediately but whose continuation
    // (the code after `await provider.sendMessage()`) will run asynchronously.
    // This simulates the race where the promise microtask is queued right
    // as handleInterrupt fires.
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      // Emit some tokens synchronously
      options?.onEvent?.({ type: 'text_delta', text: 'Stale response that should be suppressed.' });
      return {
        content: [{ type: 'text', text: 'Stale response that should be suppressed.' }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { relay, orchestrator } = setupOrchestrator();

    // Start an LLM turn (don't await — we want to interrupt mid-flight)
    const turnPromise = orchestrator.handleCallerUtterance('Hello');

    // Interrupt immediately. Because sendMessage resolves as a microtask,
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
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void; signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
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
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { config?: { model: string }; onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(options?.config?.model).toBe('claude-sonnet-4-20250514');
      const tokens = ['Default model response.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  test('uses calls.model override from config when set', async () => {
    mockCallModel = 'claude-haiku-4-5-20251001';
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { config?: { model: string }; onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(options?.config?.model).toBe('claude-haiku-4-5-20251001');
      const tokens = ['Override model response.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-haiku-4-5-20251001',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  test('treats empty string calls.model as unset and falls back to default', async () => {
    mockCallModel = '';
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { config?: { model: string }; onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(options?.config?.model).toBe('claude-sonnet-4-20250514');
      const tokens = ['Fallback model response.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  test('treats whitespace-only calls.model as unset and falls back to default', async () => {
    mockCallModel = '   ';
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { config?: { model: string }; onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(options?.config?.model).toBe('claude-sonnet-4-20250514');
      const tokens = ['Fallback model response.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  // ── handleUserInstruction ─────────────────────────────────────────

  test('handleUserInstruction: injects instruction marker into conversation history and triggers LLM when idle', async () => {
    mockSendMessage.mockImplementation(async (messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      const instructionMsg = msgs.find((m) =>
        m.role === 'user' && m.content?.[0]?.text?.includes('[USER_INSTRUCTION:'),
      );
      expect(instructionMsg).toBeDefined();
      expect(instructionMsg!.content[0].text).toContain('[USER_INSTRUCTION: Ask about their weekend plans]');
      const tokens = ['Sure, do you have any weekend plans?'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
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
    mockSendMessage.mockImplementation(createMockProviderResponse(['Hello! How can I help you today?']));
    const { session: _session, relay, orchestrator } = setupOrchestrator('Book appointment');

    await orchestrator.handleCallerUtterance('Hi there');

    // Step 2: Inject an instruction while idle
    mockSendMessage.mockImplementation(async (messages: unknown[], _tools: unknown[], _systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      const msgs = messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      // Verify the history contains both the original exchange and the instruction
      expect(msgs.length).toBeGreaterThanOrEqual(3); // user utterance + assistant response + instruction
      const instructionMsg = msgs.find((m) =>
        m.role === 'user' && m.content?.[0]?.text?.includes('[USER_INSTRUCTION:'),
      );
      expect(instructionMsg).toBeDefined();
      const tokens = ['Of course, let me mention the weekend special.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    await orchestrator.handleUserInstruction('Mention the weekend special');

    // Step 3: Caller speaks again — the flow should continue normally
    mockSendMessage.mockImplementation(createMockProviderResponse(
      ['Great choice! The weekend special is 20% off.'],
    ));

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
    mockSendMessage.mockImplementation(createMockProviderResponse(['Understood, adjusting approach.']));

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
    // First, trigger ASK_GUARDIAN so orchestrator enters waiting_on_user
    mockSendMessage.mockImplementation(createMockProviderResponse(
      ['Hold on. [ASK_GUARDIAN: What time?]'],
    ));

    const { session, orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('I need an appointment');
    expect(orchestrator.getState()).toBe('waiting_on_user');

    // Track how many times the provider mock is called
    let streamCallCount = 0;
    mockSendMessage.mockImplementation(async () => {
      streamCallCount++;
      return {
        content: [{ type: 'text', text: 'Response after instruction.' }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
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
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(systemPrompt as string).toContain('on behalf of my human');
      const tokens = ['Hello.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('system prompt contains resolved user reference when set to a name', async () => {
    mockUserReference = 'John';
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(systemPrompt as string).toContain('on behalf of John');
      const tokens = ['Hello John\'s contact.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('system prompt does not hardcode "your user" in the opening line', async () => {
    mockUserReference = 'Alice';
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(systemPrompt as string).not.toContain('on behalf of your user');
      expect(systemPrompt as string).toContain('on behalf of Alice');
      const tokens = ['Hi there.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });

  test('system prompt includes assistant identity bias rule', async () => {
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(systemPrompt as string).toContain('refer to yourself as an assistant');
      expect(systemPrompt as string).toContain('Avoid the phrase "AI assistant" unless directly asked');
      const tokens = ['Sure thing.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('system prompt includes opening-ack guidance to avoid duplicate introductions', async () => {
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(systemPrompt as string).toContain('[CALL_OPENING_ACK]');
      expect(systemPrompt as string).toContain('without re-introducing yourself');
      const tokens = ['Understood.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('assistant identity rule appears before disclosure rule in prompt', async () => {
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      const prompt = systemPrompt as string;
      const identityIdx = prompt.indexOf('refer to yourself as an assistant');
      const disclosureIdx = prompt.indexOf('Be concise');
      expect(identityIdx).toBeGreaterThan(-1);
      expect(disclosureIdx).toBeGreaterThan(-1);
      expect(identityIdx).toBeLessThan(disclosureIdx);
      const tokens = ['OK.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
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
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(systemPrompt as string).toContain('introduce yourself as an assistant calling on behalf of the person you represent');
      expect(systemPrompt as string).toContain('Do not say "AI assistant"');
      const tokens = ['Hello, I am calling on behalf of my human.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Who is this?');
    orchestrator.destroy();
  });

  test('system prompt falls back to "Begin the conversation naturally" when disclosure is disabled', async () => {
    mockDisclosure = { enabled: false, text: '' };
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(systemPrompt as string).toContain('Begin the conversation naturally');
      expect(systemPrompt as string).not.toContain('introduce yourself as an assistant calling on behalf of the person');
      const tokens = ['Hello there.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hi');
    orchestrator.destroy();
  });

  test('system prompt does not use "AI assistant" as a self-identity label', async () => {
    mockSendMessage.mockImplementation(async (_messages: unknown[], _tools: unknown[], systemPrompt: unknown, options?: { onEvent?: (event: { type: string; text?: string }) => void }) => {
      expect(systemPrompt as string).not.toMatch(/(?:you are|call yourself|introduce yourself as).*AI assistant/i);
      const tokens = ['Got it.'];
      for (const token of tokens) {
        options?.onEvent?.({ type: 'text_delta', text: token });
      }
      return {
        content: [{ type: 'text', text: tokens.join('') }],
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });

    const { orchestrator } = setupOrchestrator();
    await orchestrator.handleCallerUtterance('Hello');
    orchestrator.destroy();
  });
});

import { describe, expect, mock, test, beforeEach } from 'bun:test';
import type { Message, ProviderResponse } from '../providers/types.js';
import type { AgentEvent, CheckpointInfo, CheckpointDecision } from '../agent/loop.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

// ---------------------------------------------------------------------------
// Mocks — must precede the Session import so Bun applies them at load time.
// ---------------------------------------------------------------------------

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module('../util/platform.js', () => ({
  getSocketPath: () => '/tmp/test.sock',
  getDataDir: () => '/tmp',
}));

mock.module('../providers/registry.js', () => ({
  getProvider: () => ({ name: 'mock-provider' }),
  initializeProviders: () => {},
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    provider: 'mock-provider',
    maxTokens: 4096,
    thinking: false,
    systemPrompt: {},
    contextWindow: {
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      preserveRecentMessages: 6,
      summaryModel: 'mock-model',
      maxSummaryTokens: 512,
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    apiKeys: {},
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module('../config/system-prompt.js', () => ({
  buildSystemPrompt: () => 'system prompt',
}));

mock.module('../permissions/trust-store.js', () => ({
  clearCache: () => {},
}));

mock.module('../security/secret-allowlist.js', () => ({
  resetAllowlist: () => {},
}));

mock.module('../memory/conversation-store.js', () => ({
  getMessages: () => [],
  getConversation: () => ({
    id: 'conv-1',
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  createConversation: () => ({ id: 'conv-1' }),
  listConversations: () => [],
  addMessage: (_convId: string, _role: string, _content: string) => {
    return { id: `msg-${Date.now()}` };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
}));

mock.module('../memory/retriever.js', () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: '',
    lexicalHits: 0,
    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
}));

mock.module('../context/window-manager.js', () => ({
  ContextWindowManager: class {
    constructor() {}
    async maybeCompact() { return { compacted: false }; }
  },
  createContextSummaryMessage: () => ({ role: 'user', content: [{ type: 'text', text: 'summary' }] }),
  getSummaryFromContextMessage: () => null,
}));

// ---------------------------------------------------------------------------
// Controllable AgentLoop mock.
//
// Each `run()` call returns a promise that does NOT resolve until the test
// explicitly calls the stored `resolve` callback. This lets us simulate a
// long-running agent loop so we can enqueue messages while the first one is
// still "processing".
// ---------------------------------------------------------------------------

interface PendingRun {
  resolve: (history: Message[]) => void;
  reject: (err: Error) => void;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
  onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision;
}

let pendingRuns: PendingRun[] = [];

mock.module('../agent/loop.js', () => ({
  AgentLoop: class {
    constructor() {}
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
    ): Promise<Message[]> {
      return new Promise<Message[]>((resolve, reject) => {
        pendingRuns.push({ resolve, reject, messages, onEvent, onCheckpoint });
      });
    }
  },
}));

// ---------------------------------------------------------------------------
// Import Session AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { Session, MAX_QUEUE_DEPTH } from '../daemon/session.js';
import type { QueueDrainReason, QueuePolicy } from '../daemon/session.js';

function makeSession(): Session {
  const provider = {
    name: 'mock',
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [],
        model: 'mock',
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end_turn',
      };
    },
  };
  return new Session('conv-1', provider, 'system prompt', 4096, () => {}, '/tmp');
}

/**
 * Wait until the pending runs array has at least `count` entries.
 * This is needed because `processMessage` is async and goes through
 * several awaited steps (context compaction, memory recall) before
 * reaching `agentLoop.run()`.
 */
async function waitForPendingRun(count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (pendingRuns.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} pending runs (have ${pendingRuns.length})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Resolve the Nth pending AgentLoop.run() call. Fires the minimal events
 * that `runAgentLoop` expects (usage + message_complete) so the session
 * cleanly transitions out of its processing state.
 */
function resolveRun(index: number) {
  const run = pendingRuns[index];
  if (!run) throw new Error(`No pending run at index ${index}`);
  // Emit the events runAgentLoop expects
  const assistantMsg: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: `reply-${index}` }],
  };
  run.onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5, model: 'mock' });
  run.onEvent({ type: 'message_complete', message: assistantMsg });
  // Return updated history with the assistant message appended
  run.resolve([...run.messages, assistantMsg]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session message queue', () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test('second message is queued when session is busy (does not throw)', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];

    // Start first message — this will block on AgentLoop.run
    const p1 = session.processMessage('msg-1', [], (e) => events1.push(e), 'req-1');

    // Wait for the first AgentLoop.run to be registered
    await waitForPendingRun(1);

    // Session should now be processing
    expect(session.isProcessing()).toBe(true);

    // Enqueue second message — should NOT throw
    const result = session.enqueueMessage('msg-2', [], (e) => events2.push(e), 'req-2');
    expect(result.queued).toBe(true);
    expect(result.requestId).toBe('req-2');
    expect(session.getQueueDepth()).toBe(1);

    // Complete the first message
    resolveRun(0);
    await p1;

    // After the first run resolves, the queue drains and triggers a second run.
    await waitForPendingRun(2);

    // The dequeued event should have been sent to events2
    expect(events2.some((e) => e.type === 'message_dequeued')).toBe(true);

    // A second AgentLoop.run should now be pending
    expect(pendingRuns.length).toBe(2);

    // Complete the second run
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('queued messages are processed in FIFO order', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const processedOrder: string[] = [];

    const makeHandler = (label: string) => (e: ServerMessage) => {
      if (e.type === 'message_complete') processedOrder.push(label);
    };

    // Start first message
    const p1 = session.processMessage('msg-1', [], makeHandler('msg-1'), 'req-1');
    await waitForPendingRun(1);

    // Enqueue two more
    session.enqueueMessage('msg-2', [], makeHandler('msg-2'), 'req-2');
    session.enqueueMessage('msg-3', [], makeHandler('msg-3'), 'req-3');
    expect(session.getQueueDepth()).toBe(2);

    // Complete first → triggers second
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Complete second → triggers third
    resolveRun(1);
    await waitForPendingRun(3);

    // Complete third
    resolveRun(2);
    await new Promise((r) => setTimeout(r, 50));

    expect(processedOrder).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  test('message_queued and message_dequeued events are emitted', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events2: ServerMessage[] = [];

    // Start first message
    const p1 = session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    // Enqueue second — simulating what handleUserMessage does
    const result = session.enqueueMessage('msg-2', [], (e) => events2.push(e), 'req-2');
    expect(result.queued).toBe(true);

    // Complete first
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Check for message_dequeued with correct fields
    const dequeued = events2.find((e) => e.type === 'message_dequeued');
    expect(dequeued).toBeDefined();
    expect(dequeued).toEqual({
      type: 'message_dequeued',
      sessionId: 'conv-1',
      requestId: 'req-2',
    });

    // Complete second run so the session finishes cleanly
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('abort() clears the queue and sends errors for each queued message', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message
    session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    // Enqueue two more
    session.enqueueMessage('msg-2', [], (e) => events2.push(e), 'req-2');
    session.enqueueMessage('msg-3', [], (e) => events3.push(e), 'req-3');
    expect(session.getQueueDepth()).toBe(2);

    // Abort
    session.abort();

    // Queue should be empty
    expect(session.getQueueDepth()).toBe(0);

    // Both queued messages should have received error events
    const err2 = events2.find((e) => e.type === 'error');
    expect(err2).toBeDefined();
    expect(err2!.type === 'error' && err2!.message).toContain('queued message discarded');

    const err3 = events3.find((e) => e.type === 'error');
    expect(err3).toBeDefined();
    expect(err3!.type === 'error' && err3!.message).toContain('queued message discarded');
  });

  test('queue depth is reported correctly as messages are added and drained', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start first message
    const p1 = session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    expect(session.getQueueDepth()).toBe(0);

    session.enqueueMessage('msg-2', [], () => {}, 'req-2');
    expect(session.getQueueDepth()).toBe(1);

    session.enqueueMessage('msg-3', [], () => {}, 'req-3');
    expect(session.getQueueDepth()).toBe(2);

    session.enqueueMessage('msg-4', [], () => {}, 'req-4');
    expect(session.getQueueDepth()).toBe(3);

    // Complete first → drains one from queue
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(session.getQueueDepth()).toBe(2);

    // Complete second → drains another
    resolveRun(1);
    await waitForPendingRun(3);

    expect(session.getQueueDepth()).toBe(1);

    // Complete third → drains last
    resolveRun(2);
    await waitForPendingRun(4);

    expect(session.getQueueDepth()).toBe(0);

    // Complete fourth (final queued message)
    resolveRun(3);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('drain continues after a queued message fails to persist', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message — blocks on AgentLoop.run
    const p1 = session.processMessage('msg-1', [], (e) => events1.push(e), 'req-1');
    await waitForPendingRun(1);

    // Enqueue a message with empty content (will fail persistUserMessage)
    session.enqueueMessage('', [], (e) => events2.push(e), 'req-2');
    // Enqueue a valid message after the bad one
    session.enqueueMessage('msg-3', [], (e) => events3.push(e), 'req-3');
    expect(session.getQueueDepth()).toBe(2);

    // Complete first message — triggers drain. The empty message should fail
    // to persist, but the drain should continue to msg-3.
    resolveRun(0);
    await p1;

    // msg-3 should have been dequeued and started a new AgentLoop.run
    await waitForPendingRun(2);

    // The empty message should have received an error event
    const err2 = events2.find((e) => e.type === 'error');
    expect(err2).toBeDefined();
    if (err2 && err2.type === 'error') {
      expect(err2.message).toContain('required');
    }

    // msg-3 should have received a dequeued event
    expect(events3.some((e) => e.type === 'message_dequeued')).toBe(true);

    // Complete the third message's run
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));

    // msg-3 should have completed successfully
    expect(events3.some((e) => e.type === 'message_complete')).toBe(true);
  });

  test('queue rejects when at max depth', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start first message to make session busy
    session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    // Fill the queue to MAX_QUEUE_DEPTH
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      const result = session.enqueueMessage(`msg-${i + 2}`, [], () => {}, `req-${i + 2}`);
      expect(result.queued).toBe(true);
      expect(result.rejected).toBeUndefined();
    }
    expect(session.getQueueDepth()).toBe(MAX_QUEUE_DEPTH);

    // Next enqueue should be rejected
    const rejected = session.enqueueMessage('overflow', [], () => {}, 'req-overflow');
    expect(rejected.queued).toBe(false);
    expect(rejected.rejected).toBe(true);

    // Queue depth should not have increased
    expect(session.getQueueDepth()).toBe(MAX_QUEUE_DEPTH);
  });
});

// ---------------------------------------------------------------------------
// Queue policy primitives
// ---------------------------------------------------------------------------

describe('Session queue policy helpers', () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test('hasQueuedMessages() returns false on a fresh session', async () => {
    const session = makeSession();
    await session.loadFromDb();
    expect(session.hasQueuedMessages()).toBe(false);
  });

  test('hasQueuedMessages() returns true after enqueuing while processing', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing to make the session busy
    session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    // Enqueue a message while processing
    session.enqueueMessage('msg-2', [], () => {}, 'req-2');
    expect(session.hasQueuedMessages()).toBe(true);

    // Cleanup: resolve the pending run
    resolveRun(0);
    await waitForPendingRun(2);
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('canHandoffAtCheckpoint() returns false when not processing', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Not processing, no queued messages
    expect(session.canHandoffAtCheckpoint()).toBe(false);
  });

  test('canHandoffAtCheckpoint() returns false when processing but no queued messages', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing — but don't enqueue anything
    session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    expect(session.isProcessing()).toBe(true);
    expect(session.hasQueuedMessages()).toBe(false);
    expect(session.canHandoffAtCheckpoint()).toBe(false);

    // Cleanup
    resolveRun(0);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('canHandoffAtCheckpoint() returns true when processing and queue has messages', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing
    session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    // Enqueue a message
    session.enqueueMessage('msg-2', [], () => {}, 'req-2');

    expect(session.isProcessing()).toBe(true);
    expect(session.hasQueuedMessages()).toBe(true);
    expect(session.canHandoffAtCheckpoint()).toBe(true);

    // Cleanup
    resolveRun(0);
    await waitForPendingRun(2);
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('QueueDrainReason type accepts expected values', () => {
    // Compile-time verification that these are valid QueueDrainReason values
    const reason1: QueueDrainReason = 'loop_complete';
    const reason2: QueueDrainReason = 'checkpoint_handoff';
    expect(reason1).toBe('loop_complete');
    expect(reason2).toBe('checkpoint_handoff');
  });

  test('QueuePolicy type accepts expected shape', () => {
    // Compile-time verification that the QueuePolicy interface works
    const policy: QueuePolicy = { checkpointHandoffEnabled: true };
    expect(policy.checkpointHandoffEnabled).toBe(true);

    const disabledPolicy: QueuePolicy = { checkpointHandoffEnabled: false };
    expect(disabledPolicy.checkpointHandoffEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint handoff tests
// ---------------------------------------------------------------------------

describe('Session checkpoint handoff', () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test('onCheckpoint yields when there is a queued message', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];

    // Start processing first message
    const p1 = session.processMessage('msg-1', [], (e) => events1.push(e), 'req-1');
    await waitForPendingRun(1);

    // Enqueue a second message while the first is processing
    session.enqueueMessage('msg-2', [], () => {}, 'req-2');
    expect(session.hasQueuedMessages()).toBe(true);

    // The pending run should have received an onCheckpoint callback.
    // Simulate the agent loop calling it at a turn boundary.
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    const decision = run.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
    });

    // Because there is a queued message, the callback should return 'yield'
    expect(decision).toBe('yield');

    // Complete the run so the session finishes cleanly
    resolveRun(0);
    await p1;

    // After yield, the first message should emit generation_handoff
    const handoff = events1.find((e) => e.type === 'generation_handoff');
    expect(handoff).toBeDefined();
    expect(handoff).toMatchObject({
      type: 'generation_handoff',
      sessionId: 'conv-1',
      requestId: 'req-1',
      queuedCount: 1,
    });

    // The queued message should now be draining (second run started)
    await waitForPendingRun(2);
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('onCheckpoint returns continue when queue is empty', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing — no enqueued messages
    const p1 = session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    expect(session.hasQueuedMessages()).toBe(false);

    // The pending run should have an onCheckpoint callback
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    const decision = run.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
    });

    // No queued messages → continue
    expect(decision).toBe('continue');

    // Cleanup
    resolveRun(0);
    await p1;
  });

  test('FIFO ordering is preserved through checkpoint handoff', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const processedOrder: string[] = [];

    const makeHandler = (label: string) => (e: ServerMessage) => {
      if (e.type === 'message_complete' || e.type === 'generation_handoff') processedOrder.push(label);
    };

    // Start first message
    const p1 = session.processMessage('msg-1', [], makeHandler('msg-1'), 'req-1');
    await waitForPendingRun(1);

    // Enqueue two messages
    session.enqueueMessage('msg-2', [], makeHandler('msg-2'), 'req-2');
    session.enqueueMessage('msg-3', [], makeHandler('msg-3'), 'req-3');
    expect(session.getQueueDepth()).toBe(2);

    // Simulate the agent loop yielding at the checkpoint (first run)
    const run0 = pendingRuns[0];
    expect(run0.onCheckpoint).toBeDefined();
    const decision = run0.onCheckpoint!({ turnIndex: 0, toolCount: 1, hasToolUse: true });
    expect(decision).toBe('yield');

    // Complete first run
    resolveRun(0);
    await p1;

    // msg-2 should be draining next
    await waitForPendingRun(2);

    // Complete second run (msg-2)
    resolveRun(1);
    await waitForPendingRun(3);

    // Complete third run (msg-3)
    resolveRun(2);
    await new Promise((r) => setTimeout(r, 50));

    // FIFO order: msg-1 completes first, then msg-2, then msg-3
    expect(processedOrder).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  test('queue-full rejection still works during checkpoint handoff', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing
    session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    // Fill the queue to MAX_QUEUE_DEPTH
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      const result = session.enqueueMessage(`queued-${i}`, [], () => {}, `req-q-${i}`);
      expect(result.queued).toBe(true);
    }
    expect(session.getQueueDepth()).toBe(MAX_QUEUE_DEPTH);

    // Verify checkpoint would yield (there are queued messages)
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    expect(run.onCheckpoint!({ turnIndex: 0, toolCount: 1, hasToolUse: true })).toBe('yield');

    // Next enqueue should still be rejected
    const rejected = session.enqueueMessage('overflow', [], () => {}, 'req-overflow');
    expect(rejected.queued).toBe(false);
    expect(rejected.rejected).toBe(true);

    // Queue depth unchanged
    expect(session.getQueueDepth()).toBe(MAX_QUEUE_DEPTH);
  });

  test('active run with repeated tool turns + queued message triggers checkpoint handoff', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];

    // Start processing first message
    const p1 = session.processMessage('msg-1', [], (e) => events1.push(e), 'req-1');
    await waitForPendingRun(1);

    // Enqueue a second message while the first is processing
    session.enqueueMessage('msg-2', [], (e) => events2.push(e), 'req-2');
    expect(session.hasQueuedMessages()).toBe(true);

    // Simulate tool-use turns: the agent loop calls onCheckpoint at each turn boundary.
    // Because there is a queued message, the callback should return 'yield'.
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();

    // Simulate multiple tool-use turns before the checkpoint fires
    // Turn 0 — checkpoint yields because msg-2 is waiting
    const decision = run.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
    });
    expect(decision).toBe('yield');

    // Complete the run (AgentLoop resolves after yielding)
    resolveRun(0);
    await p1;

    // Verify generation_handoff was emitted (not plain message_complete)
    const handoff = events1.find((e) => e.type === 'generation_handoff');
    expect(handoff).toBeDefined();
    expect(handoff).toMatchObject({
      type: 'generation_handoff',
      sessionId: 'conv-1',
      requestId: 'req-1',
      queuedCount: 1,
    });
    // message_complete should NOT be in events1 (handoff replaces it)
    const messageComplete = events1.find((e) => e.type === 'message_complete' && 'sessionId' in e);
    expect(messageComplete).toBeUndefined();

    // The queued message should subsequently drain
    await waitForPendingRun(2);
    expect(events2.some((e) => e.type === 'message_dequeued')).toBe(true);

    // Complete the second run
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('queued messages still drain FIFO under multiple handoffs', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const dequeueOrder: string[] = [];

    const eventsA: ServerMessage[] = [];
    const makeHandler = (label: string) => (e: ServerMessage) => {
      if (e.type === 'message_dequeued') dequeueOrder.push(label);
    };

    // Start processing message A
    const pA = session.processMessage('msg-A', [], (e) => eventsA.push(e), 'req-A');
    await waitForPendingRun(1);

    // Enqueue messages B, C, D
    session.enqueueMessage('msg-B', [], makeHandler('B'), 'req-B');
    session.enqueueMessage('msg-C', [], makeHandler('C'), 'req-C');
    session.enqueueMessage('msg-D', [], makeHandler('D'), 'req-D');
    expect(session.getQueueDepth()).toBe(3);

    // Handoff from A -> B
    const runA = pendingRuns[0];
    expect(runA.onCheckpoint).toBeDefined();
    expect(runA.onCheckpoint!({ turnIndex: 0, toolCount: 1, hasToolUse: true })).toBe('yield');
    resolveRun(0);
    await pA;

    // B should be draining
    await waitForPendingRun(2);

    // Handoff from B -> C
    const runB = pendingRuns[1];
    expect(runB.onCheckpoint).toBeDefined();
    expect(runB.onCheckpoint!({ turnIndex: 0, toolCount: 1, hasToolUse: true })).toBe('yield');
    resolveRun(1);
    await waitForPendingRun(3);

    // Handoff from C -> D
    const runC = pendingRuns[2];
    expect(runC.onCheckpoint).toBeDefined();
    // Only D remains, still should yield
    expect(runC.onCheckpoint!({ turnIndex: 0, toolCount: 1, hasToolUse: true })).toBe('yield');
    resolveRun(2);
    await waitForPendingRun(4);

    // D has no more queued -> checkpoint should return 'continue'
    const runD = pendingRuns[3];
    expect(runD.onCheckpoint).toBeDefined();
    expect(runD.onCheckpoint!({ turnIndex: 0, toolCount: 1, hasToolUse: true })).toBe('continue');

    resolveRun(3);
    await new Promise((r) => setTimeout(r, 50));

    // Verify FIFO dequeue order
    expect(dequeueOrder).toEqual(['B', 'C', 'D']);
  });

  test('queued persistence failure does not strand later messages', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const eventsA: ServerMessage[] = [];
    const eventsB: ServerMessage[] = [];
    const eventsC: ServerMessage[] = [];

    // Start processing message A
    const pA = session.processMessage('msg-A', [], (e) => eventsA.push(e), 'req-A');
    await waitForPendingRun(1);

    // Enqueue B (empty content — will fail to persist) and C (valid)
    session.enqueueMessage('', [], (e) => eventsB.push(e), 'req-B');
    session.enqueueMessage('msg-C', [], (e) => eventsC.push(e), 'req-C');
    expect(session.getQueueDepth()).toBe(2);

    // Complete message A — triggers drain. B should fail, C should proceed.
    resolveRun(0);
    await pA;

    // C should have been dequeued and started a new AgentLoop.run
    await waitForPendingRun(2);

    // B should have received an error event
    const errB = eventsB.find((e) => e.type === 'error');
    expect(errB).toBeDefined();
    if (errB && errB.type === 'error') {
      expect(errB.message).toContain('required');
    }

    // C should have received a dequeued event
    expect(eventsC.some((e) => e.type === 'message_dequeued')).toBe(true);

    // Complete C's run
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));

    // C should have completed successfully
    expect(eventsC.some((e) => e.type === 'message_complete')).toBe(true);
  });

  test('onCheckpoint callback is passed to both initial and retry runs', async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing
    const p1 = session.processMessage('msg-1', [], () => {}, 'req-1');
    await waitForPendingRun(1);

    // The first run should have onCheckpoint
    expect(pendingRuns[0].onCheckpoint).toBeDefined();

    // Simulate an ordering error: emit error + resolve with same length
    // to trigger the retry path
    const run0 = pendingRuns[0];
    run0.onEvent({
      type: 'error',
      error: new Error('tool_result block not immediately after tool_use block'),
    });
    // Resolve with the same messages (no new messages appended = ordering error)
    run0.resolve([...run0.messages]);

    // Wait for the retry run
    await waitForPendingRun(2);

    // The retry run should also have onCheckpoint
    expect(pendingRuns[1].onCheckpoint).toBeDefined();

    // Complete retry cleanly
    resolveRun(1);
    await p1;
  });
});

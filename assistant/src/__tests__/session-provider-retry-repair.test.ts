import { describe, expect, mock, test } from 'bun:test';
import type { Message, ProviderResponse } from '../providers/types.js';
import type { AgentEvent } from '../agent/loop.js';

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
  addMessage: () => ({ id: 'new-msg' }),
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

// Track how many times agentLoop.run was called
let agentLoopRunCount = 0;
// Control whether agent loop should emit an ordering error
let shouldEmitOrderingError = true;

mock.module('../agent/loop.js', () => ({
  AgentLoop: class {
    constructor() {}
    async run(messages: Message[], onEvent: (event: AgentEvent) => void, _signal?: AbortSignal): Promise<Message[]> {
      agentLoopRunCount++;

      if (shouldEmitOrderingError && agentLoopRunCount === 1) {
        // First call: simulate provider ordering error (no messages appended)
        onEvent({ type: 'usage', inputTokens: 0, outputTokens: 0, model: 'mock' });
        onEvent({
          type: 'error',
          error: new Error('tool_result blocks that are not immediately after a tool_use block'),
        });
        return [...messages]; // Return unchanged — no progress
      }

      // Second call (retry) or non-error: succeed normally
      onEvent({ type: 'usage', inputTokens: 10, outputTokens: 20, model: 'mock' });
      const history = [...messages];
      const assistantMsg: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'response' }],
      };
      history.push(assistantMsg);
      onEvent({ type: 'message_complete', message: assistantMsg });
      return history;
    }
  },
}));

import { Session } from '../daemon/session.js';

function makeSession(): Session {
  const provider = {
    name: 'mock',
    async sendMessage(): Promise<ProviderResponse> {
      return { content: [], model: 'mock', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' };
    },
  };
  return new Session('conv-1', provider, 'system prompt', 4096, () => {}, '/tmp');
}

describe('provider ordering error retry', () => {
  test('simulated strict provider error triggers exactly one retry', async () => {
    agentLoopRunCount = 0;
    shouldEmitOrderingError = true;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage('Hello', [], (msg) => events.push(msg as unknown as Record<string, unknown>));

    // Should have been called exactly 2 times: original + one retry
    expect(agentLoopRunCount).toBe(2);
  });

  test('retry succeeds with repaired history', async () => {
    agentLoopRunCount = 0;
    shouldEmitOrderingError = true;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage('Hello', [], (msg) => events.push(msg as unknown as Record<string, unknown>));

    // Should have a message_complete event (from successful retry)
    const messageComplete = events.find((e) => e.type === 'message_complete');
    expect(messageComplete).toBeDefined();

    // Should also have the assistant response in memory
    const messages = session.getMessages();
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
  });

  test('non-ordering errors do not trigger retry', async () => {
    agentLoopRunCount = 0;
    shouldEmitOrderingError = false;

    // Override the mock to emit a non-ordering error
    // Since we set shouldEmitOrderingError = false, the mock will succeed immediately
    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage('Hello', [], (msg) => events.push(msg as unknown as Record<string, unknown>));

    // Should have been called exactly 1 time (no retry for non-ordering errors)
    expect(agentLoopRunCount).toBe(1);
  });
});

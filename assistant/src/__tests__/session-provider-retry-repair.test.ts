import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, ProviderResponse } from '../providers/types.js';
import type { AgentEvent } from '../agent/loop.js';
import type { UserMessageAttachment } from '../daemon/ipc-protocol.js';

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module('../util/platform.js', () => ({
  getSocketPath: () => '/tmp/test.sock',
  getDataDir: () => '/tmp',
}));

mock.module('../memory/guardian-action-store.js', () => ({
  getPendingDeliveryByConversation: () => null,
  getGuardianActionRequest: () => null,
  resolveGuardianActionRequest: () => {},
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
    contextWindow: {
      enabled: true,
      maxInputTokens: 100000,
      targetInputTokens: 70000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 6,
      summaryMaxTokens: 512,
      chunkTokens: 12000,
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

mock.module('../memory/admin.js', () => ({
  getMemoryConflictAndCleanupStats: () => ({
    conflicts: { pending: 0, resolved: 0, oldestPendingAgeMs: null },
    cleanup: { resolvedBacklog: 0, supersededBacklog: 0, resolvedCompleted24h: 0, supersededCompleted24h: 0 },
  }),
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
  updateConversationContextWindow: () => {},
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

let maybeCompactCalls: Array<{ force: boolean }> = [];
let forceCompactionEnabled = false;

mock.module('../context/window-manager.js', () => ({
  ContextWindowManager: class {
    constructor() {}
    async maybeCompact(messages: Message[], _signal?: AbortSignal, options?: { force?: boolean }) {
      maybeCompactCalls.push({ force: options?.force === true });
      if (options?.force && forceCompactionEnabled) {
        return {
          compacted: true,
          messages,
          previousEstimatedInputTokens: 120000,
          estimatedInputTokens: 50000,
          maxInputTokens: 100000,
          thresholdTokens: 80000,
          compactedMessages: 2,
          compactedPersistedMessages: 2,
          summaryCalls: 1,
          summaryInputTokens: 200,
          summaryOutputTokens: 50,
          summaryModel: 'mock-summary-model',
          summaryText: '## Goals\n- compacted',
        };
      }
      return { compacted: false };
    }
  },
  createContextSummaryMessage: () => ({ role: 'user', content: [{ type: 'text', text: 'summary' }] }),
  getSummaryFromContextMessage: () => null,
}));

// Track how many times agentLoop.run was called
let agentLoopRunCount = 0;
let firstRunErrorMode: 'none' | 'ordering' | 'context_too_large' = 'ordering';

mock.module('../agent/loop.js', () => ({
  AgentLoop: class {
    constructor() {}
    async run(messages: Message[], onEvent: (event: AgentEvent) => void, _signal?: AbortSignal): Promise<Message[]> {
      agentLoopRunCount++;

      if (agentLoopRunCount === 1 && firstRunErrorMode !== 'none') {
        onEvent({ type: 'usage', inputTokens: 0, outputTokens: 0, model: 'mock', providerDurationMs: 0 });
        const error =
          firstRunErrorMode === 'ordering'
            ? new Error('tool_result blocks that are not immediately after a tool_use block')
            : new Error('context_length_exceeded: request has too many input tokens');
        onEvent({ type: 'error', error });
        return [...messages]; // Return unchanged — no progress
      }

      // Second call (retry) or non-error: succeed normally
      onEvent({ type: 'usage', inputTokens: 10, outputTokens: 20, model: 'mock', providerDurationMs: 50 });
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

function makeImageAttachments(count: number, bytesPerImage = 20_000): UserMessageAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    filename: `shot-${i + 1}.png`,
    mimeType: 'image/png',
    data: `${i}${'A'.repeat(bytesPerImage)}`,
  }));
}

describe('provider ordering error retry', () => {
  beforeEach(() => {
    agentLoopRunCount = 0;
    firstRunErrorMode = 'ordering';
    maybeCompactCalls = [];
    forceCompactionEnabled = false;
  });

  test('simulated strict provider error triggers exactly one retry', async () => {
    firstRunErrorMode = 'ordering';

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage('Hello', [], (msg) => events.push(msg as unknown as Record<string, unknown>));

    // Should have been called exactly 2 times: original + one retry
    expect(agentLoopRunCount).toBe(2);
  });

  test('[experimental] retry succeeds with repaired history and no spurious error event', async () => {
    firstRunErrorMode = 'ordering';

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage('Hello', [], (msg) => events.push(msg as unknown as Record<string, unknown>));

    // Should have a message_complete event (from successful retry)
    const messageComplete = events.find((e) => e.type === 'message_complete');
    expect(messageComplete).toBeDefined();

    // Ordering error should be suppressed when retry succeeds — no error events
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(0);

    // Should also have the assistant response in memory
    const messages = session.getMessages();
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
  });

  test('non-ordering errors do not trigger retry', async () => {
    firstRunErrorMode = 'none';

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage('Hello', [], (msg) => events.push(msg as unknown as Record<string, unknown>));

    // Should have been called exactly 1 time (no retry for non-ordering errors)
    expect(agentLoopRunCount).toBe(1);
  });

  test('context-too-large triggers one forced-compaction retry for image-heavy input', async () => {
    firstRunErrorMode = 'context_too_large';
    forceCompactionEnabled = true;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage(
      'Please compare these images.',
      makeImageAttachments(8),
      (msg) => events.push(msg as unknown as Record<string, unknown>),
    );

    expect(agentLoopRunCount).toBe(2);
    expect(maybeCompactCalls).toEqual([
      { force: false },
      { force: true },
    ]);
    expect(events.some((e) => e.type === 'message_complete')).toBe(true);
    expect(events.some((e) => e.type === 'session_error')).toBe(false);
  });

  test('context-too-large can recover by trimming older media when forced compaction cannot run', async () => {
    firstRunErrorMode = 'context_too_large';
    forceCompactionEnabled = false;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage(
      'Please compare these images.',
      makeImageAttachments(8),
      (msg) => events.push(msg as unknown as Record<string, unknown>),
    );

    expect(agentLoopRunCount).toBe(2);
    expect(maybeCompactCalls).toEqual([
      { force: false },
      { force: true },
    ]);

    expect(events.some((e) => e.type === 'message_complete')).toBe(true);
    expect(events.some((e) => e.type === 'session_error')).toBe(false);
  });

  test('context-too-large still surfaces when no media payloads are available to trim', async () => {
    firstRunErrorMode = 'context_too_large';
    forceCompactionEnabled = false;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage(
      'No attachments here.',
      [],
      (msg) => events.push(msg as unknown as Record<string, unknown>),
    );

    expect(agentLoopRunCount).toBe(1);
    expect(maybeCompactCalls).toEqual([
      { force: false },
      { force: true },
    ]);
    const sessionError = events.find((e) => e.type === 'session_error') as { code?: string } | undefined;
    expect(sessionError?.code).toBe('CONTEXT_TOO_LARGE');
  });
});

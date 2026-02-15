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
    contextWindow: {
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      preserveRecentMessages: 6,
      summaryModel: 'mock-model',
      maxSummaryTokens: 512,
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    apiKeys: {},
    memory: { retrieval: { injectionStrategy: 'inline' } },
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

const addMessageCalls: Array<{ convId: string; role: string; content: string }> = [];

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
  addMessage: (convId: string, role: string, content: string) => {
    addMessageCalls.push({ convId, role, content });
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

// Mock skill catalog — only "start-the-day" is available
mock.module('../config/skills.js', () => ({
  loadSkillCatalog: () => [
    {
      id: 'start-the-day',
      name: 'Start the Day',
      description: 'Morning routine skill',
      directoryPath: '/skills/start-the-day',
      skillFilePath: '/skills/start-the-day/SKILL.md',
      userInvocable: true,
      disableModelInvocation: false,
      source: 'managed',
    },
  ],
  loadSkillBySelector: () => null,
  ensureSkillIcon: () => {},
}));

mock.module('../config/skill-state.js', () => ({
  resolveSkillStates: (catalog: Record<string, unknown>[]) => catalog.map((s) => ({
    summary: s,
    state: 'enabled',
    degraded: false,
  })),
}));

// ---------------------------------------------------------------------------
// AgentLoop mock — tracks whether run() was called
// ---------------------------------------------------------------------------

let agentLoopRunCalled = false;

mock.module('../agent/loop.js', () => ({
  AgentLoop: class {
    constructor() {}
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
    ): Promise<Message[]> {
      agentLoopRunCalled = true;
      const assistantMsg: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'reply' }],
      };
      onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5, model: 'mock', providerDurationMs: 100 });
      onEvent({ type: 'message_complete', message: assistantMsg });
      return [...messages, assistantMsg];
    }
  },
}));

// ---------------------------------------------------------------------------
// Import Session AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { Session } from '../daemon/session.js';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session slash command — unknown', () => {
  beforeEach(() => {
    agentLoopRunCalled = false;
    addMessageCalls.length = 0;
  });

  test('unknown slash emits deterministic assistant response', async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    await session.processMessage('/not-a-skill', [], onEvent);

    // Should have emitted assistant_text_delta with the unknown message
    const textDeltas = events.filter((e) => e.type === 'assistant_text_delta');
    expect(textDeltas.length).toBe(1);
    const delta = textDeltas[0] as { text: string };
    expect(delta.text).toContain('Unknown command `/not-a-skill`');
    expect(delta.text).toContain('/start-the-day');

    // Should have emitted message_complete
    const completes = events.filter((e) => e.type === 'message_complete');
    expect(completes.length).toBe(1);
  });

  test('unknown slash returns a non-empty messageId', async () => {
    const session = makeSession();
    const messageId = await session.processMessage('/not-a-skill', [], () => {});
    expect(messageId).toBeTruthy();
    expect(typeof messageId).toBe('string');
    expect(messageId.length).toBeGreaterThan(0);
  });

  test('no agent loop execution occurs for unknown slash', async () => {
    const session = makeSession();
    await session.processMessage('/not-a-skill', [], () => {});
    expect(agentLoopRunCalled).toBe(false);
  });

  test('unknown slash persists both user and assistant messages', async () => {
    const session = makeSession();
    await session.processMessage('/not-a-skill', [], () => {});

    // Should persist exactly two messages: user + assistant
    const roles = addMessageCalls.map((c) => c.role);
    expect(roles).toEqual(['user', 'assistant']);

    // The assistant message content should contain the unknown-command text
    const assistantContent = addMessageCalls[1].content;
    expect(assistantContent).toContain('Unknown command');
  });

  test('normal messages still go through standard path', async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    await session.processMessage('hello world', [], (msg) => events.push(msg));
    expect(agentLoopRunCalled).toBe(true);
  });
});

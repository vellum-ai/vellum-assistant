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

// Mock skill catalog to provide a known slash skill
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
// Controllable AgentLoop mock that captures the content passed to run().
// ---------------------------------------------------------------------------

interface PendingRun {
  resolve: (history: Message[]) => void;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
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
      _onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
    ): Promise<Message[]> {
      return new Promise<Message[]>((resolve) => {
        pendingRuns.push({ resolve, messages, onEvent });
      });
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

async function waitForPendingRun(count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (pendingRuns.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} pending runs (have ${pendingRuns.length})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function resolveRun(index: number) {
  const run = pendingRuns[index];
  if (!run) throw new Error(`No pending run at index ${index}`);
  const assistantMsg: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: `reply-${index}` }],
  };
  run.onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5, model: 'mock', providerDurationMs: 100 });
  run.onEvent({ type: 'message_complete', message: assistantMsg });
  run.resolve([...run.messages, assistantMsg]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session slash command — known', () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test('known slash command rewrites content before agent run', async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    // Send a known slash command
    const promise = session.processMessage('/start-the-day', [], onEvent);
    await waitForPendingRun(1);

    // The message passed to agent loop should be rewritten
    const lastUserMsg = pendingRuns[0].messages[pendingRuns[0].messages.length - 1];
    expect(lastUserMsg.role).toBe('user');
    const text = lastUserMsg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(text).toContain('slash command');
    expect(text).toContain('start-the-day');
    expect(text).toContain('Start the Day');
    // Should NOT contain the raw `/start-the-day` as the entire content
    expect(text).not.toBe('/start-the-day');

    resolveRun(0);
    await promise;
  });

  test('non-slash content is unchanged', async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    const promise = session.processMessage('hello world', [], onEvent);
    await waitForPendingRun(1);

    const lastUserMsg = pendingRuns[0].messages[pendingRuns[0].messages.length - 1];
    expect(lastUserMsg.role).toBe('user');
    const text = lastUserMsg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(text).toContain('hello world');

    resolveRun(0);
    await promise;
  });
});

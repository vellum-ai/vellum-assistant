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

// Mock skill catalog — "start-the-day" is available
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
  resolveSkillStates: (catalog: any[]) => catalog.map((s: any) => ({
    summary: s,
    state: 'enabled',
    degraded: false,
  })),
}));

// ---------------------------------------------------------------------------
// Controllable AgentLoop mock.
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
  run.onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5, model: 'mock' });
  run.onEvent({ type: 'message_complete', message: assistantMsg });
  run.resolve([...run.messages, assistantMsg]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session queue slash handling', () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test('queued unknown slash does not stall queue', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsUnknown: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message — blocks on agent loop
    const p1 = session.processMessage('msg-1', [], (e) => events1.push(e), 'req-1');
    await waitForPendingRun(1);

    // Enqueue unknown slash and a normal message after it
    session.enqueueMessage('/not-a-skill', [], (e) => eventsUnknown.push(e), 'req-unknown');
    session.enqueueMessage('msg-3', [], (e) => events3.push(e), 'req-3');
    expect(session.getQueueDepth()).toBe(2);

    // Complete first run — triggers drain
    resolveRun(0);
    await p1;

    // The unknown slash should have been handled immediately (no agent loop)
    // and msg-3 should have been drained next
    await waitForPendingRun(2);

    // Unknown slash events: dequeued, text delta, message complete
    expect(eventsUnknown.some((e) => e.type === 'message_dequeued')).toBe(true);
    const textDeltas = eventsUnknown.filter((e) => e.type === 'assistant_text_delta');
    expect(textDeltas.length).toBe(1);
    expect((textDeltas[0] as any).text).toContain('Unknown command');
    expect(eventsUnknown.some((e) => e.type === 'message_complete')).toBe(true);

    // msg-3 events: dequeued (agent loop started)
    expect(events3.some((e) => e.type === 'message_dequeued')).toBe(true);

    // Only 2 agent loop runs total (msg-1 and msg-3, not the unknown slash)
    expect(pendingRuns.length).toBe(2);

    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test('queued known slash rewrites content', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsSlash: ServerMessage[] = [];

    // Start first message — blocks on agent loop
    const p1 = session.processMessage('msg-1', [], (e) => events1.push(e), 'req-1');
    await waitForPendingRun(1);

    // Enqueue a known slash command
    session.enqueueMessage('/start-the-day', [], (e) => eventsSlash.push(e), 'req-slash');

    // Complete first run — triggers drain with known slash
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // The second agent loop run should have rewritten content
    const lastUserMsg = pendingRuns[1].messages[pendingRuns[1].messages.length - 1];
    expect(lastUserMsg.role).toBe('user');
    const text = lastUserMsg.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    expect(text).toContain('start-the-day');
    expect(text).toContain('Start the Day');

    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });
});

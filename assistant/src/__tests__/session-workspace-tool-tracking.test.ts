import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, ProviderResponse, ContentBlock } from '../providers/types.js';
import type { AgentEvent } from '../agent/loop.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

// ---------------------------------------------------------------------------
// Track what the agent loop sees
// ---------------------------------------------------------------------------

let runCalls: Message[][] = [];
let agentEventHandlers: Array<(event: AgentEvent) => void> = [];

// ---------------------------------------------------------------------------
// Mocks — follows session-profile-injection.test.ts pattern
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
      enabled: true,
      maxInputTokens: 100000,
      targetInputTokens: 80000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 8,
      summaryMaxTokens: 512,
      chunkTokens: 12000,
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    apiKeys: {},
    memory: { enabled: false },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module('../config/system-prompt.js', () => ({
  buildSystemPrompt: () => 'system prompt',
}));

mock.module('../config/skills.js', () => ({
  loadSkillCatalog: () => [],
  loadSkillBySelector: () => ({ skill: null }),
  ensureSkillIcon: async () => null,
}));

mock.module('../config/skill-state.js', () => ({
  resolveSkillStates: () => [],
}));

mock.module('../skills/slash-commands.js', () => ({
  buildInvocableSlashCatalog: () => new Map(),
  resolveSlashSkillCommand: () => ({ kind: 'not_slash' }),
  rewriteKnownSlashCommandPrompt: () => '',
  parseSlashCandidate: () => ({ kind: 'not_slash' }),
}));

mock.module('../permissions/trust-store.js', () => ({
  addRule: () => {},
  findHighestPriorityRule: () => null,
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
    contextCompactedAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  addMessage: () => ({ id: 'msg-1' }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => ({ segmentIds: [], orphanedItemIds: [] }),
  deleteLastExchange: () => 0,
  isLastUserMessageToolResult: () => false,
}));

mock.module('../memory/attachments-store.js', () => ({
  uploadAttachment: () => ({ id: 'att-1' }),
  linkAttachmentToMessage: () => {},
}));

mock.module('../memory/retriever.js', () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    reason: null,
    provider: 'mock',
    model: 'mock',
    injectedText: '',
    lexicalHits: 0,
    semanticHits: 0,
    recencyHits: 0,
    entityHits: 0,
    relationSeedEntityCount: 0,
    relationTraversedEdgeCount: 0,
    relationNeighborEntityCount: 0,
    relationExpandedItemCount: 0,
    mergedCount: 0,
    selectedCount: 0,
    rerankApplied: false,
    injectedTokens: 0,
    latencyMs: 0,
    topCandidates: [],
  }),
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
  injectMemoryRecallAsSeparateMessage: (msgs: Message[]) => msgs,
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
}));

mock.module('../memory/query-builder.js', () => ({
  buildMemoryQuery: () => '',
}));

mock.module('../memory/retrieval-budget.js', () => ({
  computeRecallBudget: () => 0,
}));

mock.module('../context/window-manager.js', () => ({
  ContextWindowManager: class {
    constructor() {}
    async maybeCompact() { return { compacted: false }; }
  },
  createContextSummaryMessage: () => ({ role: 'user', content: [{ type: 'text', text: 'summary' }] }),
  getSummaryFromContextMessage: () => null,
}));

mock.module('../memory/conflict-store.js', () => ({
  listPendingConflictDetails: () => [],
  markConflictAsked: () => true,
  applyConflictResolution: () => true,
}));

mock.module('../memory/clarification-resolver.js', () => ({
  resolveConflictClarification: async () => ({
    resolution: 'still_unclear',
    strategy: 'heuristic',
    resolvedStatement: null,
    explanation: 'Need user clarification.',
  }),
}));

mock.module('../memory/admin.js', () => ({
  getMemoryConflictAndCleanupStats: () => ({
    conflicts: { pending: 0, resolved: 0, oldestPendingAgeMs: null },
    cleanup: { resolvedBacklog: 0, supersededBacklog: 0, resolvedCompleted24h: 0, supersededCompleted24h: 0 },
  }),
}));

mock.module('../memory/profile-compiler.js', () => ({
  compileDynamicProfile: () => null,
}));

mock.module('../memory/llm-usage-store.js', () => ({
  recordUsageEvent: () => ({ id: 'usage-1', createdAt: Date.now() }),
}));

mock.module('../memory/app-store.js', () => ({
  getApp: () => null,
  updateApp: () => {},
}));

// Mock agent loop: capture the onEvent handler so tests can inject tool_use/tool_result
mock.module('../agent/loop.js', () => ({
  AgentLoop: class {
    constructor() {}
    async run(messages: Message[], onEvent: (event: AgentEvent) => void): Promise<Message[]> {
      runCalls.push(messages);
      agentEventHandlers.push(onEvent);

      // Simulate a tool_use → tool_result → message_complete cycle
      onEvent({ type: 'tool_use', id: 'tu_1', name: 'file_write', input: { path: '/tmp/test.txt', content: 'hello' } });
      onEvent({ type: 'tool_result', toolUseId: 'tu_1', content: 'File written', isError: false });
      onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5, model: 'mock', providerDurationMs: 10 });

      const assistantMessage: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done writing file.' }],
      };
      onEvent({ type: 'message_complete', message: assistantMessage });
      return [...messages, assistantMessage];
    }
  },
}));

import { Session } from '../daemon/session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(): Session {
  const provider = {
    name: 'mock',
    async sendMessage(): Promise<ProviderResponse> {
      return { content: [], model: 'mock', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' };
    },
  };
  return new Session('conv-1', provider, 'system prompt', 4096, () => {}, '/tmp');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session tool-use ID tracking', () => {
  beforeEach(() => {
    runCalls = [];
    agentEventHandlers = [];
  });

  test('tool_use events populate the tool_use_id → toolName map', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage('Write a file', [], (event) => events.push(event));

    // The mock agent loop emits tool_use with name 'file_write' and id 'tu_1'
    // Verify that tool_use_start events were emitted (shows tracking worked)
    const toolUseStarts = events.filter(e => e.type === 'tool_use_start');
    expect(toolUseStarts).toHaveLength(1);
    expect((toolUseStarts[0] as { toolName: string }).toolName).toBe('file_write');

    // Verify tool_result events were also emitted
    const toolResults = events.filter(e => e.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
  });
});

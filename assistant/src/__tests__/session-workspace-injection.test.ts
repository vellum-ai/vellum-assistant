import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, ProviderResponse } from '../providers/types.js';
import type { AgentEvent } from '../agent/loop.js';

// ---------------------------------------------------------------------------
// Track agent loop calls
// ---------------------------------------------------------------------------

let runCalls: Message[][] = [];
let agentLoopScript: (onEvent: (event: AgentEvent) => void) => void = () => {};

// ---------------------------------------------------------------------------
// Mocks
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
      enabled: true, maxInputTokens: 100000, targetInputTokens: 80000,
      compactThreshold: 0.8, preserveRecentUserTurns: 8,
      summaryMaxTokens: 512, chunkTokens: 12000,
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    apiKeys: {},
    memory: { enabled: false },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module('../config/system-prompt.js', () => ({ buildSystemPrompt: () => 'system prompt' }));
mock.module('../config/skills.js', () => ({ loadSkillCatalog: () => [], loadSkillBySelector: () => ({ skill: null }), ensureSkillIcon: async () => null }));
mock.module('../config/skill-state.js', () => ({ resolveSkillStates: () => [] }));
mock.module('../skills/slash-commands.js', () => ({
  buildInvocableSlashCatalog: () => new Map(),
  resolveSlashSkillCommand: () => ({ kind: 'not_slash' }),
  rewriteKnownSlashCommandPrompt: () => '',
  parseSlashCandidate: () => ({ kind: 'not_slash' }),
}));
mock.module('../permissions/trust-store.js', () => ({ addRule: () => {}, findHighestPriorityRule: () => null, clearCache: () => {} }));
mock.module('../security/secret-allowlist.js', () => ({ resetAllowlist: () => {} }));

mock.module('../memory/conversation-store.js', () => ({
  getMessages: () => [],
  getConversation: () => ({
    id: 'conv-1', contextSummary: null, contextCompactedMessageCount: 0,
    contextCompactedAt: null, totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedCost: 0,
  }),
  addMessage: () => ({ id: 'msg-1' }),
  updateConversationUsage: () => {}, updateConversationTitle: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => ({ segmentIds: [], orphanedItemIds: [] }),
  deleteLastExchange: () => 0, isLastUserMessageToolResult: () => false,
}));

mock.module('../memory/attachments-store.js', () => ({ uploadAttachment: () => ({ id: 'att-1' }), linkAttachmentToMessage: () => {} }));
mock.module('../memory/retriever.js', () => ({
  buildMemoryRecall: async () => ({
    enabled: false, degraded: false, reason: null, provider: 'mock', model: 'mock',
    injectedText: '', lexicalHits: 0, semanticHits: 0, recencyHits: 0, entityHits: 0,
    relationSeedEntityCount: 0, relationTraversedEdgeCount: 0, relationNeighborEntityCount: 0,
    relationExpandedItemCount: 0, mergedCount: 0, selectedCount: 0, rerankApplied: false,
    injectedTokens: 0, latencyMs: 0, topCandidates: [],
  }),
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
  injectMemoryRecallAsSeparateMessage: (msgs: Message[]) => msgs,
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
}));
mock.module('../memory/query-builder.js', () => ({ buildMemoryQuery: () => '' }));
mock.module('../memory/retrieval-budget.js', () => ({ computeRecallBudget: () => 0 }));
mock.module('../context/window-manager.js', () => ({
  ContextWindowManager: class { async maybeCompact() { return { compacted: false }; } },
  createContextSummaryMessage: () => ({ role: 'user', content: [{ type: 'text', text: 'summary' }] }),
  getSummaryFromContextMessage: () => null,
}));
mock.module('../memory/conflict-store.js', () => ({ listPendingConflictDetails: () => [], markConflictAsked: () => true, applyConflictResolution: () => true }));
mock.module('../memory/clarification-resolver.js', () => ({
  resolveConflictClarification: async () => ({ resolution: 'still_unclear', strategy: 'heuristic', resolvedStatement: null, explanation: '' }),
}));
mock.module('../memory/admin.js', () => ({
  getMemoryConflictAndCleanupStats: () => ({
    conflicts: { pending: 0, resolved: 0, oldestPendingAgeMs: null },
    cleanup: { resolvedBacklog: 0, supersededBacklog: 0, resolvedCompleted24h: 0, supersededCompleted24h: 0 },
  }),
}));
mock.module('../memory/profile-compiler.js', () => ({ compileDynamicProfile: () => null }));
mock.module('../memory/llm-usage-store.js', () => ({ recordUsageEvent: () => ({ id: 'usage-1', createdAt: Date.now() }) }));
mock.module('../memory/app-store.js', () => ({ getApp: () => null, updateApp: () => {} }));

mock.module('../agent/loop.js', () => ({
  AgentLoop: class {
    constructor() {}
    async run(messages: Message[], onEvent: (event: AgentEvent) => void): Promise<Message[]> {
      runCalls.push(messages);
      agentLoopScript(onEvent);
      onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5, model: 'mock', providerDurationMs: 10 });
      const assistantMessage: Message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] };
      onEvent({ type: 'message_complete', message: assistantMessage });
      return [...messages, assistantMessage];
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

function messageText(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session workspace injection', () => {
  beforeEach(() => {
    runCalls = [];
    agentLoopScript = () => {};
  });

  test('runtime messages include workspace top-level context', async () => {
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage('Hello', [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    expect(runtimeUser.role).toBe('user');
    const text = messageText(runtimeUser);
    expect(text).toContain('<workspace_top_level>');
    expect(text).toContain('</workspace_top_level>');
  });

  test('workspace context includes root path and directories', async () => {
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage('Hello', [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    const text = messageText(runtimeUser);
    expect(text).toContain('Root: /tmp');
  });

  test('workspace context is prepended before user text', async () => {
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage('Hello', [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    const firstBlock = runtimeUser.content[0];
    expect(firstBlock.type).toBe('text');
    const firstText = (firstBlock as { type: 'text'; text: string }).text;
    expect(firstText).toContain('<workspace_top_level>');
  });
});

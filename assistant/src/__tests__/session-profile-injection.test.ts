import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, ProviderResponse } from '../providers/types.js';
import type { AgentEvent } from '../agent/loop.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

let runCalls: Message[][] = [];
let profileCompilerCalls = 0;
let profileEnabled = true;
let memoryEnabled = true;
let profileText = '[Dynamic User Profile]\n- timezone: America/Los_Angeles';

const persistedMessages: Array<{ id: string; role: string; content: string; createdAt: number }> = [];

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
    memory: {
      enabled: memoryEnabled,
      retrieval: {
        injectionStrategy: 'prepend_user_block',
        dynamicBudget: {
          enabled: false,
          minInjectTokens: 1200,
          maxInjectTokens: 10000,
          targetHeadroomTokens: 10000,
        },
      },
      conflicts: {
        enabled: false,
        gateMode: 'soft',
        reaskCooldownTurns: 3,
        resolverLlmTimeoutMs: 250,
        relevanceThreshold: 0.2,
      },
      profile: {
        enabled: profileEnabled,
        maxInjectTokens: 300,
      },
    },
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
  getMessages: () => persistedMessages,
  getConversation: () => ({
    id: 'conv-1',
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  addMessage: (_conversationId: string, role: string, content: string) => {
    const row = { id: `msg-${persistedMessages.length + 1}`, role, content, createdAt: Date.now() };
    persistedMessages.push(row);
    return { id: row.id };
  },
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
    enabled: true,
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
  getMemorySystemStatus: () => ({
    conflicts: { pending: 0, resolved: 0, oldestPendingAgeMs: null },
    cleanup: { resolvedBacklog: 0, supersededBacklog: 0, resolvedCompleted24h: 0, supersededCompleted24h: 0 },
  }),
}));

mock.module('../memory/profile-compiler.js', () => ({
  compileDynamicProfile: () => {
    profileCompilerCalls += 1;
    return {
      text: profileText,
      sourceCount: 2,
      selectedCount: 1,
      budgetTokens: 300,
      tokenEstimate: 28,
    };
  },
}));

mock.module('../memory/llm-usage-store.js', () => ({
  recordUsageEvent: () => ({ id: 'usage-1', createdAt: Date.now() }),
}));

mock.module('../agent/loop.js', () => ({
  AgentLoop: class {
    constructor() {}
    async run(messages: Message[], onEvent: (event: AgentEvent) => void): Promise<Message[]> {
      runCalls.push(messages);
      const assistantMessage: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'normal assistant answer' }],
      };
      onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5, model: 'mock', providerDurationMs: 10 });
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

function messageText(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n');
}

describe('Session dynamic profile injection', () => {
  beforeEach(() => {
    runCalls = [];
    persistedMessages.length = 0;
    profileCompilerCalls = 0;
    profileEnabled = true;
    memoryEnabled = true;
    profileText = '[Dynamic User Profile]\n- timezone: America/Los_Angeles';
  });

  test('injects profile context for runtime and strips it from persisted history', async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage('What should I do next?', [], (event) => events.push(event));

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    expect(runtimeUser.role).toBe('user');
    const runtimeText = messageText(runtimeUser);
    expect(runtimeText).toContain('[Dynamic profile context start]');
    expect(runtimeText).toContain('[Dynamic User Profile]');
    expect(runtimeText).toContain('[Dynamic profile context end]');

    const persistedUser = session.getMessages().find((message) => message.role === 'user');
    expect(persistedUser).toBeDefined();
    if (persistedUser) {
      const persistedText = messageText(persistedUser);
      expect(persistedText).not.toContain('[Dynamic profile context start]');
      expect(persistedText).not.toContain('[Dynamic User Profile]');
      expect(persistedText).not.toContain('[Dynamic profile context end]');
    }
    expect(profileCompilerCalls).toBe(1);
    expect(events.some((event) => event.type === 'message_complete')).toBe(true);
  });

  test('skips profile compilation/injection when memory.profile.enabled is false', async () => {
    profileEnabled = false;
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage('Explain rebase strategy', [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    const runtimeText = messageText(runtimeUser);
    expect(runtimeText).not.toContain('[Dynamic profile context start]');
    expect(profileCompilerCalls).toBe(0);
  });

  test('skips profile injection when top-level memory.enabled is false', async () => {
    memoryEnabled = false;
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage('What is my timezone?', [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    const runtimeText = messageText(runtimeUser);
    expect(runtimeText).not.toContain('[Dynamic profile context start]');
    expect(profileCompilerCalls).toBe(0);
  });
});

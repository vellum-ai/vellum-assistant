import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, ProviderResponse } from '../providers/types.js';
import type { AgentEvent } from '../agent/loop.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

let runCalls: Message[][] = [];
let resolverCallCount = 0;
let markAskedCalls: string[] = [];
let memoryEnabled = true;
let pendingConflicts: Array<{
  id: string;
  scopeId: string;
  existingItemId: string;
  candidateItemId: string;
  relationship: string;
  status: 'pending_clarification';
  clarificationQuestion: string | null;
  resolutionNote: string | null;
  lastAskedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  existingStatement: string;
  candidateStatement: string;
}> = [];

let resolverResult: {
  resolution: 'keep_existing' | 'keep_candidate' | 'merge' | 'still_unclear';
  strategy: 'heuristic' | 'llm' | 'llm_timeout' | 'llm_error' | 'no_llm_key';
  resolvedStatement: string | null;
  explanation: string;
} = {
  resolution: 'still_unclear',
  strategy: 'heuristic',
  resolvedStatement: null,
  explanation: 'Need user clarification.',
};

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
        enabled: true,
        gateMode: 'soft',
        reaskCooldownTurns: 3,
        resolverLlmTimeoutMs: 250,
        relevanceThreshold: 0.2,
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
  listPendingConflictDetails: () => pendingConflicts,
  markConflictAsked: (conflictId: string) => {
    markAskedCalls.push(conflictId);
    return true;
  },
  applyConflictResolution: () => true,
}));

mock.module('../memory/clarification-resolver.js', () => ({
  resolveConflictClarification: async () => {
    resolverCallCount += 1;
    return resolverResult;
  },
}));

mock.module('../memory/admin.js', () => ({
  getMemorySystemStatus: () => ({
    conflicts: { pending: 0, resolved: 0, oldestPendingAgeMs: null },
    cleanup: { resolvedBacklog: 0, supersededBacklog: 0, resolvedCompleted24h: 0, supersededCompleted24h: 0 },
  }),
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

function extractText(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n');
}

describe('Session conflict soft gate', () => {
  beforeEach(() => {
    runCalls = [];
    resolverCallCount = 0;
    markAskedCalls = [];
    memoryEnabled = true;
    pendingConflicts = [];
    persistedMessages.length = 0;
    resolverResult = {
      resolution: 'still_unclear',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'Need user clarification.',
    };
  });

  test('relevant unresolved conflict asks clarification and skips agent loop', async () => {
    pendingConflicts = [{
      id: 'conflict-relevant',
      scopeId: 'default',
      existingItemId: 'existing-a',
      candidateItemId: 'candidate-a',
      relationship: 'ambiguous_contradiction',
      status: 'pending_clarification',
      clarificationQuestion: 'Do you want React or Vue for frontend work?',
      resolutionNote: null,
      lastAskedAt: null,
      resolvedAt: null,
      createdAt: 1,
      updatedAt: 1,
      existingStatement: 'Use React for frontend work.',
      candidateStatement: 'Use Vue for frontend work.',
    }];

    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage('Should I use React or Vue here?', [], (event) => events.push(event));

    expect(runCalls).toHaveLength(0);
    expect(resolverCallCount).toBe(1);
    expect(markAskedCalls).toEqual(['conflict-relevant']);
    const clarificationEvent = events.find((event) => event.type === 'assistant_text_delta');
    expect(clarificationEvent).toBeDefined();
    if (clarificationEvent && clarificationEvent.type === 'assistant_text_delta') {
      expect(clarificationEvent.text).toContain('Do you want React or Vue');
    }
    expect(events.some((event) => event.type === 'message_complete')).toBe(true);
  });

  test('irrelevant unresolved conflict asks once and continues with normal answer flow', async () => {
    pendingConflicts = [{
      id: 'conflict-irrelevant',
      scopeId: 'default',
      existingItemId: 'existing-b',
      candidateItemId: 'candidate-b',
      relationship: 'ambiguous_contradiction',
      status: 'pending_clarification',
      clarificationQuestion: 'Should I assume Postgres or MySQL?',
      resolutionNote: null,
      lastAskedAt: null,
      resolvedAt: null,
      createdAt: 1,
      updatedAt: 1,
      existingStatement: 'Use Postgres as the default database.',
      candidateStatement: 'Use MySQL as the default database.',
    }];
    resolverResult = {
      resolution: 'keep_existing',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'Resolved by accident.',
    };

    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage('How do I set up pre-commit hooks?', [], (event) => events.push(event));

    expect(runCalls).toHaveLength(1);
    const injectedUser = runCalls[0][runCalls[0].length - 1];
    expect(injectedUser.role).toBe('user');
    const injectedText = extractText(injectedUser);
    expect(injectedText).toContain('Memory clarification request');
    expect(injectedText).toContain('Should I assume Postgres or MySQL?');
    expect(resolverCallCount).toBe(0);
    expect(markAskedCalls).toEqual(['conflict-irrelevant']);
    expect(events.some((event) => event.type === 'message_complete')).toBe(true);
  });

  test('recently asked conflicts still resolve directional clarification replies', async () => {
    pendingConflicts = [{
      id: 'conflict-followup',
      scopeId: 'default',
      existingItemId: 'existing-followup',
      candidateItemId: 'candidate-followup',
      relationship: 'ambiguous_contradiction',
      status: 'pending_clarification',
      clarificationQuestion: 'Should I assume Postgres or MySQL?',
      resolutionNote: null,
      lastAskedAt: null,
      resolvedAt: null,
      createdAt: 1,
      updatedAt: 1,
      existingStatement: 'Use Postgres as the default database.',
      candidateStatement: 'Use MySQL as the default database.',
    }];

    const session = makeSession();
    await session.loadFromDb();

    // First turn asks the clarification and records it as asked.
    await session.processMessage('Should I assume Postgres or MySQL?', [], () => {});
    expect(resolverCallCount).toBe(1);
    expect(markAskedCalls).toEqual(['conflict-followup']);

    resolverResult = {
      resolution: 'keep_candidate',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'Directional clarification received.',
    };

    // Follow-up reply does not overlap statement tokens but should still resolve.
    await session.processMessage('Keep the new one.', [], () => {});

    expect(resolverCallCount).toBe(2);
    expect(markAskedCalls).toEqual(['conflict-followup']);
    expect(runCalls).toHaveLength(1);
  });

  test('cooldown prevents repeated asks on subsequent turns', async () => {
    pendingConflicts = [{
      id: 'conflict-cooldown',
      scopeId: 'default',
      existingItemId: 'existing-c',
      candidateItemId: 'candidate-c',
      relationship: 'ambiguous_contradiction',
      status: 'pending_clarification',
      clarificationQuestion: 'Should I use pnpm or npm?',
      resolutionNote: null,
      lastAskedAt: null,
      resolvedAt: null,
      createdAt: 1,
      updatedAt: 1,
      existingStatement: 'Use pnpm for workspace installs.',
      candidateStatement: 'Use npm for workspace installs.',
    }];

    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage('How should I structure my repo?', [], () => {});
    await session.processMessage('What branch naming should I use?', [], () => {});

    expect(runCalls).toHaveLength(2);
    const firstUserText = extractText(runCalls[0][runCalls[0].length - 1]);
    const secondUserText = extractText(runCalls[1][runCalls[1].length - 1]);
    expect(firstUserText).toContain('Memory clarification request');
    expect(secondUserText).not.toContain('Memory clarification request');
    expect(markAskedCalls).toEqual(['conflict-cooldown']);
  });

  test('skips conflict gate when top-level memory.enabled is false', async () => {
    memoryEnabled = false;
    pendingConflicts = [{
      id: 'conflict-disabled',
      scopeId: 'default',
      existingItemId: 'existing-d',
      candidateItemId: 'candidate-d',
      relationship: 'ambiguous_contradiction',
      status: 'pending_clarification',
      clarificationQuestion: 'Do you want React or Vue for frontend work?',
      resolutionNote: null,
      lastAskedAt: null,
      resolvedAt: null,
      createdAt: 1,
      updatedAt: 1,
      existingStatement: 'Use React for frontend work.',
      candidateStatement: 'Use Vue for frontend work.',
    }];

    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage('Should I use React or Vue here?', [], (event) => events.push(event));

    // Agent loop should run normally — conflict gate should be bypassed
    expect(runCalls).toHaveLength(1);
    expect(resolverCallCount).toBe(0);
    expect(markAskedCalls).toEqual([]);
  });
});

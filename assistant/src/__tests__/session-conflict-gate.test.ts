import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Message, ProviderResponse } from '../providers/types.js';
import type { AgentEvent } from '../agent/loop.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

let runCalls: Message[][] = [];
let resolverCallCount = 0;
let markAskedCalls: string[] = [];
let conflictScopeCalls: string[] = [];
let memoryEnabled = true;
let askOnIrrelevantTurns = false;
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

function makeMockLogger(): Record<string, unknown> {
  const logger: Record<string, unknown> = {};
  logger.child = () => logger;
  logger.debug = () => {};
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  return logger;
}

mock.module('../util/logger.js', () => ({
  getLogger: () => makeMockLogger(),
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
        askOnIrrelevantTurns,
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
    earlyTerminated: false,
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
  listPendingConflictDetails: (scopeId: string) => {
    conflictScopeCalls.push(scopeId);
    return pendingConflicts;
  },
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
  getMemoryConflictAndCleanupStats: () => ({
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

import { Session, type SessionMemoryPolicy } from '../daemon/session.js';
import { looksLikeClarificationReply } from '../daemon/session-conflict-gate.js';

function makeSession(memoryPolicy?: SessionMemoryPolicy): Session {
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
  return new Session('conv-1', provider, 'system prompt', 4096, () => {}, '/tmp', undefined, memoryPolicy);
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
    conflictScopeCalls = [];
    memoryEnabled = true;
    askOnIrrelevantTurns = false;
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
    expect(resolverCallCount).toBe(0);
    expect(markAskedCalls).toEqual(['conflict-relevant']);
    const clarificationEvent = events.find((event) => event.type === 'assistant_text_delta');
    expect(clarificationEvent).toBeDefined();
    if (clarificationEvent && clarificationEvent.type === 'assistant_text_delta') {
      expect(clarificationEvent.text).toContain('Do you want React or Vue');
    }
    expect(events.some((event) => event.type === 'message_complete')).toBe(true);
  });

  test('irrelevant unresolved conflict does not inject side-question when askOnIrrelevantTurns is false (default)', async () => {
    pendingConflicts = [{
      id: 'conflict-irrelevant-silent',
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
    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage('How do I set up pre-commit hooks?', [], (event) => events.push(event));

    // Agent loop runs without conflict side-question injection
    expect(runCalls).toHaveLength(1);
    const injectedUser = runCalls[0][runCalls[0].length - 1];
    expect(injectedUser.role).toBe('user');
    const injectedText = extractText(injectedUser);
    expect(injectedText).not.toContain('Memory clarification request');
    expect(resolverCallCount).toBe(0);
    expect(markAskedCalls).toEqual([]);
    expect(events.some((event) => event.type === 'message_complete')).toBe(true);
  });

  test('irrelevant unresolved conflict injects soft clarification when askOnIrrelevantTurns is explicitly true', async () => {
    askOnIrrelevantTurns = true;
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
    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage('How do I set up pre-commit hooks?', [], (event) => events.push(event));

    // Agent loop still runs (soft ask, not a hard block)
    expect(runCalls).toHaveLength(1);
    const injectedUser = runCalls[0][runCalls[0].length - 1];
    expect(injectedUser.role).toBe('user');
    const injectedText = extractText(injectedUser);
    // With askOnIrrelevantTurns=true, the irrelevant conflict is soft-injected
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
    expect(resolverCallCount).toBe(0);
    expect(markAskedCalls).toEqual(['conflict-followup']);

    resolverResult = {
      resolution: 'keep_candidate',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'Directional clarification received.',
    };

    // Follow-up reply does not overlap statement tokens but should still resolve.
    await session.processMessage('Keep the new one.', [], () => {});

    expect(resolverCallCount).toBe(1);
    expect(markAskedCalls).toEqual(['conflict-followup']);
    expect(runCalls).toHaveLength(1);
  });

  test('concise directional replies like "both" or "option B" resolve recently asked conflicts', async () => {
    pendingConflicts = [{
      id: 'conflict-concise',
      scopeId: 'default',
      existingItemId: 'existing-concise',
      candidateItemId: 'candidate-concise',
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

    // First turn asks the clarification.
    await session.processMessage('Should I assume Postgres or MySQL?', [], () => {});
    expect(resolverCallCount).toBe(0);
    expect(markAskedCalls).toEqual(['conflict-concise']);

    resolverResult = {
      resolution: 'merge',
      strategy: 'heuristic',
      resolvedStatement: 'Support both Postgres and MySQL.',
      explanation: 'User wants both.',
    };

    // Short directional reply with no action verb should still resolve.
    await session.processMessage('both', [], () => {});

    expect(resolverCallCount).toBe(1);
    expect(runCalls).toHaveLength(1);
  });

  test('unrelated message during cooldown does not accidentally resolve conflict', async () => {
    pendingConflicts = [{
      id: 'conflict-unrelated',
      scopeId: 'default',
      existingItemId: 'existing-unrelated',
      candidateItemId: 'candidate-unrelated',
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

    // First turn: relevant question triggers clarification ask.
    await session.processMessage('Should I assume Postgres or MySQL?', [], () => {});
    expect(resolverCallCount).toBe(0);
    expect(markAskedCalls).toEqual(['conflict-unrelated']);

    // Second turn: unrelated question containing the cue word "new" should NOT
    // resolve the conflict — it is not a clarification reply.
    resolverResult = {
      resolution: 'keep_candidate',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'Directional clarification received.',
    };
    await session.processMessage("What's new in Bun?", [], () => {});

    // The resolver should NOT have been called for this unrelated question.
    expect(resolverCallCount).toBe(0);
    // Normal agent loop should still run.
    expect(runCalls).toHaveLength(1);
  });

  test('unrelated statement without question mark does not accidentally resolve conflict', async () => {
    pendingConflicts = [{
      id: 'conflict-unrelated-no-qmark',
      scopeId: 'default',
      existingItemId: 'existing-unrelated2',
      candidateItemId: 'candidate-unrelated2',
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

    // First turn: triggers clarification ask.
    await session.processMessage('Should I assume Postgres or MySQL?', [], () => {});
    expect(resolverCallCount).toBe(0);
    expect(markAskedCalls).toEqual(['conflict-unrelated-no-qmark']);

    resolverResult = {
      resolution: 'keep_candidate',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'Directional clarification received.',
    };

    // Unrelated statement with cue word "new" but no question mark and > 4 words.
    // Should NOT resolve the conflict.
    await session.processMessage('I started a new project today', [], () => {});

    expect(resolverCallCount).toBe(0);
    expect(runCalls).toHaveLength(1);
  });

  test('irrelevant conflicts remain silent across subsequent turns when askOnIrrelevantTurns is false (default)', async () => {
    pendingConflicts = [{
      id: 'conflict-silent-multi',
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
    // Both turns: no soft injection because askOnIrrelevantTurns=false
    expect(firstUserText).not.toContain('Memory clarification request');
    expect(secondUserText).not.toContain('Memory clarification request');
    expect(markAskedCalls).toEqual([]);
  });

  test('irrelevant conflict is soft-asked on first turn but cooldown prevents re-ask on subsequent turns when askOnIrrelevantTurns is explicitly true', async () => {
    askOnIrrelevantTurns = true;
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
    // First turn: askOnIrrelevantTurns=true causes soft injection
    expect(firstUserText).toContain('Memory clarification request');
    // Second turn: cooldown prevents re-asking
    expect(secondUserText).not.toContain('Memory clarification request');
    expect(markAskedCalls).toEqual(['conflict-cooldown']);
  });

  test('passes session scopeId through to conflict store queries', async () => {
    pendingConflicts = [{
      id: 'conflict-scoped',
      scopeId: 'thread:private-abc',
      existingItemId: 'existing-scoped',
      candidateItemId: 'candidate-scoped',
      relationship: 'ambiguous_contradiction',
      status: 'pending_clarification',
      clarificationQuestion: 'Do you prefer tabs or spaces?',
      resolutionNote: null,
      lastAskedAt: null,
      resolvedAt: null,
      createdAt: 1,
      updatedAt: 1,
      existingStatement: 'Use tabs for indentation.',
      candidateStatement: 'Use spaces for indentation.',
    }];

    const session = makeSession({
      scopeId: 'thread:private-abc',
      includeDefaultFallback: false,
      strictSideEffects: true,
    });
    await session.loadFromDb();

    await session.processMessage('tabs or spaces?', [], () => {});

    // Every call to listPendingConflictDetails should use the session's scopeId
    expect(conflictScopeCalls.length).toBeGreaterThan(0);
    expect(conflictScopeCalls.every((s) => s === 'thread:private-abc')).toBe(true);
    // No calls should have used the hardcoded 'default'
    expect(conflictScopeCalls).not.toContain('default');
  });

  test('default session uses "default" scopeId for conflict queries', async () => {
    pendingConflicts = [];

    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage('hello', [], () => {});

    // With no custom policy, scopeId should default to 'default'
    expect(conflictScopeCalls.every((s) => s === 'default')).toBe(true);
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

describe('looksLikeClarificationReply', () => {
  test('accepts action + direction combo', () => {
    expect(looksLikeClarificationReply('keep the new one')).toBe(true);
    expect(looksLikeClarificationReply('use the existing')).toBe(true);
    expect(looksLikeClarificationReply('go with option A')).toBe(true);
  });

  test('accepts directional-only replies', () => {
    expect(looksLikeClarificationReply('both')).toBe(true);
    expect(looksLikeClarificationReply('option B')).toBe(true);
    expect(looksLikeClarificationReply('new one')).toBe(true);
    expect(looksLikeClarificationReply('the existing one')).toBe(true);
    expect(looksLikeClarificationReply('merge them')).toBe(true);
  });

  test('accepts action-only replies', () => {
    expect(looksLikeClarificationReply('keep it')).toBe(true);
    expect(looksLikeClarificationReply('use that')).toBe(true);
  });

  test('rejects questions with question mark', () => {
    expect(looksLikeClarificationReply("what's new in Bun?")).toBe(false);
    expect(looksLikeClarificationReply('which option?')).toBe(false);
  });

  test('rejects questions without question mark', () => {
    expect(looksLikeClarificationReply("what's new in Bun")).toBe(false);
    expect(looksLikeClarificationReply('how do I use option A')).toBe(false);
    expect(looksLikeClarificationReply('where is the new config')).toBe(false);
  });

  test('rejects questions with Unicode smart/curly apostrophes', () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK (common on macOS/iOS keyboards)
    expect(looksLikeClarificationReply("what\u2019s new in Bun")).toBe(false);
    expect(looksLikeClarificationReply("where\u2019s the new config")).toBe(false);
    // U+2018 LEFT SINGLE QUOTATION MARK
    expect(looksLikeClarificationReply("who\u2018s option")).toBe(false);
  });

  test('accepts words that share a question-word prefix but are not questions', () => {
    // "whichever" starts with "which", "however" starts with "how", etc.
    // These should NOT be rejected by the question-word gate.
    expect(looksLikeClarificationReply('whichever option')).toBe(true);
    expect(looksLikeClarificationReply('however you want')).toBe(true);
  });

  test('rejects longer direction-only messages (false-positive prevention)', () => {
    // These contain directional cues but no action verb and are > 4 words,
    // so they are likely unrelated statements, not clarification replies.
    expect(looksLikeClarificationReply('try the old approach instead')).toBe(false);
    expect(looksLikeClarificationReply('I started a new project today')).toBe(false);
    expect(looksLikeClarificationReply('check out the latest release notes')).toBe(false);
  });

  test('rejects long statements', () => {
    expect(looksLikeClarificationReply(
      'I was thinking about this and I believe we should keep the new one because it is better',
    )).toBe(false);
  });

  test('rejects messages with no cue words', () => {
    expect(looksLikeClarificationReply('hello world')).toBe(false);
    expect(looksLikeClarificationReply('sounds good')).toBe(false);
  });
});

describe('ConflictGate askOnIrrelevantTurns knob', () => {
  const { ConflictGate } = require('../daemon/session-conflict-gate.js') as typeof import('../daemon/session-conflict-gate.js');

  const baseConfig = {
    enabled: true,
    gateMode: 'soft' as const,
    relevanceThreshold: 0.2,
    reaskCooldownTurns: 3,
    resolverLlmTimeoutMs: 250,
  };

  beforeEach(() => {
    markAskedCalls = [];
    pendingConflicts = [];
    resolverCallCount = 0;
    resolverResult = {
      resolution: 'still_unclear',
      strategy: 'heuristic',
      resolvedStatement: null,
      explanation: 'Need user clarification.',
    };
  });

  test('with askOnIrrelevantTurns=false, irrelevant conflict is not asked', async () => {
    pendingConflicts = [{
      id: 'conflict-irrel-false',
      scopeId: 'default',
      existingItemId: 'existing-irrel',
      candidateItemId: 'candidate-irrel',
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

    const gate = new ConflictGate();
    const result = await gate.evaluate(
      'How do I set up pre-commit hooks?',
      { ...baseConfig, askOnIrrelevantTurns: false },
    );

    expect(result).toBeNull();
    expect(markAskedCalls).toEqual([]);
  });

  test('with askOnIrrelevantTurns=true, irrelevant conflict is asked as non-relevant', async () => {
    pendingConflicts = [{
      id: 'conflict-irrel-true',
      scopeId: 'default',
      existingItemId: 'existing-irrel2',
      candidateItemId: 'candidate-irrel2',
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

    const gate = new ConflictGate();
    const result = await gate.evaluate(
      'How do I set up pre-commit hooks?',
      { ...baseConfig, askOnIrrelevantTurns: true },
    );

    expect(result).not.toBeNull();
    expect(result!.relevant).toBe(false);
    expect(result!.question).toContain('Postgres or MySQL');
    expect(markAskedCalls).toEqual(['conflict-irrel-true']);
  });

  test('relevant conflict is asked regardless of askOnIrrelevantTurns value', async () => {
    pendingConflicts = [{
      id: 'conflict-rel-knob',
      scopeId: 'default',
      existingItemId: 'existing-rel',
      candidateItemId: 'candidate-rel',
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

    // Test with askOnIrrelevantTurns=false — relevant conflicts should still be asked
    const gate = new ConflictGate();
    const result = await gate.evaluate(
      'Should I use React or Vue here?',
      { ...baseConfig, askOnIrrelevantTurns: false },
    );

    expect(result).not.toBeNull();
    expect(result!.relevant).toBe(true);
    expect(result!.question).toContain('React or Vue');
    expect(markAskedCalls).toEqual(['conflict-rel-knob']);
  });
});

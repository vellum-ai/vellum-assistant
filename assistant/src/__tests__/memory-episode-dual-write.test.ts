/**
 * Tests for dual-writing archive episodes from compaction summaries.
 *
 * Verifies:
 * - Normal compaction triggers an episode insertion
 * - Overflow (preflight) compaction triggers an episode insertion
 * - No episode is created when compaction does not produce a new summary
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ContextWindowResult } from "../context/window-manager.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message } from "../providers/types.js";

// ── Module mocks (must precede imports of the module under test) ─────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp",
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    provider: "mock-provider",
    maxTokens: 4096,
    thinking: false,
    contextWindow: {
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      preserveRecentMessages: 6,
      summaryModel: "mock-model",
      maxSummaryTokens: 512,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "truncate",
      },
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    workspaceGit: { turnCommitMaxWaitMs: 10 },
    ui: {},
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// Token estimator — small by default to avoid preflight trigger
let mockEstimateTokens = 1000;
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () => mockEstimateTokens,
}));

// Reducer
let mockReducerStepFn:
  | ((msgs: Message[], cfg: unknown, state: unknown) => unknown)
  | null = null;
mock.module("../daemon/context-overflow-reducer.js", () => ({
  createInitialReducerState: () => ({
    appliedTiers: [],
    injectionMode: "full" as const,
    exhausted: false,
  }),
  reduceContextOverflow: async (
    msgs: Message[],
    cfg: unknown,
    state: unknown,
  ) => {
    if (mockReducerStepFn) return mockReducerStepFn(msgs, cfg, state);
    return {
      messages: msgs,
      tier: "forced_compaction",
      state: {
        appliedTiers: [
          "forced_compaction",
          "tool_result_truncation",
          "media_stubbing",
          "injection_downgrade",
        ],
        injectionMode: "full",
        exhausted: true,
      },
      estimatedTokens: 1000,
    };
  },
}));

mock.module("../daemon/context-overflow-policy.js", () => ({
  resolveOverflowAction: () => "fail_gracefully",
}));

mock.module("../daemon/context-overflow-approval.js", () => ({
  requestCompressionApproval: async () => ({ approved: false }),
  CONTEXT_OVERFLOW_TOOL_NAME: "context_overflow_compression",
}));

mock.module("../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: async () => ({ blocked: false }),
  }),
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  updateConversationUsage: () => {},
  getMessages: () => [],
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  }),
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  addMessage: () => ({ id: "mock-msg-id" }),
  deleteMessageById: () => {},
  updateConversationContextWindow: () => {},
  updateConversationTitle: () => {},
  getConversationOriginChannel: () => null,
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
  rebuildConversationDiskViewFromDbState: () => {},
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",
    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallAsUserBlock: (msgs: Message[]) => msgs,
}));

mock.module("../memory/app-store.js", () => ({
  getApp: () => null,
  listAppFiles: () => [],
  getAppsDir: () => "/tmp/apps",
}));

mock.module("../memory/app-git-service.js", () => ({
  commitAppTurnChanges: () => Promise.resolve(),
}));

mock.module("../daemon/conversation-memory.js", () => ({
  prepareMemoryContext: async (
    _ctx: unknown,
    _content: string,
    _id: string,
    _signal: AbortSignal,
  ) => ({
    runMessages: [],
    recall: {
      enabled: false,
      degraded: false,
      injectedText: "",
      semanticHits: 0,
      recencyHits: 0,
      injectedTokens: 0,
      latencyMs: 0,
      tier1Count: 0,
      tier2Count: 0,
      hybridSearchMs: 0,
    },
  }),
}));

mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  applyRuntimeInjections: (msgs: Message[]) => msgs,
  stripInjectedContext: (msgs: Message[]) => msgs,
}));

mock.module("../daemon/date-context.js", () => ({
  buildTemporalContext: () => null,
}));

mock.module("../daemon/history-repair.js", () => ({
  repairHistory: (msgs: Message[]) => ({
    messages: msgs,
    stats: {
      assistantToolResultsMigrated: 0,
      missingToolResultsInserted: 0,
      orphanToolResultsDowngraded: 0,
      consecutiveSameRoleMerged: 0,
    },
  }),
  deepRepairHistory: (msgs: Message[]) => ({ messages: msgs, stats: {} }),
}));

mock.module("../daemon/conversation-history.js", () => ({
  consolidateAssistantMessages: () => false,
}));

mock.module("../daemon/conversation-usage.js", () => ({
  recordUsage: () => {},
}));

mock.module("../daemon/conversation-attachments.js", () => ({
  resolveAssistantAttachments: async () => ({
    assistantAttachments: [],
    emittedAttachments: [],
    directiveWarnings: [],
  }),
  approveHostAttachmentRead: async () => true,
  formatAttachmentWarnings: () => "",
}));

mock.module("../daemon/assistant-attachments.js", () => ({
  cleanAssistantContent: (content: unknown[]) => ({
    cleanedContent: content,
    directives: [],
    warnings: [],
  }),
  drainDirectiveDisplayBuffer: (buffer: string) => ({
    emitText: buffer,
    bufferedRemainder: "",
  }),
}));

mock.module("../daemon/conversation-media-retry.js", () => ({
  stripMediaPayloadsForRetry: (msgs: Message[]) => ({
    messages: msgs,
    modified: false,
    replacedBlocks: 0,
    latestUserIndex: null,
  }),
  raceWithTimeout: async () => "completed" as const,
}));

mock.module("../workspace/turn-commit.js", () => ({
  commitTurnChanges: async () => {},
}));

mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
  }),
}));

mock.module("../daemon/conversation-error.js", () => ({
  classifyConversationError: (_err: unknown, _ctx: unknown) => ({
    code: "CONVERSATION_PROCESSING_FAILED",
    userMessage: "Something went wrong processing your message.",
    retryable: false,
    errorCategory: "processing_failed",
  }),
  isUserCancellation: (err: unknown, ctx: { aborted?: boolean }) => {
    if (!ctx.aborted) return false;
    if (err instanceof DOMException && err.name === "AbortError") return true;
    if (err instanceof Error && err.name === "AbortError") return true;
    return false;
  },
  buildConversationErrorMessage: (
    conversationId: string,
    classified: Record<string, unknown>,
  ) => ({
    type: "conversation_error",
    conversationId,
    ...classified,
  }),
  isContextTooLarge: (msg: string) => /context.?length.?exceeded/i.test(msg),
}));

mock.module("../daemon/conversation-slash.js", () => ({
  isProviderOrderingError: (msg: string) =>
    /ordering|before.*after|messages.*order/i.test(msg),
}));

mock.module("../util/truncate.js", () => ({
  truncate: (s: string, maxLen: number) =>
    s.length <= maxLen ? s : s.slice(0, maxLen),
}));

mock.module("../agent/message-types.js", () => ({
  createAssistantMessage: (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text", text }],
  }),
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Archive store mock — tracks insertCompactionEpisode calls ────────

const insertCompactionEpisodeCalls: Array<{
  conversationId: string;
  scopeId?: string;
  title: string;
  summary: string;
  tokenEstimate: number;
}> = [];

mock.module("../memory/archive-store.js", () => ({
  insertCompactionEpisode: (params: {
    conversationId: string;
    scopeId?: string;
    title: string;
    summary: string;
    tokenEstimate: number;
    startAt: number;
    endAt: number;
  }) => {
    insertCompactionEpisodeCalls.push({
      conversationId: params.conversationId,
      scopeId: params.scopeId,
      title: params.title,
      summary: params.summary,
      tokenEstimate: params.tokenEstimate,
    });
    return { episodeId: "mock-episode-id", jobId: "mock-job-id" };
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import {
  type AgentLoopConversationContext,
  runAgentLoopImpl,
} from "../daemon/conversation-agent-loop.js";

// ── Test helpers ─────────────────────────────────────────────────────

type AgentLoopRun = (
  messages: Message[],
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  requestId?: string,
  onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
) => Promise<Message[]>;

function makeCompactResult(
  summaryText: string,
  overrides?: Partial<ContextWindowResult>,
): ContextWindowResult {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `[Summary] ${summaryText}` }],
      },
    ] as Message[],
    compacted: true,
    previousEstimatedInputTokens: 80000,
    estimatedInputTokens: 30000,
    maxInputTokens: 100000,
    thresholdTokens: 80000,
    compactedMessages: 10,
    compactedPersistedMessages: 8,
    summaryCalls: 1,
    summaryInputTokens: 500,
    summaryOutputTokens: 150,
    summaryModel: "mock-model",
    summaryText,
    ...overrides,
  };
}

function makeCtx(
  overrides?: Partial<AgentLoopConversationContext> & {
    agentLoopRun?: AgentLoopRun;
  },
): AgentLoopConversationContext {
  const agentLoopRun =
    overrides?.agentLoopRun ??
    (async (messages: Message[]) => [
      ...messages,
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "response" }],
      },
    ]);

  return {
    conversationId: "test-conv",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ] as Message[],
    processing: true,
    abortController: new AbortController(),
    currentRequestId: "test-req",

    agentLoop: {
      run: agentLoopRun,
      getToolTokenBudget: () => 0,
    } as unknown as AgentLoopConversationContext["agentLoop"],
    provider: {
      name: "mock-provider",
      sendMessage: async () => ({
        content: [{ type: "text", text: "title" }],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      }),
    } as unknown as AgentLoopConversationContext["provider"],
    systemPrompt: "system prompt",

    contextWindowManager: {
      shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
      maybeCompact: async () => ({ compacted: false }),
    } as unknown as AgentLoopConversationContext["contextWindowManager"],
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,

    memoryPolicy: { scopeId: "default", includeDefaultFallback: true },

    currentActiveSurfaceId: undefined,
    currentPage: undefined,
    surfaceState: new Map(),
    pendingSurfaceActions: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],

    workingDir: "/tmp",
    workspaceTopLevelContext: null,
    workspaceTopLevelDirty: false,
    channelCapabilities: undefined,
    commandIntent: undefined,
    trustContext: undefined,

    coreToolNames: new Set(),
    allowedToolNames: undefined,
    preactivatedSkillIds: undefined,
    skillProjectionState: new Map(),
    skillProjectionCache:
      new Map() as unknown as AgentLoopConversationContext["skillProjectionCache"],

    traceEmitter: {
      emit: () => {},
    } as unknown as AgentLoopConversationContext["traceEmitter"],
    profiler: {
      startRequest: () => {},
      emitSummary: () => {},
    } as unknown as AgentLoopConversationContext["profiler"],
    usageStats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      model: "",
    },
    turnCount: 0,

    lastAssistantAttachments: [],
    lastAttachmentWarnings: [],

    hasNoClient: false,
    streamThinking: false,
    prompter: {} as unknown as AgentLoopConversationContext["prompter"],
    queue: {} as unknown as AgentLoopConversationContext["queue"],

    getWorkspaceGitService: () => ({ ensureInitialized: async () => {} }),
    commitTurnChanges: async () => {},

    refreshWorkspaceTopLevelContextIfNeeded: () => {},
    markWorkspaceTopLevelDirty: () => {},
    emitActivityState: () => {},
    emitConfirmationStateChanged: () => {},
    getQueueDepth: () => 0,
    hasQueuedMessages: () => false,
    canHandoffAtCheckpoint: () => false,
    drainQueue: () => {},
    getTurnInterfaceContext: () => null,
    getTurnChannelContext: () => ({
      userMessageChannel: "vellum" as const,
      assistantMessageChannel: "vellum" as const,
    }),

    toolsDisabledDepth: 0,

    ...overrides,
  } as AgentLoopConversationContext;
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  insertCompactionEpisodeCalls.length = 0;
  mockEstimateTokens = 1000;
  mockReducerStepFn = null;
});

describe("memory episode dual-write from compaction", () => {
  test("normal compaction creates a compaction episode", async () => {
    const summaryText =
      "User discussed project blockers and asked about deployment timeline.";
    const compactResult = makeCompactResult(summaryText);

    const ctx = makeCtx({
      contextWindowManager: {
        shouldCompact: () => ({ needed: true, estimatedTokens: 85000 }),
        maybeCompact: async () => compactResult,
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(insertCompactionEpisodeCalls.length).toBe(1);
    expect(insertCompactionEpisodeCalls[0]!.conversationId).toBe("test-conv");
    expect(insertCompactionEpisodeCalls[0]!.scopeId).toBe("default");
    expect(insertCompactionEpisodeCalls[0]!.summary).toBe(summaryText);
    expect(insertCompactionEpisodeCalls[0]!.tokenEstimate).toBe(150);
  });

  test("overflow (preflight) compaction creates a compaction episode", async () => {
    // Make the preflight budget check trigger by returning a high token count
    mockEstimateTokens = 200000;

    const summaryText = "Overflow compaction summary of earlier conversation.";
    const compactResult = makeCompactResult(summaryText, {
      summaryOutputTokens: 200,
    });

    // The reducer step must trigger compaction via its compactionResult
    mockReducerStepFn = (_msgs: Message[]) => ({
      messages: compactResult.messages,
      tier: "forced_compaction",
      state: {
        appliedTiers: [
          "forced_compaction",
          "tool_result_truncation",
          "media_stubbing",
          "injection_downgrade",
        ],
        injectionMode: "full",
        exhausted: true,
      },
      estimatedTokens: 30000,
      compactionResult: compactResult,
    });

    const ctx = makeCtx({
      contextWindowManager: {
        shouldCompact: () => ({ needed: false, estimatedTokens: 200000 }),
        maybeCompact: async () => ({ compacted: false }),
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(insertCompactionEpisodeCalls.length).toBe(1);
    expect(insertCompactionEpisodeCalls[0]!.conversationId).toBe("test-conv");
    expect(insertCompactionEpisodeCalls[0]!.summary).toBe(summaryText);
    expect(insertCompactionEpisodeCalls[0]!.tokenEstimate).toBe(200);
  });

  test("no episode created when compaction does not produce a new summary", async () => {
    // Compaction returns compacted: false — no new summary was produced
    const ctx = makeCtx({
      contextWindowManager: {
        shouldCompact: () => ({ needed: false, estimatedTokens: 5000 }),
        maybeCompact: async () => ({ compacted: false }),
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(insertCompactionEpisodeCalls.length).toBe(0);
  });

  test("episode uses the conversation's memory scope", async () => {
    const summaryText = "Scoped compaction summary.";
    const compactResult = makeCompactResult(summaryText);

    const ctx = makeCtx({
      memoryPolicy: { scopeId: "project-alpha", includeDefaultFallback: false },
      contextWindowManager: {
        shouldCompact: () => ({ needed: true, estimatedTokens: 85000 }),
        maybeCompact: async () => compactResult,
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(insertCompactionEpisodeCalls.length).toBe(1);
    expect(insertCompactionEpisodeCalls[0]!.scopeId).toBe("project-alpha");
  });

  test("existing contextSummary persistence is unchanged alongside episode write", async () => {
    const events: ServerMessage[] = [];
    const summaryText =
      "Compaction summary that should be persisted in both places.";
    const compactResult = makeCompactResult(summaryText);

    const ctx = makeCtx({
      contextWindowManager: {
        shouldCompact: () => ({ needed: true, estimatedTokens: 85000 }),
        maybeCompact: async () => compactResult,
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // The context_compacted event should still be emitted (existing behavior)
    const compactEvent = events.find((e) => e.type === "context_compacted");
    expect(compactEvent).toBeDefined();

    // And the episode should also be created (new dual-write behavior)
    expect(insertCompactionEpisodeCalls.length).toBe(1);
    expect(insertCompactionEpisodeCalls[0]!.summary).toBe(summaryText);
  });
});

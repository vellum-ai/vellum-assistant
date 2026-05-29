import { createRequire } from "node:module";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent, AgentLoopRunOptions } from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type { ContentBlock, Message } from "../providers/types.js";

const conversationCrudRealSnapshot = {
  ...(createRequire(import.meta.url)(
    "../memory/conversation-crud.js",
  ) as Record<string, unknown>),
};
const conversationDiskViewRealSnapshot = {
  ...(createRequire(import.meta.url)(
    "../memory/conversation-disk-view.js",
  ) as Record<string, unknown>),
};
let mockUiConfig: { userTimezone?: string; detectedTimezone?: string } = {};

// ── Module mocks (must precede imports of the module under test) ─────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: {
      default: {
        provider: "mock-provider",
        model: "mock-model",
        maxTokens: 4096,
        effort: "max" as const,
        speed: "standard" as const,
        temperature: null,
        thinking: { enabled: false, streamThinking: true },
        contextWindow: {
          enabled: true,
          maxInputTokens: 100000,
          targetBudgetRatio: 0.3,
          compactThreshold: 0.8,
          summaryBudgetRatio: 0.05,
          overflowRecovery: {
            enabled: true,
            safetyMarginRatio: 0.05,
            maxAttempts: 3,
            interactiveLatestTurnCompression: "summarize",
            nonInteractiveLatestTurnCompression: "truncate",
          },
        },
      },
      profiles: {},
      callSites: {},
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    workspaceGit: { turnCommitMaxWaitMs: 10 },
    memory: { retrieval: { scratchpadInjection: { enabled: true } } },
    ui: mockUiConfig,
    compaction: { enabled: true, autoThreshold: 0.7 },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// ── Overflow recovery mocks ──────────────────────────────────────────

// Token estimator returns a small value by default (well within budget)
// so preflight does not trigger unless the test overrides it. Both the
// calibrated entry point (`estimatePromptTokens`, used in the convergence
// path) and the raw entry point (`estimatePromptTokensRaw`, used by the
// default `tokenEstimate` plugin pipeline for preflight/mid-loop) are
// stubbed so either call site can drive the test.
let mockEstimateTokens = 1000;
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () => mockEstimateTokens,
  estimatePromptTokensRaw: () => mockEstimateTokens,
  // Pass-through: the default plugin computes `toolTokenBudget` via this
  // helper before delegating to the raw estimator. Return 0 so the mocked
  // raw estimate is not perturbed.
  estimateToolsTokens: () => 0,
}));

// Reducer: by default returns the input untouched and marks exhausted
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

// Policy: default to fail_gracefully
let mockOverflowAction: string = "fail_gracefully";
mock.module("../daemon/context-overflow-policy.js", () => ({
  resolveOverflowAction: () => mockOverflowAction,
}));

const mockDiskPressureStatus = {
  enabled: true,
  state: "critical",
  locked: true,
  acknowledged: true,
  overrideActive: false,
  effectivelyLocked: true,
  lockId: "disk-pressure-test",
  usagePercent: 98,
  thresholdPercent: 95,
  path: "/workspace",
  lastCheckedAt: "2026-05-05T00:00:00.000Z",
  blockedCapabilities: ["agent-turns", "background-work", "remote-ingress"],
  error: null,
};
let mockDiskPressureDecision: Record<string, unknown> = {
  action: "allow-normal",
};
const classifyDiskPressureTurnPolicyMock = mock(
  (_status: unknown, _metadata: unknown) => mockDiskPressureDecision,
);
mock.module("../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => mockDiskPressureStatus,
}));
mock.module("../daemon/disk-pressure-policy.js", () => ({
  classifyDiskPressureTurnPolicy: classifyDiskPressureTurnPolicyMock,
}));

const updateMessageMetadataMock = mock(
  (_id: string, _updates: Record<string, unknown>) => {},
);
const setConversationHistoryStrippedAtMock = mock(
  (_conversationId: string, _historyStrippedAt: number | null) => {},
);
const updateConversationSlackContextWatermarkMock = mock(
  (_conversationId: string, _watermarkTs: string, _compactedAt?: number) => {},
);
let mockConversationRow: Record<string, unknown> = {
  id: "conv-1",
  contextSummary: null,
  contextCompactedMessageCount: 0,
  slackContextCompactionWatermarkTs: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedCost: 0,
  title: null,
};
let mockMessageById: Record<string, unknown> | null = null;
const deleteMessageByIdMock = mock(() => ({
  segmentIds: [],
  deletedSummaryIds: [],
}));
const reserveMessageMock = mock(async () => ({ id: "msg-reserve" }));
const updateMessageContentMock = mock(() => {});
mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  updateConversationUsage: () => {},
  updateMessageMetadata: updateMessageMetadataMock,
  setConversationHistoryStrippedAt: setConversationHistoryStrippedAtMock,
  getMessages: () => [],
  getConversation: () => mockConversationRow,
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  addMessage: () => ({ id: "mock-msg-id" }),
  deleteMessageById: deleteMessageByIdMock,
  updateConversationContextWindow: () => {},
  updateConversationSlackContextWatermark:
    updateConversationSlackContextWatermarkMock,
  updateConversationTitle: () => {},
  getConversationOriginChannel: () => null,
  getMessageById: () => mockMessageById,
  getLastUserTimestampBefore: () => 0,
  reserveMessage: reserveMessageMock,
  updateMessageContent: updateMessageContentMock,
  // The real schema is a Zod object; tests don't exercise validation,
  // so a passthrough is sufficient — the production code at
  // `handleMessageComplete` only branches on `success` and reads two
  // fields off `data`. `safeParse` of an empty object satisfies the
  // schema (every field is optional).
  messageMetadataSchema: {
    safeParse: (input: unknown) => ({ success: true, data: input ?? {} }),
  },
}));

// The B3 indexing-restoration path imports `indexMessageNow` from
// `../memory/indexer.js` and `projectAssistantMessage` from
// `../memory/conversation-attention-store.js`; without these stubs the
// real modules would try to open a SQLite DB and read a real config.
const indexMessageNowMock = mock(async () => ({
  indexedSegments: 0,
  enqueuedJobs: 0,
}));
const projectAssistantMessageMock = mock(() => false);
const publishSyncInvalidationMock = mock(async () => {});
mock.module("../memory/indexer.js", () => ({
  indexMessageNow: indexMessageNowMock,
}));
mock.module("../memory/conversation-attention-store.js", () => ({
  projectAssistantMessage: projectAssistantMessageMock,
}));
mock.module("../runtime/sync/sync-publisher.js", () => ({
  publishSyncInvalidation: publishSyncInvalidationMock,
}));

afterAll(() => {
  mock.module(
    "../memory/conversation-crud.js",
    () => conversationCrudRealSnapshot,
  );
  mock.module(
    "../memory/conversation-disk-view.js",
    () => conversationDiskViewRealSnapshot,
  );
});

const syncMessageToDiskMock = mock(() => {});
const rebuildConversationDiskViewFromDbStateMock = mock(() => {});
mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: syncMessageToDiskMock,
  rebuildConversationDiskViewFromDbState:
    rebuildConversationDiskViewFromDbStateMock,
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",

    semanticHits: 0,
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
      injectedTokens: 0,
      latencyMs: 0,
      tier1Count: 0,
      tier2Count: 0,
      hybridSearchMs: 0,
    },
  }),
}));

let mockInjectionBlocks: {
  pkbSystemReminder?: string;
  unifiedTurnContext?: string;
} = {};
const buildUnifiedTurnContextBlockMock = mock(
  (options: Record<string, unknown>) =>
    `<turn_context>\ncurrent_time: ${String(options.timestamp)}\n</turn_context>`,
);
const applyRuntimeInjectionsMock = mock(
  async (msgs: Message[], _options?: unknown) => ({
    messages: msgs,
    blocks: { ...mockInjectionBlocks },
  }),
);
let mockSlackChronologicalContext: {
  renderedMessages: Array<{
    message: Message;
    sourceChannelTs: string | null;
    tagLineProvenance: "none" | "slack-reaction" | "slack-timezone-message";
  }>;
  messages: Message[];
  compactableStartIndex: number;
} | null = null;
const loadSlackChronologicalContextMock = mock(
  (
    _conversationId: string,
    _capabilities: unknown,
    _options?: Record<string, unknown>,
  ) => mockSlackChronologicalContext,
);
const getSlackCompactionWatermarkForPrefixMock = mock(
  (
    context: typeof mockSlackChronologicalContext,
    compactedRenderedMessages: number,
  ) => {
    if (!context || compactedRenderedMessages <= 0) return null;
    const start = context.compactableStartIndex;
    const end = Math.min(
      context.renderedMessages.length,
      start + compactedRenderedMessages,
    );
    const values = context.renderedMessages
      .slice(start, end)
      .map((entry) => entry.sourceChannelTs)
      .filter((value): value is string => value !== null);
    return values.length > 0 ? values[values.length - 1]! : null;
  },
);
mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  applyRuntimeInjections: applyRuntimeInjectionsMock,
  buildUnifiedTurnContextBlock: buildUnifiedTurnContextBlockMock,
  stripInjectionsForCompaction: (msgs: Message[]) => msgs,
  findLastInjectedNowContent: () => null,
  readNowScratchpad: () => null,
  readPkbContext: () => null,
  getPkbAutoInjectList: () => [
    "INDEX.md",
    "essentials.md",
    "threads.md",
    "buffer.md",
  ],
  isSlackChannelConversation: () => false,
  getSlackCompactionWatermarkForPrefix:
    getSlackCompactionWatermarkForPrefixMock,
  loadSlackChronologicalContext: loadSlackChronologicalContextMock,
  loadSlackChronologicalMessages: () => null,
  loadSlackActiveThreadFocusBlock: () => null,
  assembleSlackChronologicalMessages: () => null,
  assembleSlackActiveThreadFocusBlock: () => null,
}));

const resolveTurnTimezoneContextMock = mock(
  (options: {
    configuredUserTimeZone?: string | null;
    clientTimezone?: string | null;
    detectedTimezone?: string | null;
    hostTimeZone?: string | null;
  }) => ({
    configuredUserTimezone: options.configuredUserTimeZone ?? null,
    clientTimezone: options.clientTimezone ?? null,
    detectedTimezone: options.detectedTimezone ?? null,
    hostTimezone: options.hostTimeZone ?? "UTC",
    effectiveTimezone:
      options.configuredUserTimeZone ??
      options.clientTimezone ??
      options.detectedTimezone ??
      options.hostTimeZone ??
      "UTC",
    source: options.configuredUserTimeZone
      ? "configuredUserTimezone"
      : options.clientTimezone
        ? "clientTimezone"
        : options.detectedTimezone
          ? "detectedTimezone"
          : options.hostTimeZone
            ? "hostTimezone"
            : "utcFallback",
  }),
);
const formatTurnTimestampMock = mock(
  (_options?: unknown) => "2026-01-01 (Thursday) 00:00:00 +00:00 (UTC)",
);
mock.module("../daemon/date-context.js", () => ({
  formatTurnTimestamp: formatTurnTimestampMock,
  resolveTurnTimezoneContext: resolveTurnTimezoneContextMock,
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

const recordUsageMock = mock(() => {});
const recordRequestLogMock = mock(() => {});
const backfillMessageIdOnLogsMock = mock(() => {});
const setAgentLoopExitReasonOnLatestLogMock = mock(() => {});
mock.module("../daemon/conversation-usage.js", () => ({
  recordUsage: recordUsageMock,
}));

const resolveAssistantAttachmentsMock = mock(async () => ({
  assistantAttachments: [],
  emittedAttachments: [],
  directiveWarnings: [],
}));
mock.module("../daemon/conversation-attachments.js", () => ({
  resolveAssistantAttachments: resolveAssistantAttachmentsMock,
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
  truncate: (s: string) => s,
}));

mock.module("../agent/message-types.js", () => ({
  createAssistantMessage: (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text", text }],
  }),
}));

mock.module("../memory/archive-store.js", () => ({
  insertCompactionEpisode: () => ({
    episodeId: "mock-episode-id",
    jobId: "mock-job-id",
  }),
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: recordRequestLogMock,
  backfillMessageIdOnLogs: backfillMessageIdOnLogsMock,
  setAgentLoopExitReasonOnLatestLog: setAgentLoopExitReasonOnLatestLogMock,
}));

let mockHasProactiveArtifactCompleted = true;
let mockTryClaimProactiveArtifactTrigger = false;
const runProactiveArtifactJobMock = mock(
  async (_params: Record<string, unknown>) => {},
);
mock.module("../proactive-artifact/index.js", () => ({
  hasProactiveArtifactCompleted: () => mockHasProactiveArtifactCompleted,
  tryClaimProactiveArtifactTrigger: () => mockTryClaimProactiveArtifactTrigger,
  runProactiveArtifactJob: runProactiveArtifactJobMock,
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import {
  type AgentLoopConversationContext,
  applyCompactionResult,
  runAgentLoopImpl,
} from "../daemon/conversation-agent-loop.js";

// ── Test helpers ─────────────────────────────────────────────────────

type AgentLoopRun = (
  messages: Message[],
  onEvent: (event: AgentEvent) => void | Promise<void>,
  options?: AgentLoopRunOptions,
) => Promise<Message[]>;

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
      getResolvedTools: () => [],
      // Tests here don't exercise calibration; returning undefined makes
      // the estimator use the per-provider aggregate key.
      getActiveModel: () => undefined,
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
    prompter: {} as unknown as AgentLoopConversationContext["prompter"],
    queue: {} as unknown as AgentLoopConversationContext["queue"],

    getWorkspaceGitService: () => ({ ensureInitialized: async () => {} }),
    commitTurnChanges: async () => {},

    refreshWorkspaceTopLevelContextIfNeeded: () => {},
    markWorkspaceTopLevelDirty: () => {},
    emitActivityState: () => {},
    getQueueDepth: () => 0,
    hasQueuedMessages: () => false,
    canHandoffAtCheckpoint: () => false,
    drainQueue: () => {},
    getTurnInterfaceContext: () => null,
    getTurnChannelContext: () => ({
      userMessageChannel: "vellum" as const,
      assistantMessageChannel: "vellum" as const,
    }),

    graphMemory: {
      onCompacted: async () => {},
      prepareMemory: async () => ({
        runMessages: [],
        injectedTokens: 0,
        latencyMs: 0,
        mode: "none" as const,
      }),
      reinjectCachedMemory: (messages: Message[]) => ({
        runMessages: messages,
        injectedTokens: 0,
      }),
      retrackCachedNodes: () => {},
    } as unknown as AgentLoopConversationContext["graphMemory"],

    ...overrides,
  } as AgentLoopConversationContext;
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  mockUiConfig = {};
  mockEstimateTokens = 1000;
  mockReducerStepFn = null;
  mockOverflowAction = "fail_gracefully";
  mockDiskPressureDecision = { action: "allow-normal" };
  classifyDiskPressureTurnPolicyMock.mockClear();
  mockInjectionBlocks = {};
  recordUsageMock.mockClear();
  recordRequestLogMock.mockClear();
  backfillMessageIdOnLogsMock.mockClear();
  setAgentLoopExitReasonOnLatestLogMock.mockClear();
  syncMessageToDiskMock.mockClear();
  rebuildConversationDiskViewFromDbStateMock.mockClear();
  updateMessageMetadataMock.mockClear();
  updateMessageMetadataMock.mockImplementation(() => {});
  updateConversationSlackContextWatermarkMock.mockClear();
  updateConversationSlackContextWatermarkMock.mockImplementation(() => {});
  mockConversationRow = {
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    slackContextCompactionWatermarkTs: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  };
  mockMessageById = null;
  mockHasProactiveArtifactCompleted = true;
  mockTryClaimProactiveArtifactTrigger = false;
  runProactiveArtifactJobMock.mockClear();
  setConversationHistoryStrippedAtMock.mockClear();
  setConversationHistoryStrippedAtMock.mockImplementation(() => {});
  applyRuntimeInjectionsMock.mockClear();
  buildUnifiedTurnContextBlockMock.mockClear();
  resolveTurnTimezoneContextMock.mockClear();
  formatTurnTimestampMock.mockClear();
  mockSlackChronologicalContext = null;
  loadSlackChronologicalContextMock.mockClear();
  getSlackCompactionWatermarkForPrefixMock.mockClear();
  deleteMessageByIdMock.mockClear();
  reserveMessageMock.mockClear();
  updateMessageContentMock.mockClear();
  indexMessageNowMock.mockClear();
  projectAssistantMessageMock.mockClear();
  publishSyncInvalidationMock.mockClear();
  mockMessageById = null;
  // Orchestrator pipelines (overflowReduce, persistence, …) run through the
  // plugin registry; reset and re-register every default so the pipelines
  // dispatch to middleware backed by the mocked collaborators these tests
  // install (`reduceContextOverflow`, `syncMessageToDisk`, etc.) instead of
  // hitting the bare terminals.
  resetPluginRegistryAndRegisterDefaults();
});

describe("session-agent-loop", () => {
  describe("timezone turn context", () => {
    test("passes ctx.clientTimezone and ui.detectedTimezone into timezone resolution", async () => {
      mockUiConfig = {
        userTimezone: "America/New_York",
        detectedTimezone: "America/Chicago",
      };
      const ctx = makeCtx({ clientTimezone: "America/Los_Angeles" });

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

      expect(resolveTurnTimezoneContextMock).toHaveBeenCalled();
      const timezoneOptions = resolveTurnTimezoneContextMock.mock.calls[0]?.[0];
      expect(timezoneOptions).toMatchObject({
        configuredUserTimeZone: "America/New_York",
        clientTimezone: "America/Los_Angeles",
        detectedTimezone: "America/Chicago",
      });
    });

    test("passes resolved canonical timezones into unified turn context", async () => {
      mockUiConfig = {
        userTimezone: "US/Eastern",
        detectedTimezone: "US/Central",
      };
      resolveTurnTimezoneContextMock.mockImplementationOnce(() => ({
        configuredUserTimezone: "America/New_York",
        clientTimezone: "America/Los_Angeles",
        detectedTimezone: "America/Chicago",
        hostTimezone: "America/Denver",
        effectiveTimezone: "America/New_York",
        source: "configuredUserTimezone",
      }));
      const ctx = makeCtx({ clientTimezone: "US/Pacific" });

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

      expect(formatTurnTimestampMock).toHaveBeenCalledWith({
        timeZone: "America/New_York",
      });
      expect(buildUnifiedTurnContextBlockMock).toHaveBeenCalled();
      const turnContextOptions =
        buildUnifiedTurnContextBlockMock.mock.calls[0]?.[0];
      expect(turnContextOptions).toMatchObject({
        configuredUserTimezone: "America/New_York",
        clientTimezone: "America/Los_Angeles",
        detectedTimezone: "America/Chicago",
      });
    });
  });

  describe("pre-flight checks", () => {
    test("throws if called without an abortController", async () => {
      const ctx = makeCtx();
      ctx.abortController = null;
      await expect(
        runAgentLoopImpl(ctx, "hello", "msg-1", () => {}),
      ).rejects.toThrow("runAgentLoop called without prior persistUserMessage");
    });
  });

  describe("proactive artifact trigger", () => {
    test("suppresses proactive app build when the foreground turn used app tools", async () => {
      mockConversationRow = {
        ...mockConversationRow,
        id: "test-conv",
        conversationType: "standard",
      };
      mockMessageById = {
        id: "user-msg-1",
        conversationId: "test-conv",
        createdAt: 1000,
      };
      mockHasProactiveArtifactCompleted = false;
      mockTryClaimProactiveArtifactTrigger = true;

      const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
        // Prime the assistant row anchor for LLM call 1 — production code
        // emits this from `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        await onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I'll build that app." }],
          },
        });
        await onEvent({
          type: "tool_use",
          id: "tool-1",
          name: "app_create",
          input: { name: "Flow" },
        });
        await onEvent({
          type: "tool_result",
          toolUseId: "tool-1",
          content: "{}",
          isError: false,
        });
        await options?.onCheckpoint?.({
          turnIndex: 0,
          toolCount: 1,
          hasToolUse: true,
          history: messages,
        });
        // Prime the anchor again for LLM call 2 — multi-call agent turns
        // reserve a fresh assistant row per LLM call.
        await onEvent({ type: "llm_call_started" });
        await onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Done." }],
          },
        ];
      };

      const ctx = makeCtx({
        conversationId: "test-conv",
        agentLoopRun,
      });
      await runAgentLoopImpl(
        ctx,
        "build a kanban app",
        "user-msg-1",
        () => {},
        {
          isUserMessage: true,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(runProactiveArtifactJobMock).toHaveBeenCalledTimes(1);
      expect(runProactiveArtifactJobMock.mock.calls[0]?.[0]).toMatchObject({
        conversationId: "test-conv",
        suppressAppBuild: true,
      });
    });
  });

  describe("disk pressure injection context", () => {
    test("passes cleanup context into runtime injections for cleanup-mode turns", async () => {
      mockDiskPressureDecision = {
        action: "allow-cleanup-mode",
        reason: "guardian",
      };
      mockConversationRow = {
        ...mockConversationRow,
        conversationType: "standard",
        source: "user",
      };
      const ctx = makeCtx({
        channelCapabilities: {
          channel: "telegram",
          dashboardCapable: false,
          supportsDynamicUi: false,
          supportsVoiceInput: false,
          chatType: "private",
        },
        trustContext: {
          sourceChannel: "telegram",
          trustClass: "guardian",
        } as AgentLoopConversationContext["trustContext"],
      });

      await runAgentLoopImpl(ctx, "free up space", "msg-1", () => {});

      expect(classifyDiskPressureTurnPolicyMock).toHaveBeenCalledWith(
        mockDiskPressureStatus,
        expect.objectContaining({
          callSite: "mainAgent",
          conversationSource: "user",
          conversationType: "standard",
          isInteractive: true,
          sourceChannel: "telegram",
          sourceInterface: "web",
          trustContext: {
            sourceChannel: "telegram",
            trustClass: "guardian",
          },
        }),
      );
      const firstInjectionOptions = applyRuntimeInjectionsMock.mock
        .calls[0]![1] as {
        diskPressureContext?: { cleanupModeActive: boolean } | null;
      };
      expect(firstInjectionOptions.diskPressureContext).toEqual({
        cleanupModeActive: true,
      });
    });

    test("passes cleanup context into runtime injections for local-owner turns", async () => {
      mockDiskPressureDecision = {
        action: "allow-cleanup-mode",
        reason: "local-owner",
      };
      const ctx = makeCtx();

      await runAgentLoopImpl(ctx, "free up space", "msg-1", () => {});

      expect(classifyDiskPressureTurnPolicyMock).toHaveBeenCalledWith(
        mockDiskPressureStatus,
        expect.objectContaining({
          sourceChannel: "vellum",
          sourceInterface: "web",
          trustContext: null,
        }),
      );
      const firstInjectionOptions = applyRuntimeInjectionsMock.mock
        .calls[0]![1] as {
        diskPressureContext?: { cleanupModeActive: boolean } | null;
      };
      expect(firstInjectionOptions.diskPressureContext).toEqual({
        cleanupModeActive: true,
      });
    });

    test("keeps cleanup context on overflow recovery reinjection", async () => {
      mockDiskPressureDecision = {
        action: "allow-cleanup-mode",
        reason: "guardian",
      };
      mockEstimateTokens = 96000;
      mockReducerStepFn = (msgs: Message[]) => ({
        messages: msgs,
        tier: "forced_compaction",
        state: {
          appliedTiers: ["forced_compaction"],
          injectionMode: "full",
          exhausted: true,
        },
        estimatedTokens: 50000,
      });
      const ctx = makeCtx({
        trustContext: {
          sourceChannel: "telegram",
          trustClass: "guardian",
        } as AgentLoopConversationContext["trustContext"],
      });

      await runAgentLoopImpl(ctx, "free up space", "msg-1", () => {});

      expect(applyRuntimeInjectionsMock.mock.calls.length).toBeGreaterThan(1);
      for (const call of applyRuntimeInjectionsMock.mock.calls) {
        const options = call[1] as {
          diskPressureContext?: { cleanupModeActive: boolean } | null;
        };
        expect(options.diskPressureContext).toEqual({
          cleanupModeActive: true,
        });
      }
    });

    test("blocks policy-denied turns before runtime injection or model execution", async () => {
      mockDiskPressureDecision = {
        action: "block",
        reason: "trusted-contact",
      };
      const events: ServerMessage[] = [];
      const agentLoopRun = mock(async (_messages: Message[]) => {
        throw new Error("agent loop should not run");
      });
      const activityStates: unknown[][] = [];
      const traceEvents: unknown[][] = [];
      const ctx = makeCtx({
        emitActivityState: (...args: unknown[]) => {
          activityStates.push(args);
        },
        traceEmitter: {
          emit: (...args: unknown[]) => {
            traceEvents.push(args);
          },
        } as unknown as AgentLoopConversationContext["traceEmitter"],
      });
      ctx.agentLoop.run = agentLoopRun as AgentLoopRun;

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(agentLoopRun).not.toHaveBeenCalled();
      expect(applyRuntimeInjectionsMock).not.toHaveBeenCalled();
      expect(activityStates).toContainEqual([
        "idle",
        "error_terminal",
        "global",
        "test-req",
      ]);
      expect(traceEvents[0]).toEqual([
        "request_error",
        expect.stringContaining("Storage is critically low"),
        expect.objectContaining({
          requestId: "test-req",
          status: "error",
          attributes: expect.objectContaining({
            errorCategory: "disk_pressure",
            errorCode: "DISK_SPACE_CRITICAL",
            diskPressureReason: "trusted-contact",
          }),
        }),
      ]);
      expect(events.find((event) => event.type === "error")).toMatchObject({
        type: "error",
        conversationId: "test-conv",
        requestId: "test-req",
        code: "DISK_SPACE_CRITICAL",
        category: "disk_pressure",
        message: expect.stringContaining("remote messages are ignored"),
      });
      expect(
        events.find((event) => event.type === "conversation_error"),
      ).toMatchObject({
        type: "conversation_error",
        conversationId: "test-conv",
        code: "DISK_SPACE_CRITICAL",
        retryable: true,
        errorCategory: "disk_pressure",
        userMessage: expect.stringContaining("remote messages are ignored"),
      });
    });

    test("blocked background turns clear processing state and drain the queue", async () => {
      mockDiskPressureDecision = {
        action: "block",
        reason: "background",
      };
      const drainQueue = mock(async (_reason: unknown) => {});
      const activityStates: unknown[][] = [];
      const ctx = makeCtx({
        drainQueue,
        emitActivityState: (...args: unknown[]) => {
          activityStates.push(args);
        },
      });

      await runAgentLoopImpl(ctx, "background task", "msg-1", () => {}, {
        callSite: "memoryConsolidation",
        isInteractive: false,
      });

      expect(applyRuntimeInjectionsMock).not.toHaveBeenCalled();
      expect(ctx.processing).toBe(false);
      expect(ctx.abortController).toBeNull();
      expect(ctx.currentRequestId).toBeUndefined();
      expect(drainQueue).toHaveBeenCalledWith("loop_complete");
      expect(activityStates).toContainEqual([
        "idle",
        "error_terminal",
        "global",
        "test-req",
      ]);
    });
  });

  describe("tool execution errors via agent loop", () => {
    test("error events from agent loop are classified and emitted", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        // Simulate tool_use + error during execution
        onEvent({
          type: "tool_use",
          id: "tu-1",
          name: "bash",
          input: { cmd: "ls" },
        });
        onEvent({
          type: "error",
          error: new Error("Tool execution failed: permission denied"),
        });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I encountered an error" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 50,
          model: "test-model",
          providerDurationMs: 200,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [
              { type: "text", text: "I encountered an error" },
            ] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "run ls", "msg-1", (msg) => events.push(msg));

      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeDefined();
    });

    test("non-error agent loop completion does not emit conversation_error", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "All good" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50,
          outputTokens: 25,
          model: "test-model",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "All good" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });
  });

  describe("LLM request log persistence", () => {
    test("record request log captures the actual provider name", async () => {
      const events: ServerMessage[] = [];
      const rawRequest = {
        model: "gpt-4.1",
        messages: [{ role: "user", content: "Hello" }],
      };
      const rawResponse = {
        model: "gpt-4.1-2026-03-01",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hi there.",
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
        },
      };

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi there." }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 12,
          outputTokens: 3,
          model: "gpt-4.1-2026-03-01",
          actualProvider: "fireworks",
          providerDurationMs: 45,
          rawRequest,
          rawResponse,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "Hi there." }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        provider: {
          name: "openrouter",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as AgentLoopConversationContext["provider"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(recordRequestLogMock).toHaveBeenCalledTimes(1);
      const call = recordRequestLogMock.mock.calls[0] as unknown as unknown[];
      expect(call[4]).toBe("fireworks");
    });

    test("record request log falls back to the runtime provider when no actual provider is supplied", async () => {
      const rawRequest = {
        model: "gpt-4.1",
        messages: [{ role: "user", content: "Hello" }],
      };
      const rawResponse = {
        model: "gpt-4.1-2026-03-01",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hi there.",
            },
          },
        ],
      };

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi there." }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 12,
          outputTokens: 3,
          model: "gpt-4.1-2026-03-01",
          providerDurationMs: 45,
          rawRequest,
          rawResponse,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "Hi there." }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        provider: {
          name: "openrouter",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as AgentLoopConversationContext["provider"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

      expect(recordRequestLogMock).toHaveBeenCalledTimes(1);
      const call = recordRequestLogMock.mock.calls[0] as unknown as [
        string,
        string,
        string,
        undefined,
        string,
      ];
      expect(call[4]).toBe("openrouter");
    });

    test("record request log handles Responses API shaped payloads", async () => {
      const events: ServerMessage[] = [];
      const rawRequest = {
        model: "gpt-5.4",
        instructions: "Be helpful.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Hello" }],
            type: "message",
          },
        ],
      };
      const rawResponse = {
        id: "resp_test",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hi there." }],
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
        status: "completed",
      };

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi there." }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 12,
          outputTokens: 3,
          model: "gpt-5.4",
          actualProvider: "openai",
          providerDurationMs: 45,
          rawRequest,
          rawResponse,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "Hi there." }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        provider: {
          name: "openai",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as AgentLoopConversationContext["provider"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(recordRequestLogMock).toHaveBeenCalledTimes(1);
      const call = recordRequestLogMock.mock.calls[0] as unknown as unknown[];
      expect(call[1]).toBe(JSON.stringify(rawRequest));
      expect(call[2]).toBe(JSON.stringify(rawResponse));
    });
  });

  describe("llm_call_started / llm_call_finished trace coherence", () => {
    // Regression: the started event was emitted by emitLlmCallStartedIfNeeded
    // using deps.ctx.provider.name (the default), while the finished event used
    // event.actualProvider. For routed calls (e.g. gpt-5.5 via openai from an
    // anthropic-default conversation) this caused started="anthropic" /
    // finished="openai". The fix passes providerName explicitly from handleUsage
    // so both events always agree, even when text_delta never fires (tool-only).

    test("started and finished use the same provider name for a streaming response", async () => {
      // In the real routing scenario, text_delta fires while
      // CallSiteRoutingProvider's AsyncLocalStorage context holds the active
      // transport name (covered by call-site-routing-provider.test.ts). Here we
      // verify the loop wiring: when text_delta fires before usage, the started
      // event reflects the provider that will also appear on finished.
      const traceEvents: Array<{
        label: string;
        attrs: Record<string, unknown>;
      }> = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({ type: "text_delta", text: "Hi." });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi." }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 10,
          outputTokens: 2,
          model: "gpt-5.5-2026-04-23",
          actualProvider: "openai",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "Hi." }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        // Provider name matches actualProvider so both paths agree.
        provider: {
          name: "openai",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as AgentLoopConversationContext["provider"],
        traceEmitter: {
          emit: (
            event: string,
            label: string,
            payload: { attributes?: Record<string, unknown> },
          ) => {
            if (event === "llm_call_started" || event === "llm_call_finished") {
              traceEvents.push({ label, attrs: payload.attributes ?? {} });
            }
          },
        } as unknown as AgentLoopConversationContext["traceEmitter"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

      const started = traceEvents.find(
        (e) =>
          e.label.startsWith("LLM call to") && !e.label.endsWith("finished"),
      );
      const finished = traceEvents.find((e) => e.label.endsWith("finished"));

      expect(started).toBeDefined();
      expect(finished).toBeDefined();
      expect(started!.attrs["provider"]).toBe("openai");
      expect(finished!.attrs["provider"]).toBe("openai");
    });

    test("started and finished use the same provider name for a tool-call-only response (no text_delta)", async () => {
      // This is the harder case: no text_delta fires, so emitLlmCallStartedIfNeeded
      // fires as a fallback inside handleUsage *after* the AsyncLocalStorage
      // context in CallSiteRoutingProvider has already exited. Without passing
      // providerName explicitly it would say "anthropic".
      const traceEvents: Array<{
        label: string;
        attrs: Record<string, unknown>;
      }> = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        // No text_delta — pure tool-call response
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 10,
          outputTokens: 2,
          model: "gpt-5.5-2026-04-23",
          actualProvider: "openai",
          providerDurationMs: 100,
        });
        return messages;
      };

      const ctx = makeCtx({
        agentLoopRun,
        provider: {
          name: "anthropic",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as AgentLoopConversationContext["provider"],
        traceEmitter: {
          emit: (
            event: string,
            label: string,
            payload: { attributes?: Record<string, unknown> },
          ) => {
            if (event === "llm_call_started" || event === "llm_call_finished") {
              traceEvents.push({ label, attrs: payload.attributes ?? {} });
            }
          },
        } as unknown as AgentLoopConversationContext["traceEmitter"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

      const started = traceEvents.find(
        (e) =>
          e.label.startsWith("LLM call to") && !e.label.endsWith("finished"),
      );
      const finished = traceEvents.find((e) => e.label.endsWith("finished"));

      expect(started).toBeDefined();
      expect(finished).toBeDefined();
      expect(started!.attrs["provider"]).toBe("openai");
      expect(finished!.attrs["provider"]).toBe("openai");
    });
  });

  describe("usage accounting", () => {
    test("records the actual provider for usage accounting", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi there." }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 12,
          outputTokens: 3,
          model: "gpt-4.1-2026-03-01",
          actualProvider: "fireworks",
          providerDurationMs: 45,
          rawRequest: {
            model: "gpt-4.1",
            messages: [{ role: "user", content: "Hello" }],
          },
          rawResponse: {
            model: "gpt-4.1-2026-03-01",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Hi there.",
                },
              },
            ],
          },
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "Hi there." }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        provider: {
          name: "openrouter",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as AgentLoopConversationContext["provider"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const mainAgentCall = recordUsageMock.mock.calls.find(
        (call) => (call as unknown[])[5] === "main_agent",
      ) as unknown[] | undefined;

      expect(mainAgentCall).toBeDefined();
      expect(mainAgentCall?.[0]).toMatchObject({
        conversationId: "test-conv",
        providerName: "fireworks",
      });
      expect(mainAgentCall?.[1]).toBe(12);
      expect(mainAgentCall?.[2]).toBe(3);
      expect(mainAgentCall?.[3]).toBe("gpt-4.1-2026-03-01");
    });
  });

  describe("context window exhaustion (context-too-large recovery)", () => {
    test("forwards cache-aware compaction usage to recordUsage", async () => {
      const events: ServerMessage[] = [];
      mockEstimateTokens = 120_000;

      mockReducerStepFn = (msgs: Message[]) => ({
        messages: msgs,
        tier: "forced_compaction",
        state: {
          appliedTiers: ["forced_compaction"],
          injectionMode: "full",
          exhausted: false,
        },
        estimatedTokens: 5_000,
        compactionResult: {
          compacted: true,
          messages: msgs,
          compactedPersistedMessages: 5,
          summaryText: "Summary of prior conversation",
          previousEstimatedInputTokens: 90_000,
          estimatedInputTokens: 30_000,
          maxInputTokens: 100_000,
          thresholdTokens: 80_000,
          compactedMessages: 10,
          summaryCalls: 2,
          summaryInputTokens: 500,
          summaryOutputTokens: 200,
          summaryModel: "claude-opus-4-6",
          summaryCacheCreationInputTokens: 120,
          summaryCacheReadInputTokens: 340,
          summaryRawResponses: [
            {
              usage: {
                cache_creation: { ephemeral_5m_input_tokens: 120 },
                cache_read_input_tokens: 340,
              },
            },
          ],
        },
      });

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered" }],
          },
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "recovered" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const compactorCall = recordUsageMock.mock.calls.find(
        (call) => (call as unknown[])[5] === "context_compactor",
      ) as unknown[] | undefined;
      expect(compactorCall).toBeDefined();

      const [
        usageCtx,
        inputTokens,
        outputTokens,
        model,
        _onEvent,
        actor,
        reqId,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        rawResponse,
      ] = compactorCall ?? [];

      expect(usageCtx).toMatchObject({ conversationId: "test-conv" });
      expect(inputTokens).toBe(500);
      expect(outputTokens).toBe(200);
      expect(model).toBe("claude-opus-4-6");
      expect(actor).toBe("context_compactor");
      expect(reqId).toBe("test-req");
      expect(cacheCreationInputTokens).toBe(120);
      expect(cacheReadInputTokens).toBe(340);
      expect(rawResponse).toEqual({
        usage: {
          cache_creation: { ephemeral_5m_input_tokens: 120 },
          cache_read_input_tokens: 340,
        },
      });
    });

    test("convergence loop applies reducer and retries when context-too-large is detected", async () => {
      const events: ServerMessage[] = [];
      let callCount = 0;
      let reducerCalled = false;

      // Configure reducer to succeed on first call — return reduced messages
      // with a compaction result to trigger the context_compacted event.
      mockReducerStepFn = (msgs: Message[]) => {
        reducerCalled = true;
        return {
          messages: msgs,
          tier: "forced_compaction",
          state: {
            appliedTiers: ["forced_compaction"],
            injectionMode: "full",
            exhausted: false,
          },
          estimatedTokens: 30000,
          compactionResult: {
            compacted: true,
            messages: msgs,
            compactedPersistedMessages: 5,
            summaryText: "Summary of prior conversation",
            previousEstimatedInputTokens: 90000,
            estimatedInputTokens: 30000,
            maxInputTokens: 100000,
            thresholdTokens: 80000,
            compactedMessages: 10,
            summaryCalls: 1,
            summaryInputTokens: 500,
            summaryOutputTokens: 200,
            summaryModel: "mock-model",
          },
        };
      };

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`. Retry branches
        // need this on every invocation: each agent-loop iteration reserves
        // its own row.
        await onEvent({ type: "llm_call_started" });
        callCount++;
        if (callCount === 1) {
          onEvent({
            type: "error",
            error: new Error("context_length_exceeded"),
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 50,
          });
          return messages;
        }
        // Second call (after reducer): succeed
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50,
          outputTokens: 25,
          model: "test-model",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "recovered" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(reducerCalled).toBe(true);
      expect(callCount).toBe(2);
      const compactEvent = events.find((e) => e.type === "context_compacted");
      expect(compactEvent).toBeDefined();
    });

    test("emits conversation_error when context stays too large after all recovery attempts", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        onEvent({
          type: "error",
          error: new Error("context_length_exceeded"),
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 0,
          model: "test-model",
          providerDurationMs: 50,
        });
        return messages;
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          // Compaction succeeds but context is still too large
          maybeCompact: async () => ({
            compacted: true,
            messages: [
              { role: "user", content: [{ type: "text", text: "Hello" }] },
            ] as Message[],
            compactedPersistedMessages: 5,
            summaryText: "Summary",
            previousEstimatedInputTokens: 90000,
            estimatedInputTokens: 85000,
            maxInputTokens: 100000,
            thresholdTokens: 80000,
            compactedMessages: 2,
            summaryCalls: 1,
            summaryInputTokens: 500,
            summaryOutputTokens: 200,
            summaryModel: "mock-model",
          }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeDefined();
    });

    test("bounded convergence loop applies reducer tiers and recovers", async () => {
      const events: ServerMessage[] = [];
      let callCount = 0;
      let reducerCalls = 0;

      // Reducer: succeed on first call, returning reduced messages
      mockReducerStepFn = (msgs: Message[]) => {
        reducerCalls++;
        return {
          messages: msgs,
          tier: "forced_compaction",
          state: {
            appliedTiers: ["forced_compaction"],
            injectionMode: "full",
            exhausted: false,
          },
          estimatedTokens: 5000,
        };
      };

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`. Retry branches
        // need this on every invocation: each agent-loop iteration reserves
        // its own row.
        await onEvent({ type: "llm_call_started" });
        callCount++;
        if (callCount === 1) {
          onEvent({
            type: "error",
            error: new Error("context_length_exceeded"),
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 50,
          });
          return messages;
        }
        // After reducer runs, succeed
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered via convergence" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50,
          outputTokens: 25,
          model: "test-model",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [
              { type: "text", text: "recovered via convergence" },
            ] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(reducerCalls).toBeGreaterThanOrEqual(1);
      expect(callCount).toBe(2);
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });

    test("non-interactive auto-compress continues without approval prompt", async () => {
      const events: ServerMessage[] = [];
      let callCount = 0;

      // Reducer exhausts all tiers
      mockReducerStepFn = (msgs: Message[]) => ({
        messages: msgs,
        tier: "injection_downgrade",
        state: {
          appliedTiers: [
            "forced_compaction",
            "tool_result_truncation",
            "media_stubbing",
            "injection_downgrade",
          ],
          injectionMode: "minimal",
          exhausted: true,
        },
        estimatedTokens: 120000,
      });

      mockOverflowAction = "auto_compress_latest_turn";

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`. Retry branches
        // need this on every invocation: each agent-loop iteration reserves
        // its own row.
        await onEvent({ type: "llm_call_started" });
        callCount++;
        if (callCount <= 2) {
          onEvent({
            type: "error",
            error: new Error("context_length_exceeded"),
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 50,
          });
          return messages;
        }
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "auto-recovered" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50,
          outputTokens: 25,
          model: "test-model",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [
              { type: "text", text: "auto-recovered" },
            ] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        hasNoClient: true,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({
            compacted: true,
            messages: [
              { role: "user", content: [{ type: "text", text: "Hello" }] },
            ] as Message[],
            compactedPersistedMessages: 3,
            summaryText: "Compressed summary",
            previousEstimatedInputTokens: 120000,
            estimatedInputTokens: 30000,
            maxInputTokens: 100000,
            thresholdTokens: 80000,
            compactedMessages: 5,
            summaryCalls: 1,
            summaryInputTokens: 300,
            summaryOutputTokens: 100,
            summaryModel: "mock-model",
          }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // Should not produce conversation_error since auto-compress recovered
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });

    test("emits budget_yield_unrecovered when auto_compress rerun yields at mid-loop budget", async () => {
      // Regression test for the silent-stall failure mode:
      // when every recovery layer has been applied (tier reducer
      // exhausted + auto_compress_latest_turn emergency compaction)
      // and the final `agentLoop.run` STILL yields at the mid-loop
      // budget checkpoint, the orchestrator used to fall through to
      // post-turn cleanup with NO `agent_loop_exit_reason` emitted —
      // the turn just stopped mid-action and `llm_request_logs` showed
      // a NULL exit reason on the final row. We now emit
      // `budget_yield_unrecovered` so the inspector and dashboards can
      // attribute the silent stall.
      const events: ServerMessage[] = [];
      let callCount = 0;

      // Reducer exhausts all 4 tiers on first call so the convergence
      // loop runs exactly one iteration before falling through to
      // the auto_compress_latest_turn branch.
      mockReducerStepFn = (msgs: Message[]) => ({
        messages: msgs,
        tier: "injection_downgrade",
        state: {
          appliedTiers: [
            "forced_compaction",
            "tool_result_truncation",
            "media_stubbing",
            "injection_downgrade",
          ],
          injectionMode: "minimal",
          exhausted: true,
        },
        estimatedTokens: 120_000,
      });

      mockOverflowAction = "auto_compress_latest_turn";

      // Sits between the preflight budget (preflightBudget =
      // 100k * 0.95 = 95k — anything above triggers preflight reducer
      // *before* we get to the convergence/auto_compress path under
      // test) and the mid-loop threshold (preflightBudget * 0.85 =
      // ≈80.75k — anything above flips yieldedForBudget on a checkpoint
      // call). 90k satisfies both so the path reaches call 3.
      mockEstimateTokens = 90_000;

      const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
        callCount++;
        if (callCount <= 2) {
          // Calls 1 (initial) and 2 (convergence rerun): error so
          // `state.contextTooLargeDetected` stays true through
          // convergence exit and we enter the auto_compress branch.
          onEvent({
            type: "error",
            error: new Error("context_length_exceeded"),
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 50,
          });
          return messages;
        }
        // Call 3: the auto_compress_latest_turn rerun. Invoke
        // onCheckpoint so the orchestrator's mid-loop budget check
        // flips `yieldedForBudget` to true, then return without
        // finishing — mirroring what AgentLoop.run does when its
        // checkpoint returns "yield".
        if (options?.onCheckpoint) {
          await options.onCheckpoint({
            turnIndex: 0,
            toolCount: 1,
            hasToolUse: true,
            history: messages,
          });
        }
        return messages;
      };

      const ctx = makeCtx({
        agentLoopRun,
        hasNoClient: true,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({
            compacted: true,
            messages: [
              { role: "user", content: [{ type: "text", text: "Hello" }] },
            ] as Message[],
            compactedPersistedMessages: 3,
            summaryText: "Compressed summary",
            previousEstimatedInputTokens: 120000,
            estimatedInputTokens: 30000,
            maxInputTokens: 100000,
            thresholdTokens: 80000,
            compactedMessages: 5,
            summaryCalls: 1,
            summaryInputTokens: 300,
            summaryOutputTokens: 100,
            summaryModel: "mock-model",
          }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // Observability emit: exit reason was stamped onto the latest
      // llm_request_logs row.
      expect(setAgentLoopExitReasonOnLatestLogMock).toHaveBeenCalledWith(
        "test-conv",
        "budget_yield_unrecovered",
      );

      // We did NOT also emit context_too_large — the auto_compress
      // branch resets `contextTooLargeDetected` before its rerun and
      // the rerun's yield-for-budget keeps it false, so the error
      // branch above stays skipped.
      expect(setAgentLoopExitReasonOnLatestLogMock).not.toHaveBeenCalledWith(
        "test-conv",
        "context_too_large",
      );

      // User-facing emit: the classified BUDGET_YIELD_UNRECOVERED
      // error is sent to the client so the UI can render a notice
      // instead of leaving the turn looking like a silent ghost. The
      // assistant-side notice persistence is exercised in the overflow
      // suite (`conversation-agent-loop-overflow.test.ts`); this test
      // owns the observability + emit contract.
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeDefined();
      if (conversationError && "code" in conversationError) {
        expect(conversationError.code).toBe("BUDGET_YIELD_UNRECOVERED");
        expect(conversationError.retryable).toBe(true);
        expect(conversationError.errorCategory).toBe(
          "budget_yield_unrecovered",
        );
      } else {
        throw new Error("conversation_error missing `code` field");
      }
    });

    test("recovery loop is bounded by maxAttempts", async () => {
      const events: ServerMessage[] = [];
      let reducerCalls = 0;

      // Reducer never exhausts — always returns non-exhausted state
      // but context always stays too large
      mockReducerStepFn = (msgs: Message[]) => {
        reducerCalls++;
        return {
          messages: msgs,
          tier: "forced_compaction",
          state: {
            appliedTiers: ["forced_compaction"],
            injectionMode: "full",
            exhausted: false,
          },
          estimatedTokens: 120000,
        };
      };

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        onEvent({
          type: "error",
          error: new Error("context_length_exceeded"),
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 0,
          model: "test-model",
          providerDurationMs: 50,
        });
        return messages;
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // maxAttempts is 3 — reducer should be called at most 3 times
      expect(reducerCalls).toBeLessThanOrEqual(3);
    });

    test("preflight budget evaluation invokes reducer before provider call", async () => {
      const events: ServerMessage[] = [];
      let reducerCalls = 0;
      let agentLoopCalls = 0;

      // Set token estimate above budget (100000 * 0.95 = 95000)
      mockEstimateTokens = 96000;

      mockReducerStepFn = (msgs: Message[]) => {
        reducerCalls++;
        return {
          messages: msgs,
          tier: "forced_compaction",
          state: {
            appliedTiers: ["forced_compaction"],
            injectionMode: "full",
            exhausted: true,
          },
          estimatedTokens: 50000,
        };
      };

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        agentLoopCalls++;
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50,
          outputTokens: 25,
          model: "test-model",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "ok" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // Reducer should have been called during preflight
      expect(reducerCalls).toBeGreaterThanOrEqual(1);
      // Agent loop should still succeed
      expect(agentLoopCalls).toBe(1);
      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });
  });

  describe("provider ordering error retry", () => {
    test("retries with deep repair when ordering error is detected", async () => {
      const events: ServerMessage[] = [];
      let callCount = 0;

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`. Retry branches
        // need this on every invocation: each agent-loop iteration reserves
        // its own row.
        await onEvent({ type: "llm_call_started" });
        callCount++;
        if (callCount === 1) {
          onEvent({
            type: "error",
            error: new Error("messages ordering error"),
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 50,
          });
          return messages;
        }
        // Retry succeeds
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fixed" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50,
          outputTokens: 25,
          model: "test-model",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "fixed" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(callCount).toBe(2);
    });

    test("emits deferred ordering error when retry also fails", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        onEvent({
          type: "error",
          error: new Error("messages ordering error"),
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 0,
          model: "test-model",
          providerDurationMs: 50,
        });
        return messages;
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeDefined();
    });
  });

  describe("checkpoint handoff (infinite loop prevention)", () => {
    test("yields at checkpoint when canHandoffAtCheckpoint returns true", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`. Retry branches
        // need this on every invocation: each agent-loop iteration reserves
        // its own row.
        await onEvent({ type: "llm_call_started" });
        // Simulate tool use followed by checkpoint
        onEvent({ type: "tool_use", id: "tu-1", name: "file_read", input: {} });
        onEvent({
          type: "tool_result",
          toolUseId: "tu-1",
          content: "file content",
          isError: false,
        });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 50,
          model: "test-model",
          providerDurationMs: 100,
        });
        if (options?.onCheckpoint) {
          const decision = await options.onCheckpoint({
            turnIndex: 0,
            toolCount: 1,
            hasToolUse: true,
            history: messages,
          });
          if (decision === "yield") {
            return [
              ...messages,
              {
                role: "assistant" as const,
                content: [{ type: "text", text: "partial" }] as ContentBlock[],
              },
            ];
          }
        }
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "partial" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        canHandoffAtCheckpoint: () => true,
      } as unknown as Partial<AgentLoopConversationContext>);

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const handoff = events.find((e) => e.type === "generation_handoff");
      expect(handoff).toBeDefined();
      expect(setAgentLoopExitReasonOnLatestLogMock).toHaveBeenCalledWith(
        "test-conv",
        "checkpoint_handoff",
      );
    });

    test("continues when canHandoffAtCheckpoint returns false", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`. Retry branches
        // need this on every invocation: each agent-loop iteration reserves
        // its own row.
        await onEvent({ type: "llm_call_started" });
        onEvent({ type: "tool_use", id: "tu-1", name: "file_read", input: {} });
        onEvent({
          type: "tool_result",
          toolUseId: "tu-1",
          content: "content",
          isError: false,
        });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 50,
          model: "test-model",
          providerDurationMs: 100,
        });
        if (options?.onCheckpoint) {
          await options.onCheckpoint({
            turnIndex: 0,
            toolCount: 1,
            hasToolUse: true,
            history: messages,
          });
        }
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "done" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        canHandoffAtCheckpoint: () => false,
      } as unknown as Partial<AgentLoopConversationContext>);

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const handoff = events.find((e) => e.type === "generation_handoff");
      expect(handoff).toBeUndefined();
      expect(setAgentLoopExitReasonOnLatestLogMock).not.toHaveBeenCalledWith(
        "test-conv",
        "checkpoint_handoff",
      );
      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });
  });

  describe("user cancellation", () => {
    test("emits generation_cancelled when abort signal fires", async () => {
      const events: ServerMessage[] = [];
      const abortController = new AbortController();

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 50,
          model: "test-model",
          providerDurationMs: 100,
        });
        // Simulate abort after processing
        abortController.abort();
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "partial" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun, abortController });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const cancelled = events.find((e) => e.type === "generation_cancelled");
      expect(cancelled).toBeDefined();
    });

    test("handles AbortError thrown from agent loop as user cancellation", async () => {
      const events: ServerMessage[] = [];
      const abortController = new AbortController();

      const agentLoopRun: AgentLoopRun = async () => {
        abortController.abort();
        const err = new DOMException("The operation was aborted", "AbortError");
        throw err;
      };

      const ctx = makeCtx({ agentLoopRun, abortController });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const cancelled = events.find((e) => e.type === "generation_cancelled");
      expect(cancelled).toBeDefined();
      // Should NOT emit a conversation_error for user cancellation
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
    });

    test("skips resolveAssistantAttachments when cancelled", async () => {
      const events: ServerMessage[] = [];
      const abortController = new AbortController();
      resolveAssistantAttachmentsMock.mockClear();

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 50,
          model: "test-model",
          providerDurationMs: 100,
        });
        // Simulate abort after processing
        abortController.abort();
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "partial" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun, abortController });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const cancelled = events.find((e) => e.type === "generation_cancelled");
      expect(cancelled).toBeDefined();
      // resolveAssistantAttachments should NOT have been called
      expect(resolveAssistantAttachmentsMock).not.toHaveBeenCalled();
    });
  });

  describe("finally block cleanup", () => {
    test("increments turnCount after successful run", async () => {
      const ctx = makeCtx({
        agentLoopRun: async (messages, onEvent) => {
          // Prime the assistant row anchor — production code emits this from
          // `AgentLoop.run` just before `provider.sendMessage`.
          await onEvent({ type: "llm_call_started" });
          onEvent({
            type: "message_complete",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          });
          onEvent({
            type: "usage",
            inputTokens: 10,
            outputTokens: 5,
            model: "test",
            providerDurationMs: 50,
          });
          return [
            ...messages,
            {
              role: "assistant" as const,
              content: [{ type: "text", text: "hi" }] as ContentBlock[],
            },
          ];
        },
      });
      expect(ctx.turnCount).toBe(0);

      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      expect(ctx.turnCount).toBe(1);
    });

    test("clears processing state and abort controller", async () => {
      const ctx = makeCtx({
        agentLoopRun: async (messages, onEvent) => {
          // Prime the assistant row anchor — production code emits this from
          // `AgentLoop.run` just before `provider.sendMessage`.
          await onEvent({ type: "llm_call_started" });
          onEvent({
            type: "message_complete",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          });
          onEvent({
            type: "usage",
            inputTokens: 10,
            outputTokens: 5,
            model: "test",
            providerDurationMs: 50,
          });
          return [
            ...messages,
            {
              role: "assistant" as const,
              content: [{ type: "text", text: "hi" }] as ContentBlock[],
            },
          ];
        },
      });

      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      expect(ctx.processing).toBe(false);
      expect(ctx.abortController).toBeNull();
      expect(ctx.currentRequestId).toBeUndefined();
      expect(ctx.commandIntent).toBeUndefined();
    });

    test("clears state even when agent loop throws", async () => {
      const events: ServerMessage[] = [];
      const ctx = makeCtx({
        agentLoopRun: async () => {
          throw new Error("unexpected crash");
        },
      });

      await runAgentLoopImpl(ctx, "hi", "msg-1", (msg) => events.push(msg));

      expect(ctx.processing).toBe(false);
      expect(ctx.abortController).toBeNull();
      expect(events.find((event) => event.type === "error")).toMatchObject({
        type: "error",
        code: "CONVERSATION_PROCESSING_FAILED",
        errorCategory: "processing_failed",
      });
      expect(
        events.find((event) => event.type === "conversation_error"),
      ).toMatchObject({
        type: "conversation_error",
        code: "CONVERSATION_PROCESSING_FAILED",
        errorCategory: "processing_failed",
      });
    });

    test("drains queue after completion", async () => {
      let drainReason: string | undefined;
      const ctx = makeCtx({
        agentLoopRun: async (
          messages: Message[],
          onEvent: (event: AgentEvent) => void | Promise<void>,
        ) => {
          // Prime the assistant row anchor — production code emits this from
          // `AgentLoop.run` just before `provider.sendMessage`. Must be
          // awaited so the assistant row is reserved before message_complete
          // tries to write into it.
          await onEvent({ type: "llm_call_started" });
          onEvent({
            type: "message_complete",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          });
          onEvent({
            type: "usage",
            inputTokens: 10,
            outputTokens: 5,
            model: "test",
            providerDurationMs: 50,
          });
          return [
            ...messages,
            {
              role: "assistant" as const,
              content: [{ type: "text", text: "ok" }] as ContentBlock[],
            },
          ];
        },
        drainQueue: (reason: string) => {
          drainReason = reason;
        },
      } as unknown as Partial<AgentLoopConversationContext>);

      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      expect(drainReason).toBe("loop_complete");
    });
  });

  describe("stale pending surface cleanup", () => {
    test("auto-completes non-dynamic_page pending surfaces on regular user message", async () => {
      const events: ServerMessage[] = [];

      const ctx = makeCtx();
      // Pre-populate a stale pending table surface
      ctx.pendingSurfaceActions.set("stale-table-1", { surfaceType: "table" });
      ctx.pendingSurfaceActions.set("stale-form-1", { surfaceType: "form" });
      // dynamic_page should be preserved
      ctx.pendingSurfaceActions.set("page-1", { surfaceType: "dynamic_page" });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg), {
        isUserMessage: true,
      });

      // The stale table and form surfaces should have been auto-completed
      const completeEvents = events.filter(
        (e) => e.type === "ui_surface_complete",
      );
      expect(completeEvents).toHaveLength(2);
      for (const evt of completeEvents) {
        const typed = evt as { surfaceId: string; summary: string };
        expect(typed.summary).toBe("Dismissed");
        expect(["stale-table-1", "stale-form-1"]).toContain(typed.surfaceId);
      }

      // dynamic_page should still be pending
      expect(ctx.pendingSurfaceActions.has("page-1")).toBe(true);
      expect(ctx.pendingSurfaceActions.has("stale-table-1")).toBe(false);
      expect(ctx.pendingSurfaceActions.has("stale-form-1")).toBe(false);
    });

    test("does not auto-complete surfaces when request is a surface action", async () => {
      const events: ServerMessage[] = [];

      const ctx = makeCtx();
      ctx.pendingSurfaceActions.set("active-table-1", { surfaceType: "table" });
      // Mark the request ID as a surface action response
      ctx.currentRequestId = "surface-action-req";
      ctx.surfaceActionRequestIds.add("surface-action-req");

      await runAgentLoopImpl(
        ctx,
        "[User action on table surface]",
        "msg-1",
        (msg) => events.push(msg),
        { isUserMessage: true },
      );

      // No ui_surface_complete should have been emitted
      const completeEvents = events.filter(
        (e) => e.type === "ui_surface_complete",
      );
      expect(completeEvents).toHaveLength(0);
      // The pending surface should still be there
      expect(ctx.pendingSurfaceActions.has("active-table-1")).toBe(true);
    });

    test("no-op when no pending surfaces exist", async () => {
      const events: ServerMessage[] = [];

      const ctx = makeCtx();
      // No pending surfaces

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg), {
        isUserMessage: true,
      });

      const completeEvents = events.filter(
        (e) => e.type === "ui_surface_complete",
      );
      expect(completeEvents).toHaveLength(0);
    });

    test("does not auto-complete surfaces for internal/subagent turns (no isUserMessage)", async () => {
      const events: ServerMessage[] = [];

      const ctx = makeCtx();
      ctx.pendingSurfaceActions.set("active-table-1", { surfaceType: "table" });
      ctx.pendingSurfaceActions.set("active-form-1", { surfaceType: "form" });

      // Internal turn: no isUserMessage option
      await runAgentLoopImpl(ctx, "subagent notification", "msg-1", (msg) =>
        events.push(msg),
      );

      // No ui_surface_complete should have been emitted
      const completeEvents = events.filter(
        (e) => e.type === "ui_surface_complete",
      );
      expect(completeEvents).toHaveLength(0);
      // Pending surfaces should still be there
      expect(ctx.pendingSurfaceActions.has("active-table-1")).toBe(true);
      expect(ctx.pendingSurfaceActions.has("active-form-1")).toBe(true);
    });

    test("finally block still runs if onEvent throws during stale surface dismissal", async () => {
      let _eventCount = 0;
      const ctx = makeCtx();
      ctx.pendingSurfaceActions.set("stale-table-1", { surfaceType: "table" });

      const throwingOnEvent = (msg: ServerMessage) => {
        _eventCount++;
        if (msg.type === "ui_surface_complete") {
          throw new Error("onEvent sink failed");
        }
      };

      // The error from onEvent should be caught by the try/catch,
      // and the finally block should still clean up session state
      await runAgentLoopImpl(ctx, "hello", "msg-1", throwingOnEvent, {
        isUserMessage: true,
      });

      expect(ctx.processing).toBe(false);
      expect(ctx.abortController).toBeNull();
      expect(ctx.currentRequestId).toBeUndefined();
    });
  });

  describe("turnContextBlock metadata persistence", () => {
    test("persists turnContextBlock when unifiedTurnContext is captured", async () => {
      const turnContext = "<turn_context>\nctx payload\n</turn_context>";
      mockInjectionBlocks = { unifiedTurnContext: turnContext };

      const ctx = makeCtx();
      await runAgentLoopImpl(ctx, "hello", "user-msg-123", () => {});

      const turnContextCalls = updateMessageMetadataMock.mock.calls.filter(
        (call) => {
          const payload = call[1] as Record<string, unknown>;
          return (
            payload != null &&
            Object.prototype.hasOwnProperty.call(payload, "turnContextBlock")
          );
        },
      );
      expect(turnContextCalls).toHaveLength(1);
      expect(turnContextCalls[0]![0]).toBe("user-msg-123");
      expect(turnContextCalls[0]![1]).toEqual({
        turnContextBlock: turnContext,
      });
    });

    test("skips persistence when unifiedTurnContext is not captured", async () => {
      mockInjectionBlocks = {};

      const ctx = makeCtx();
      await runAgentLoopImpl(ctx, "hello", "user-msg-456", () => {});

      const turnContextCalls = updateMessageMetadataMock.mock.calls.filter(
        (call) => {
          const payload = call[1] as Record<string, unknown>;
          return (
            payload != null &&
            Object.prototype.hasOwnProperty.call(payload, "turnContextBlock")
          );
        },
      );
      expect(turnContextCalls).toHaveLength(0);
    });

    test("only persists at first call site, even when overflow re-entry fires", async () => {
      const turnContext = "<turn_context>\nctx\n</turn_context>";
      mockInjectionBlocks = { unifiedTurnContext: turnContext };

      // Force preflight overflow path so applyRuntimeInjections is called
      // again inside the overflow-recovery re-entry loop.
      mockEstimateTokens = 96000;
      mockReducerStepFn = (msgs: Message[]) => ({
        messages: msgs,
        tier: "forced_compaction",
        state: {
          appliedTiers: ["forced_compaction"],
          injectionMode: "full",
          exhausted: true,
        },
        estimatedTokens: 50000,
      });

      const ctx = makeCtx();
      await runAgentLoopImpl(ctx, "hello", "user-msg-789", () => {});

      // Sanity check: overflow re-entry did fire (call count > 1).
      expect(applyRuntimeInjectionsMock.mock.calls.length).toBeGreaterThan(1);

      const turnContextCalls = updateMessageMetadataMock.mock.calls.filter(
        (call) => {
          const payload = call[1] as Record<string, unknown>;
          return (
            payload != null &&
            Object.prototype.hasOwnProperty.call(payload, "turnContextBlock")
          );
        },
      );
      expect(turnContextCalls).toHaveLength(1);
      expect(turnContextCalls[0]![0]).toBe("user-msg-789");
    });

    test("non-fatal when updateMessageMetadata throws", async () => {
      mockInjectionBlocks = {
        unifiedTurnContext: "<turn_context>x</turn_context>",
      };
      updateMessageMetadataMock.mockImplementation(() => {
        throw new Error("simulated DB failure");
      });

      const events: ServerMessage[] = [];
      const ctx = makeCtx();

      // Should not throw; agent loop continues and emits message_complete.
      await runAgentLoopImpl(ctx, "hello", "user-msg-err", (msg) =>
        events.push(msg),
      );

      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });
  });

  describe("error-only response with no assistant text", () => {
    test("synthesizes error assistant message when provider returns no response", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Emit a non-ordering, non-context-too-large error that sets providerErrorUserMessage
        onEvent({
          type: "error",
          error: new Error("Internal processing failure"),
        });
        onEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 0,
          model: "test-model",
          providerDurationMs: 50,
        });
        // Return same messages (no assistant message appended)
        return messages;
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // The error should be sent as a conversation_error (not as an
      // assistant_text_delta, which would cause duplicate text rendering
      // alongside the InlineChatErrorAlert card).
      const textDeltas = events.filter(
        (e) => e.type === "assistant_text_delta",
      );
      expect(textDeltas).toHaveLength(0);

      const conversationErrors = events.filter(
        (e) => e.type === "conversation_error",
      );
      expect(conversationErrors.length).toBeGreaterThanOrEqual(1);
    });

    test("pipes synthetic assistant message id into provider-error log rows via backfill", async () => {
      // Codex P1 regression test: the provider-failure turn must not leave
      // its `llm_request_logs` row orphaned. Without the backfill call in
      // the synthetic-message branch, a later turn's `handleMessageComplete`
      // sweep would wrong-attach this row to the wrong assistant message.
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // 1) handleProviderError -> writes an `llm_request_logs` row with
        //    messageId=null (the orphan we are trying to link).
        onEvent({
          type: "provider_error",
          error: new Error("upstream 500"),
          rawRequest: { model: "gpt-4.1", messages: [] },
          actualProvider: "openai",
        });
        // 2) handleError -> sets `state.providerErrorUserMessage`, which
        //    activates the synthetic-message branch below the loop.
        onEvent({
          type: "error",
          error: new Error("upstream 500"),
        });
        // Provider returned no assistant content — same messages back.
        return messages;
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // The orphan was written with messageId=undefined.
      expect(recordRequestLogMock).toHaveBeenCalledTimes(1);
      const recordCall = recordRequestLogMock.mock.calls[0] as unknown as [
        string,
        string,
        string,
        string | undefined,
        string | undefined,
      ];
      expect(recordCall[0]).toBe("test-conv");
      expect(recordCall[3]).toBeUndefined();

      // The synthetic-message branch then piped the assigned message id
      // (from the mocked `addMessage` -> `{ id: "mock-msg-id" }`) into the
      // backfill primitive, scoped to this conversation.
      expect(backfillMessageIdOnLogsMock).toHaveBeenCalledTimes(1);
      const backfillCall = backfillMessageIdOnLogsMock.mock
        .calls[0] as unknown as [string, string];
      expect(backfillCall[0]).toBe("test-conv");
      expect(backfillCall[1]).toBe("mock-msg-id");
    });
  });

  describe("B3 pre-allocation: indexing + cleanup", () => {
    test("handleMessageComplete indexes and projects the finalized assistant row", async () => {
      // The pre-B3 path inserted assistant rows via `addMessage`, which ran
      // the memory indexer and the conversation-attention projector as
      // side-effects of the insert. B3 splits the write into
      // `reserveMessage` + `updateMessageContent`, both of which are CRUD-only,
      // so the indexing + projection calls had to be re-driven explicitly
      // after `updateContent` succeeds. Codex P1 caught a regression where
      // this path was missing entirely; this test pins it down.
      mockMessageById = {
        id: "msg-reserve",
        conversationId: "test-conv",
        createdAt: 1234567,
        role: "assistant",
        content: "[]",
        metadata: null,
      };
      // Force attention projection to report a state change so we also
      // observe the sync-invalidation publish path on the same turn.
      projectAssistantMessageMock.mockImplementationOnce(() => true);

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        await onEvent({ type: "llm_call_started" });
        // `message_complete` is awaited so `handleMessageComplete` (and its
        // async indexer + projector chain) completes before the next event
        // or before the loop returns. Without the await the projector's
        // synchronous call still races against the test's assertion phase
        // because the indexer's `await` yields microtasks.
        await onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "indexed reply" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 10,
          outputTokens: 5,
          model: "test",
          providerDurationMs: 50,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [
              { type: "text", text: "indexed reply" },
            ] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // Indexer fired with the reserved row's id + the finalized content.
      expect(indexMessageNowMock).toHaveBeenCalledTimes(1);
      const indexCallArgs = indexMessageNowMock.mock.calls[0] as unknown as [
        {
          messageId: string;
          conversationId: string;
          role: string;
          content: string;
          createdAt: number;
          scopeId: string;
        },
        unknown,
      ];
      const indexCall = indexCallArgs[0];
      expect(indexCall).toMatchObject({
        messageId: "msg-reserve",
        conversationId: "test-conv",
        role: "assistant",
        createdAt: 1234567,
        scopeId: "default",
      });
      expect(indexCall.content).toContain("indexed reply");

      // Attention projector fired with the same row coordinates.
      expect(projectAssistantMessageMock).toHaveBeenCalledTimes(1);
      const projectCall = projectAssistantMessageMock.mock
        .calls[0] as unknown as [
        { conversationId: string; messageId: string; messageAt: number },
      ];
      expect(projectCall[0]).toEqual({
        conversationId: "test-conv",
        messageId: "msg-reserve",
        messageAt: 1234567,
      });

      // Projection reported a state change → sync invalidation fires with
      // the conversation `:metadata` tag. The mock also receives a
      // `:messages` invalidation from the orchestrator's
      // `publishLoopMessagesChanged` post-loop emit, so we filter by tag
      // rather than asserting a total call count.
      const metadataPublishes = (
        publishSyncInvalidationMock.mock.calls as unknown as Array<[string[]]>
      ).filter((args) => args[0]?.includes("conversation:test-conv:metadata"));
      expect(metadataPublishes).toHaveLength(1);
    });

    test("handleMessageComplete skips sync invalidation when attention state unchanged", async () => {
      // Mirror of the previous test but with the default projector return
      // (`false`). The projection still runs every turn, but the sync
      // invalidation publish must be gated on attention-state movement to
      // avoid flooding clients with no-op metadata refreshes.
      mockMessageById = {
        id: "msg-reserve",
        conversationId: "test-conv",
        createdAt: 999,
        role: "assistant",
        content: "[]",
        metadata: null,
      };

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        await onEvent({ type: "llm_call_started" });
        // See sibling test — `message_complete` must be awaited so the
        // projector call lands before the assertion phase.
        await onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "quiet" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 1,
          outputTokens: 1,
          model: "test",
          providerDurationMs: 1,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "quiet" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      expect(projectAssistantMessageMock).toHaveBeenCalledTimes(1);
      // The mock will still receive a `:messages` invalidation from the
      // orchestrator's `publishLoopMessagesChanged` — filter to the
      // `:metadata` tag and assert it never landed.
      const metadataPublishes = (
        publishSyncInvalidationMock.mock.calls as unknown as Array<[string[]]>
      ).filter((args) => args[0]?.includes("conversation:test-conv:metadata"));
      expect(metadataPublishes).toHaveLength(0);
    });

    test("handleLlmCallStarted deletes a stranded reservation before reserving a new row", async () => {
      // Simulates a retry path: the first LLM call reserves an assistant row
      // but exits without `message_complete` (e.g. context-overflow rescue,
      // ordering-error rescue, image-overflow rescue). The next
      // `llm_call_started` must delete the stranded row so the transcript
      // does not accumulate empty assistant bubbles.
      reserveMessageMock
        .mockImplementationOnce(async () => ({ id: "msg-strand-A" }))
        .mockImplementationOnce(async () => ({ id: "msg-strand-B" }));
      // Indexer/projector mocks default to no-op; no finalized row in this
      // test, so `mockMessageById` stays null.

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // First LLM call: reserve msg-strand-A, never finalize.
        await onEvent({ type: "llm_call_started" });
        // Second LLM call: should delete msg-strand-A before reserving
        // msg-strand-B.
        await onEvent({ type: "llm_call_started" });
        // Finalize the second one so the loop has a valid assistant message
        // and exits cleanly.
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "retry succeeded" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 5,
          outputTokens: 3,
          model: "test",
          providerDurationMs: 25,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [
              { type: "text", text: "retry succeeded" },
            ] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // Exactly one delete fires — for msg-strand-A, before the second
      // reserve. The second reservation is committed via `updateContent`
      // (not deleted), and after the run completes
      // `assistantRowAwaitingFinalization` is false, so no further delete
      // is attempted on shutdown.
      expect(deleteMessageByIdMock).toHaveBeenCalledTimes(1);
      const strandDeleteCall = deleteMessageByIdMock.mock
        .calls[0] as unknown as [string];
      expect(strandDeleteCall[0]).toBe("msg-strand-A");
      expect(reserveMessageMock).toHaveBeenCalledTimes(2);
    });

    test("provider-error branch deletes the orphaned reservation and repoints lastAssistantMessageId", async () => {
      // Codex P2 regression: B3 reserves an empty assistant row at
      // `llm_call_started`. When the call exits via the provider-error
      // branch (no `message_complete`), the synthetic error message is
      // inserted separately. Without cleanup the transcript would carry
      // both the empty reserved row AND the error message, and
      // `syncLastAssistantMessageToDisk` (which reads
      // `state.lastAssistantMessageId`) would mis-target the deleted
      // reservation id.
      reserveMessageMock.mockImplementationOnce(async () => ({
        id: "msg-orphaned-reservation",
      }));

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Reserve the orphan.
        await onEvent({ type: "llm_call_started" });
        // Provider rejects — writes the llm_request_log row and arms
        // `state.providerErrorUserMessage` via `handleError`.
        onEvent({
          type: "provider_error",
          error: new Error("upstream 500"),
          rawRequest: { model: "gpt-4.1", messages: [] },
          actualProvider: "openai",
        });
        onEvent({
          type: "error",
          error: new Error("upstream 500"),
        });
        // No assistant message in the result — the synthetic-error branch
        // below the agent loop fires.
        return messages;
      };

      const ctx = makeCtx({ agentLoopRun });
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // The orphan was deleted exactly once, before the synthetic error
      // message landed.
      expect(deleteMessageByIdMock).toHaveBeenCalledTimes(1);
      const deleteCall = deleteMessageByIdMock.mock.calls[0] as unknown as [
        string,
      ];
      expect(deleteCall[0]).toBe("msg-orphaned-reservation");

      // Post-loop `syncLastAssistantMessageToDisk` targets the synthetic
      // error row's id (`mock-msg-id` from the mocked `addMessage`), NOT
      // the deleted reservation id. This is the externally-observable
      // proof that `state.lastAssistantMessageId` was repointed.
      expect(syncMessageToDiskMock).toHaveBeenCalled();
      const syncCalls = syncMessageToDiskMock.mock.calls as unknown as Array<
        [string, string, number]
      >;
      const lastSync = syncCalls[syncCalls.length - 1];
      expect(lastSync?.[1]).toBe("mock-msg-id");
      expect(lastSync?.[1]).not.toBe("msg-orphaned-reservation");
    });
  });

  describe("pkbSystemReminderBlock metadata persistence", () => {
    test("persists pkbSystemReminderBlock in full mode with PKB active", async () => {
      const reminder = "<system_reminder>\npkb content\n</system_reminder>";
      mockInjectionBlocks = { pkbSystemReminder: reminder };
      const ctx = makeCtx();

      await runAgentLoopImpl(ctx, "hello", "user-msg-1", () => {});

      const pkbCalls = updateMessageMetadataMock.mock.calls.filter(
        (call) =>
          (call[1] as Record<string, unknown>).pkbSystemReminderBlock !==
          undefined,
      );
      expect(pkbCalls.length).toBe(1);
      expect(pkbCalls[0][0]).toBe("user-msg-1");
      expect(
        (pkbCalls[0][1] as Record<string, unknown>).pkbSystemReminderBlock,
      ).toBe(reminder);
    });

    test("skips persistence when pkbSystemReminder is absent (minimal mode or PKB inactive)", async () => {
      mockInjectionBlocks = {}; // no pkbSystemReminder key
      const ctx = makeCtx();

      await runAgentLoopImpl(ctx, "hello", "user-msg-2", () => {});

      const pkbCalls = updateMessageMetadataMock.mock.calls.filter(
        (call) =>
          (call[1] as Record<string, unknown>).pkbSystemReminderBlock !==
          undefined,
      );
      expect(pkbCalls.length).toBe(0);
    });

    test("does not propagate errors when updateMessageMetadata throws", async () => {
      mockInjectionBlocks = {
        pkbSystemReminder: "<system_reminder>\nboom\n</system_reminder>",
      };
      updateMessageMetadataMock.mockImplementationOnce(() => {
        throw new Error("db write failed");
      });
      const ctx = makeCtx();

      // Must not throw — the persist block wraps writes in try/catch.
      await expect(
        runAgentLoopImpl(ctx, "hello", "user-msg-3", () => {}),
      ).resolves.toBeUndefined();
    });

    test("writes both blocks in a single combined updateMessageMetadata call", async () => {
      // Both blocks are persisted via one combined call to halve SQLite
      // SELECT+UPDATE work on the hot user-turn path (the common case with
      // PKB active).
      const reminder = "<system_reminder>\npkb\n</system_reminder>";
      const turnContext = "<turn_context>\nnow\n</turn_context>";
      mockInjectionBlocks = {
        pkbSystemReminder: reminder,
        unifiedTurnContext: turnContext,
      };
      const ctx = makeCtx();

      await runAgentLoopImpl(ctx, "hello", "user-msg-4", () => {});

      const injectionCalls = updateMessageMetadataMock.mock.calls.filter(
        (call) => {
          const payload = call[1] as Record<string, unknown>;
          return (
            payload != null &&
            (Object.prototype.hasOwnProperty.call(
              payload,
              "pkbSystemReminderBlock",
            ) ||
              Object.prototype.hasOwnProperty.call(payload, "turnContextBlock"))
          );
        },
      );
      expect(injectionCalls.length).toBe(1);
      expect(injectionCalls[0]![0]).toBe("user-msg-4");
      expect(injectionCalls[0]![1]).toEqual({
        turnContextBlock: turnContext,
        pkbSystemReminderBlock: reminder,
      });
    });
  });

  describe("Slack compaction watermarks", () => {
    test("start-of-turn Slack compaction derives and persists watermark from rendered context", async () => {
      const renderedSlackMessages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "first rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "second rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "retained Slack row" }],
        },
      ];
      mockSlackChronologicalContext = {
        messages: renderedSlackMessages,
        renderedMessages: renderedSlackMessages.map((message, index) => ({
          message,
          sourceChannelTs: [
            "1700000010.000000",
            "1700000020.000000",
            "1700000030.000000",
          ][index]!,
          tagLineProvenance: "none",
        })),
        compactableStartIndex: 0,
      };
      const shouldCompactInputs: Message[][] = [];
      const maybeCompactInputs: Message[][] = [];

      const ctx = makeCtx({
        channelCapabilities: {
          channel: "slack",
          dashboardCapable: false,
          supportsDynamicUi: false,
          supportsVoiceInput: false,
          chatType: "channel",
        },
        trustContext: {
          sourceChannel: "slack",
          trustClass: "guardian",
        } as AgentLoopConversationContext["trustContext"],
        getTurnChannelContext: () => ({
          userMessageChannel: "slack" as const,
          assistantMessageChannel: "slack" as const,
        }),
        contextWindowManager: {
          shouldCompact: (messages: Message[]) => {
            shouldCompactInputs.push(messages);
            return { needed: true, estimatedTokens: 95_000 };
          },
          maybeCompact: async (messages: Message[]) => {
            maybeCompactInputs.push(messages);
            return {
              compacted: true,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "summary" }],
                },
                messages[2]!,
              ],
              compactedPersistedMessages: 2,
              previousEstimatedInputTokens: 95_000,
              estimatedInputTokens: 5_000,
              maxInputTokens: 100_000,
              thresholdTokens: 80_000,
              compactedMessages: 2,
              summaryCalls: 1,
              summaryInputTokens: 100,
              summaryOutputTokens: 20,
              summaryModel: "mock-model",
              summaryText: "summary",
              summaryFailed: false,
            };
          },
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "next reply", "user-msg-start", () => {});

      expect(shouldCompactInputs[0]).toBe(renderedSlackMessages);
      expect(maybeCompactInputs[0]).toBe(renderedSlackMessages);
      expect(getSlackCompactionWatermarkForPrefixMock).toHaveBeenCalledWith(
        mockSlackChronologicalContext,
        2,
      );
      expect(updateConversationSlackContextWatermarkMock).toHaveBeenCalledWith(
        "test-conv",
        "1700000020.000000",
        expect.any(Number),
      );
      const firstInjectionOptions = applyRuntimeInjectionsMock.mock
        .calls[0]![1] as {
        slackChronologicalMessages?: Message[] | null;
      };
      expect(firstInjectionOptions.slackChronologicalMessages).toBeNull();
    });

    test("overflow reducer Slack compaction persists watermark from rendered context", async () => {
      const renderedSlackMessages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "first rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "second rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "retained Slack row" }],
        },
      ];
      mockSlackChronologicalContext = {
        messages: renderedSlackMessages,
        renderedMessages: renderedSlackMessages.map((message, index) => ({
          message,
          sourceChannelTs: [
            "1700000010.000000",
            "1700000020.000000",
            "1700000030.000000",
          ][index]!,
          tagLineProvenance: "none",
        })),
        compactableStartIndex: 0,
      };
      mockEstimateTokens = 120_000;
      mockReducerStepFn = (_msgs: Message[]) => ({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "summary" }],
          },
          renderedSlackMessages[2]!,
        ],
        tier: "forced_compaction",
        state: {
          appliedTiers: ["forced_compaction"],
          injectionMode: "full",
          exhausted: false,
        },
        estimatedTokens: 5_000,
        compactionResult: {
          compacted: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "summary" }],
            },
            renderedSlackMessages[2]!,
          ],
          compactedPersistedMessages: 2,
          previousEstimatedInputTokens: 120_000,
          estimatedInputTokens: 5_000,
          maxInputTokens: 100_000,
          thresholdTokens: 80_000,
          compactedMessages: 2,
          summaryCalls: 1,
          summaryInputTokens: 100,
          summaryOutputTokens: 20,
          summaryModel: "mock-model",
          summaryText: "summary",
          summaryFailed: false,
        },
      });

      const ctx = makeCtx({
        channelCapabilities: {
          channel: "slack",
          dashboardCapable: false,
          supportsDynamicUi: false,
          supportsVoiceInput: false,
          chatType: "channel",
        },
        trustContext: {
          sourceChannel: "slack",
          trustClass: "guardian",
        } as AgentLoopConversationContext["trustContext"],
        getTurnChannelContext: () => ({
          userMessageChannel: "slack" as const,
          assistantMessageChannel: "slack" as const,
        }),
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "next reply", "user-msg-overflow", () => {});

      expect(getSlackCompactionWatermarkForPrefixMock).toHaveBeenCalledWith(
        mockSlackChronologicalContext,
        2,
      );
      expect(updateConversationSlackContextWatermarkMock).toHaveBeenCalledWith(
        "test-conv",
        "1700000020.000000",
        expect.any(Number),
      );
      const reinjectionOptions = applyRuntimeInjectionsMock.mock.calls.find(
        (call) => {
          const options = call[1] as {
            slackChronologicalMessages?: Message[] | null;
          };
          return options.slackChronologicalMessages === null;
        },
      )?.[1] as { slackChronologicalMessages?: Message[] | null } | undefined;
      expect(reinjectionOptions?.slackChronologicalMessages).toBeNull();
    });

    test("same-turn Slack compaction updates watermark from projected provenance", async () => {
      const renderedSlackMessages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "first rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "second rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "third rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "retained Slack row" }],
        },
      ];
      mockSlackChronologicalContext = {
        messages: renderedSlackMessages,
        renderedMessages: renderedSlackMessages.map((message, index) => ({
          message,
          sourceChannelTs: [
            "1700000010.000000",
            "1700000020.000000",
            "1700000030.000000",
            "1700000040.000000",
          ][index]!,
          tagLineProvenance: "none",
        })),
        compactableStartIndex: 0,
      };

      const firstSummaryMessage: Message = {
        role: "user",
        content: [{ type: "text", text: "first summary" }],
      };
      const firstCompactedMessages: Message[] = [
        firstSummaryMessage,
        renderedSlackMessages[2]!,
        renderedSlackMessages[3]!,
      ];
      const secondSummaryMessage: Message = {
        role: "user",
        content: [{ type: "text", text: "second summary" }],
      };
      const secondCompactedMessages: Message[] = [
        secondSummaryMessage,
        renderedSlackMessages[3]!,
      ];
      const reducerInputs: Message[][] = [];
      mockEstimateTokens = 120_000;
      mockReducerStepFn = (msgs: Message[]) => {
        reducerInputs.push(msgs);
        mockEstimateTokens = 1000;
        return {
          messages: secondCompactedMessages,
          tier: "forced_compaction",
          state: {
            appliedTiers: ["forced_compaction"],
            injectionMode: "full",
            exhausted: false,
          },
          estimatedTokens: 5_000,
          compactionResult: {
            compacted: true,
            messages: secondCompactedMessages,
            compactedPersistedMessages: 1,
            previousEstimatedInputTokens: 120_000,
            estimatedInputTokens: 5_000,
            maxInputTokens: 100_000,
            thresholdTokens: 80_000,
            compactedMessages: 1,
            summaryCalls: 1,
            summaryInputTokens: 100,
            summaryOutputTokens: 20,
            summaryModel: "mock-model",
            summaryText: "second summary",
            summaryFailed: false,
          },
        };
      };

      const ctx = makeCtx({
        channelCapabilities: {
          channel: "slack",
          dashboardCapable: false,
          supportsDynamicUi: false,
          supportsVoiceInput: false,
          chatType: "channel",
        },
        trustContext: {
          sourceChannel: "slack",
          trustClass: "guardian",
        } as AgentLoopConversationContext["trustContext"],
        getTurnChannelContext: () => ({
          userMessageChannel: "slack" as const,
          assistantMessageChannel: "slack" as const,
        }),
        contextWindowManager: {
          shouldCompact: () => ({ needed: true, estimatedTokens: 120_000 }),
          maybeCompact: async (messages: Message[]) => {
            expect(messages).toBe(renderedSlackMessages);
            return {
              compacted: true,
              messages: firstCompactedMessages,
              compactedPersistedMessages: 2,
              previousEstimatedInputTokens: 120_000,
              estimatedInputTokens: 60_000,
              maxInputTokens: 100_000,
              thresholdTokens: 80_000,
              compactedMessages: 2,
              summaryCalls: 1,
              summaryInputTokens: 100,
              summaryOutputTokens: 20,
              summaryModel: "mock-model",
              summaryText: "first summary",
              summaryFailed: false,
            };
          },
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "next reply", "user-msg-repeat", () => {});

      expect(reducerInputs[0]).toBe(firstCompactedMessages);
      expect(getSlackCompactionWatermarkForPrefixMock.mock.calls).toEqual([
        [mockSlackChronologicalContext, 2],
        [
          {
            renderedMessages: [
              {
                message: firstSummaryMessage,
                sourceChannelTs: null,
                tagLineProvenance: "none",
              },
              mockSlackChronologicalContext!.renderedMessages[2],
              mockSlackChronologicalContext!.renderedMessages[3],
            ],
            messages: firstCompactedMessages,
            compactableStartIndex: 1,
          },
          1,
        ],
      ]);
      expect(updateConversationSlackContextWatermarkMock.mock.calls).toEqual([
        ["test-conv", "1700000020.000000", expect.any(Number)],
        ["test-conv", "1700000030.000000", expect.any(Number)],
      ]);
      expect(loadSlackChronologicalContextMock).toHaveBeenCalledTimes(1);
    });

    test("mid-loop Slack compaction does not persist watermark from mismatched loaded context", async () => {
      const renderedSlackMessages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "first rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "second rendered Slack row" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "retained Slack row" }],
        },
      ];
      mockSlackChronologicalContext = {
        messages: renderedSlackMessages,
        renderedMessages: renderedSlackMessages.map((message, index) => ({
          message,
          sourceChannelTs: [
            "1700000010.000000",
            "1700000020.000000",
            "1700000030.000000",
          ][index]!,
          tagLineProvenance: "none",
        })),
        compactableStartIndex: 0,
      };

      const rawMidLoopBasis: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "fresh DB basis user row" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "partial assistant response" }],
        },
      ];
      const maybeCompactInputs: Message[][] = [];
      let runCount = 0;
      const agentLoopRun: AgentLoopRun = async (
        messages,
        _onEvent,
        options,
      ) => {
        runCount++;
        if (runCount === 1) {
          mockEstimateTokens = 90_000;
          const decision = await options?.onCheckpoint?.({
            turnIndex: 0,
            toolCount: 1,
            hasToolUse: true,
            history: messages,
          });
          mockEstimateTokens = 1000;
          if (decision === "yield") {
            return rawMidLoopBasis;
          }
        }
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "final response" }],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        channelCapabilities: {
          channel: "slack",
          dashboardCapable: false,
          supportsDynamicUi: false,
          supportsVoiceInput: false,
          chatType: "channel",
        },
        trustContext: {
          sourceChannel: "slack",
          trustClass: "guardian",
        } as AgentLoopConversationContext["trustContext"],
        getTurnChannelContext: () => ({
          userMessageChannel: "slack" as const,
          assistantMessageChannel: "slack" as const,
        }),
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async (messages: Message[]) => {
            maybeCompactInputs.push(messages);
            if (messages === renderedSlackMessages) {
              return {
                compacted: false,
                messages,
                compactedPersistedMessages: 0,
                previousEstimatedInputTokens: 1000,
                estimatedInputTokens: 1000,
                maxInputTokens: 100_000,
                thresholdTokens: 80_000,
                compactedMessages: 0,
                summaryCalls: 0,
                summaryInputTokens: 0,
                summaryOutputTokens: 0,
                summaryModel: "",
                summaryText: "",
              };
            }
            return {
              compacted: true,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "summary" }],
                },
              ],
              compactedPersistedMessages: 2,
              previousEstimatedInputTokens: 90_000,
              estimatedInputTokens: 5_000,
              maxInputTokens: 100_000,
              thresholdTokens: 80_000,
              compactedMessages: 2,
              summaryCalls: 1,
              summaryInputTokens: 100,
              summaryOutputTokens: 20,
              summaryModel: "mock-model",
              summaryText: "summary",
              summaryFailed: false,
            };
          },
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "next reply", "user-msg-mid-loop", () => {});

      expect(maybeCompactInputs[0]).toBe(renderedSlackMessages);
      expect(maybeCompactInputs[1]).toBe(rawMidLoopBasis);
      expect(getSlackCompactionWatermarkForPrefixMock).toHaveBeenCalledWith(
        null,
        2,
      );
      expect(
        updateConversationSlackContextWatermarkMock,
      ).not.toHaveBeenCalled();
    });

    test("next inbound Slack turn injects the watermark-filtered chronological context", async () => {
      mockConversationRow = {
        ...mockConversationRow,
        contextSummary: "## Summary\n- compacted Slack context",
        contextCompactedMessageCount: 12,
        slackContextCompactionWatermarkTs: "1700000010.000000",
      };
      mockSlackChronologicalContext = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "<context_summary>\n## Summary\n- compacted Slack context\n</context_summary>",
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "text", text: "after watermark reply" }],
          },
        ],
        renderedMessages: [
          {
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "<context_summary>\n## Summary\n- compacted Slack context\n</context_summary>",
                },
              ],
            },
            sourceChannelTs: null,
            tagLineProvenance: "none",
          },
          {
            message: {
              role: "user",
              content: [{ type: "text", text: "after watermark reply" }],
            },
            sourceChannelTs: "1700000020.000000",
            tagLineProvenance: "none",
          },
        ],
        compactableStartIndex: 1,
      };

      const ctx = makeCtx({
        channelCapabilities: {
          channel: "slack",
          dashboardCapable: false,
          supportsDynamicUi: false,
          supportsVoiceInput: false,
          chatType: "channel",
        },
        trustContext: {
          sourceChannel: "slack",
          trustClass: "guardian",
        } as AgentLoopConversationContext["trustContext"],
        getTurnChannelContext: () => ({
          userMessageChannel: "slack" as const,
          assistantMessageChannel: "slack" as const,
        }),
      });

      await runAgentLoopImpl(ctx, "next reply", "user-msg-1", () => {});

      expect(loadSlackChronologicalContextMock).toHaveBeenCalledWith(
        "test-conv",
        ctx.channelCapabilities,
        expect.objectContaining({
          contextSummary: "## Summary\n- compacted Slack context",
          contextCompactedMessageCount: 12,
          slackContextCompactionWatermarkTs: "1700000010.000000",
          trustClass: "guardian",
        }),
      );
      const firstInjectionOptions = applyRuntimeInjectionsMock.mock
        .calls[0]![1] as {
        slackChronologicalMessages?: Message[] | null;
      };
      expect(firstInjectionOptions.slackChronologicalMessages).toBe(
        mockSlackChronologicalContext.messages,
      );
      const rendered = firstInjectionOptions
        .slackChronologicalMessages!.flatMap((message) => message.content)
        .filter((block): block is { type: "text"; text: string } => {
          return block.type === "text";
        })
        .map((block) => block.text)
        .join("\n");
      expect(rendered).toContain("compacted Slack context");
      expect(rendered).toContain("after watermark reply");
      expect(rendered).not.toContain("before watermark");
    });

    test("subsequent Slack turn keeps long-thread compaction summary and filtered tail", async () => {
      mockConversationRow = {
        ...mockConversationRow,
        contextSummary: "## Summary\n- compacted long Slack thread",
        contextCompactedMessageCount: 81,
        slackContextCompactionWatermarkTs: "1700000080.000000",
      };
      mockSlackChronologicalContext = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "<context_summary>\n## Summary\n- compacted long Slack thread\n</context_summary>",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "[11/14/23 22:34 @carol → Mabc123]: reply after compaction",
              },
            ],
          },
        ],
        renderedMessages: [
          {
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "<context_summary>\n## Summary\n- compacted long Slack thread\n</context_summary>",
                },
              ],
            },
            sourceChannelTs: null,
            tagLineProvenance: "none",
          },
          {
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "[11/14/23 22:34 @carol → Mabc123]: reply after compaction",
                },
              ],
            },
            sourceChannelTs: "1700000121.000000",
            tagLineProvenance: "none",
          },
        ],
        compactableStartIndex: 1,
      };

      const ctx = makeCtx({
        channelCapabilities: {
          channel: "slack",
          dashboardCapable: false,
          supportsDynamicUi: false,
          supportsVoiceInput: false,
          chatType: "channel",
        },
        trustContext: {
          sourceChannel: "slack",
          trustClass: "guardian",
        } as AgentLoopConversationContext["trustContext"],
        getTurnChannelContext: () => ({
          userMessageChannel: "slack" as const,
          assistantMessageChannel: "slack" as const,
        }),
      });

      await runAgentLoopImpl(
        ctx,
        "reply after compaction",
        "user-msg-2",
        () => {},
      );

      expect(loadSlackChronologicalContextMock).toHaveBeenCalledWith(
        "test-conv",
        ctx.channelCapabilities,
        expect.objectContaining({
          contextSummary: "## Summary\n- compacted long Slack thread",
          contextCompactedMessageCount: 81,
          slackContextCompactionWatermarkTs: "1700000080.000000",
        }),
      );
      const firstInjectionOptions = applyRuntimeInjectionsMock.mock
        .calls[0]![1] as {
        slackChronologicalMessages?: Message[] | null;
      };
      const rendered = firstInjectionOptions
        .slackChronologicalMessages!.flatMap((message) => message.content)
        .filter((block): block is { type: "text"; text: string } => {
          return block.type === "text";
        })
        .map((block) => block.text)
        .join("\n");
      expect(rendered).toContain("compacted long Slack thread");
      expect(rendered).toContain("reply after compaction");
      expect(rendered).not.toContain("pre-compaction");
      expect(rendered).not.toContain("original root");
    });

    test("applyCompactionResult records Slack timestamp watermark when provided", async () => {
      const ctx = makeCtx();
      const events: ServerMessage[] = [];

      await applyCompactionResult(
        ctx,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "summary" }],
            },
          ],
          compactedPersistedMessages: 4,
          previousEstimatedInputTokens: 12000,
          estimatedInputTokens: 3000,
          maxInputTokens: 100000,
          thresholdTokens: 80000,
          compactedMessages: 4,
          summaryCalls: 1,
          summaryInputTokens: 100,
          summaryOutputTokens: 20,
          summaryModel: "mock-model",
          summaryText: "summary",
        },
        (event) => events.push(event),
        "req-1",
        { slackContextCompactionWatermarkTs: "1700000020.000000" },
      );

      expect(updateConversationSlackContextWatermarkMock).toHaveBeenCalledWith(
        "test-conv",
        "1700000020.000000",
        expect.any(Number),
      );
      expect(events.some((event) => event.type === "context_compacted")).toBe(
        true,
      );
    });
  });

  describe("compaction-strip marker persistence", () => {
    test("records historyStrippedAt when convergence strip runs", async () => {
      // Reducer: succeed on first call, returning reduced messages.
      mockReducerStepFn = (msgs: Message[]) => ({
        messages: msgs,
        tier: "forced_compaction",
        state: {
          appliedTiers: ["forced_compaction"],
          injectionMode: "full",
          exhausted: false,
        },
        estimatedTokens: 5000,
      });

      let callCount = 0;
      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        callCount++;
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`. Retry branches
        // need this on every invocation: each agent-loop iteration reserves
        // its own row.
        await onEvent({ type: "llm_call_started" });
        if (callCount === 1) {
          // Trigger convergence path: error + appended assistant message so
          // updatedHistory.length > preRunHistoryLength at the strip site.
          onEvent({
            type: "error",
            error: new Error("context_length_exceeded"),
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 50,
          });
          return [
            ...messages,
            {
              role: "assistant" as const,
              content: [{ type: "text", text: "partial" }] as ContentBlock[],
            },
          ];
        }
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50,
          outputTokens: 25,
          model: "test-model",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "recovered" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

      const stripCalls = setConversationHistoryStrippedAtMock.mock.calls.filter(
        (call) => call[0] === "test-conv",
      );
      expect(stripCalls.length).toBeGreaterThanOrEqual(1);
    });

    test("strip-site marker write is non-fatal when the helper throws", async () => {
      setConversationHistoryStrippedAtMock.mockImplementation(() => {
        throw new Error("db write failed");
      });

      mockReducerStepFn = (msgs: Message[]) => ({
        messages: msgs,
        tier: "forced_compaction",
        state: {
          appliedTiers: ["forced_compaction"],
          injectionMode: "full",
          exhausted: false,
        },
        estimatedTokens: 5000,
      });

      let callCount = 0;
      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        callCount++;
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`. Retry branches
        // need this on every invocation: each agent-loop iteration reserves
        // its own row.
        await onEvent({ type: "llm_call_started" });
        if (callCount === 1) {
          onEvent({
            type: "error",
            error: new Error("context_length_exceeded"),
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 50,
          });
          return [
            ...messages,
            {
              role: "assistant" as const,
              content: [{ type: "text", text: "partial" }] as ContentBlock[],
            },
          ];
        }
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50,
          outputTokens: 25,
          model: "test-model",
          providerDurationMs: 100,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "recovered" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      // Must not throw — the strip-site marker write is wrapped in try/catch.
      await expect(
        runAgentLoopImpl(ctx, "hello", "msg-1", () => {}),
      ).resolves.toBeUndefined();
    });
  });
});

import { createRequire } from "node:module";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
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
    ui: {},
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

const updateMessageMetadataMock = mock(
  (_id: string, _updates: Record<string, unknown>) => {},
);
const clearStrippedInjectionMetadataForConversationMock = mock(
  (_conversationId: string) => {},
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
mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  updateConversationUsage: () => {},
  updateMessageMetadata: updateMessageMetadataMock,
  clearStrippedInjectionMetadataForConversation:
    clearStrippedInjectionMetadataForConversationMock,
  getMessages: () => [],
  getConversation: () => mockConversationRow,
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  addMessage: () => ({ id: "mock-msg-id" }),
  deleteMessageById: () => {},
  updateConversationContextWindow: () => {},
  updateConversationSlackContextWatermark:
    updateConversationSlackContextWatermarkMock,
  updateConversationTitle: () => {},
  getConversationOriginChannel: () => null,
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
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

mock.module("../daemon/date-context.js", () => ({
  formatTurnTimestamp: () => "2026-01-01 (Thursday) 00:00:00 +00:00 (UTC)",
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
  backfillMessageIdOnLogs: () => {},
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
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  requestId?: string,
  onCheckpoint?: (
    checkpoint: CheckpointInfo,
  ) => CheckpointDecision | Promise<CheckpointDecision>,
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
      onCompacted: () => {},
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
  mockEstimateTokens = 1000;
  mockReducerStepFn = null;
  mockOverflowAction = "fail_gracefully";
  mockInjectionBlocks = {};
  recordUsageMock.mockClear();
  recordRequestLogMock.mockClear();
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
  clearStrippedInjectionMetadataForConversationMock.mockClear();
  clearStrippedInjectionMetadataForConversationMock.mockImplementation(
    () => {},
  );
  applyRuntimeInjectionsMock.mockClear();
  mockSlackChronologicalContext = null;
  loadSlackChronologicalContextMock.mockClear();
  getSlackCompactionWatermarkForPrefixMock.mockClear();
  // Orchestrator pipelines (overflowReduce, persistence, …) run through the
  // plugin registry; reset and re-register every default so the pipelines
  // dispatch to middleware backed by the mocked collaborators these tests
  // install (`reduceContextOverflow`, `syncMessageToDisk`, etc.) instead of
  // hitting the bare terminals.
  resetPluginRegistryAndRegisterDefaults();
});

describe("session-agent-loop", () => {
  describe("pre-flight checks", () => {
    test("throws if called without an abortController", async () => {
      const ctx = makeCtx();
      ctx.abortController = null;
      await expect(
        runAgentLoopImpl(ctx, "hello", "msg-1", () => {}),
      ).rejects.toThrow("runAgentLoop called without prior persistUserMessage");
    });
  });

  describe("tool execution errors via agent loop", () => {
    test("error events from agent loop are classified and emitted", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
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
      const call = recordRequestLogMock.mock.calls[0] as unknown as [
        string,
        string,
        string,
        undefined,
        string,
      ];
      expect(call).toEqual([
        "test-conv",
        JSON.stringify(rawRequest),
        JSON.stringify(rawResponse),
        undefined,
        "fireworks",
      ]);
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
      const call = recordRequestLogMock.mock.calls[0] as unknown as [
        string,
        string,
        string,
        undefined,
        string,
      ];
      expect(call).toEqual([
        "test-conv",
        JSON.stringify(rawRequest),
        JSON.stringify(rawResponse),
        undefined,
        "openai",
      ]);
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

      const agentLoopRun: AgentLoopRun = async (
        messages,
        onEvent,
        _signal,
        _reqId,
        onCheckpoint,
      ) => {
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
        if (onCheckpoint) {
          const decision = await onCheckpoint({
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
    });

    test("continues when canHandoffAtCheckpoint returns false", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (
        messages,
        onEvent,
        _signal,
        _reqId,
        onCheckpoint,
      ) => {
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
        if (onCheckpoint) {
          await onCheckpoint({
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
      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });
  });

  describe("user cancellation", () => {
    test("emits generation_cancelled when abort signal fires", async () => {
      const events: ServerMessage[] = [];
      const abortController = new AbortController();

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
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
      const ctx = makeCtx({
        agentLoopRun: async () => {
          throw new Error("unexpected crash");
        },
      });

      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      expect(ctx.processing).toBe(false);
      expect(ctx.abortController).toBeNull();
    });

    test("drains queue after completion", async () => {
      let drainReason: string | undefined;
      const ctx = makeCtx({
        agentLoopRun: async (
          messages: Message[],
          onEvent: (event: AgentEvent) => void,
        ) => {
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
              },
              mockSlackChronologicalContext.renderedMessages[2],
              mockSlackChronologicalContext.renderedMessages[3],
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
        _signal,
        _reqId,
        onCheckpoint,
      ) => {
        runCount++;
        if (runCount === 1) {
          mockEstimateTokens = 90_000;
          const decision = await onCheckpoint?.({
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
          },
          {
            message: {
              role: "user",
              content: [{ type: "text", text: "after watermark reply" }],
            },
            sourceChannelTs: "1700000020.000000",
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

    test("applyCompactionResult records Slack timestamp watermark when provided", () => {
      const ctx = makeCtx();
      const events: ServerMessage[] = [];

      applyCompactionResult(
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

  describe("compaction-strip metadata consistency", () => {
    test("clears pkbSystemReminderBlock metadata when convergence strip runs", async () => {
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

      // The bulk-clear helper must have been called with the conversation id
      // at least once (one of the three strip sites fired).
      const clearCalls =
        clearStrippedInjectionMetadataForConversationMock.mock.calls.filter(
          (call) => call[0] === "test-conv",
        );
      expect(clearCalls.length).toBeGreaterThanOrEqual(1);
    });

    test("strip-site clear is non-fatal when the helper throws", async () => {
      clearStrippedInjectionMetadataForConversationMock.mockImplementation(
        () => {
          throw new Error("db write failed");
        },
      );

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

      // Must not throw — the strip-site clear is wrapped in try/catch.
      await expect(
        runAgentLoopImpl(ctx, "hello", "msg-1", () => {}),
      ).resolves.toBeUndefined();
    });
  });
});

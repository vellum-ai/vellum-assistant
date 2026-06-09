/**
 * Overflow recovery test suite for JARVIS-110.
 *
 * Reproduces the failure modes observed in long conversations (75+ messages)
 * where context overflow recovery fails because:
 *   1. Progress during the agent loop bypasses the convergence retry
 *   2. Token estimation significantly underestimates actual token count
 *   3. No mid-loop budget check to prevent hitting the provider limit
 *
 * Most tests are test.todo — they document expected behavior for bugs
 * to be fixed in subsequent PRs (PR 2 for tests 1–5, PR 3 for tests 6–7).
 * Tests 2, 8, 9, and 10 are now active and passing against current code.
 */
import { createRequire } from "node:module";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LoopToolExecutor } from "../agent/loop.js";
import type { LLMConfig } from "../config/schemas/llm.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type { Message, Provider, ToolDefinition } from "../providers/types.js";

const conversationCrudRealSnapshot = {
  ...(createRequire(import.meta.url)(
    "../memory/conversation-crud.js",
  ) as Record<string, unknown>),
};
const tokenEstimatorRealSnapshot = {
  ...(createRequire(import.meta.url)("../context/token-estimator.js") as Record<
    string,
    unknown
  >),
};
const conversationRuntimeAssemblyRealSnapshot = {
  ...(createRequire(import.meta.url)(
    "../daemon/conversation-runtime-assembly.js",
  ) as Record<string, unknown>),
};

// ── Module mocks (must precede imports of the module under test) ─────

// The real AgentLoop resolves the per-conversation ContextWindowManager from
// the compaction store keyed by conversationId. These overflow tests build
// fake conversations whose manager is a canned stub, so register each stub in a
// map the mocked store reads from.
const fakeContextWindowManagers = new Map<string, unknown>();
mock.module("../plugins/defaults/compaction/manager-store.js", () => ({
  createContextWindowManager: () => undefined,
  getContextWindowManager: (conversationId: string) =>
    fakeContextWindowManagers.get(conversationId),
  disposeContextWindowManager: (conversationId: string) => {
    fakeContextWindowManagers.delete(conversationId);
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

const defaultLlmConfig: LLMConfig = {
  default: {
    provider: "anthropic",
    model: "mock-model",
    maxTokens: 4096,
    effort: "max" as const,
    speed: "standard" as const,
    verbosity: "medium" as const,
    temperature: null,
    thinking: { enabled: false, streamThinking: true },
    contextWindow: {
      enabled: true,
      maxInputTokens: 200_000,
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
    openrouter: { only: [] },
  },
  profiles: {},
  profileOrder: [],
  callSites: {},
  profileSession: { defaultTtlSeconds: 1800, maxTtlSeconds: 43200 },
  pricingOverrides: [],
};

let mockLlmConfig: LLMConfig = structuredClone(defaultLlmConfig);

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: mockLlmConfig,
    rateLimit: { maxRequestsPerMinute: 0 },
    workspaceGit: { turnCommitMaxWaitMs: 10 },
    memory: { retrieval: { scratchpadInjection: { enabled: true } } },
    ui: {},
    compaction: { enabled: true, autoThreshold: 0.7 },
    conversations: { skipAutoRetitling: true },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// ── Overflow recovery mocks ──────────────────────────────────────────

// Token estimator — controllable per-test via mockEstimateTokens.
// Can be a number (constant), a no-arg function, or a function that
// receives the messages array for dynamic behavior based on content.
// Both the calibrated entry point (`estimatePromptTokens`, which backs the
// loop's budget gate and the convergence path) and the raw entry point
// (`estimatePromptTokensRaw`, used by the pre-send calibration capture) are
// stubbed so either call site can drive the test.
let mockEstimateTokens: number | ((msgs?: Message[]) => number) = 1000;
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: (msgs: Message[]) =>
    typeof mockEstimateTokens === "function"
      ? mockEstimateTokens(msgs)
      : mockEstimateTokens,
  estimatePromptTokensRaw: (msgs: Message[]) =>
    typeof mockEstimateTokens === "function"
      ? mockEstimateTokens(msgs)
      : mockEstimateTokens,
  // The loop's budget gate calls this calibrated wrapper directly, so it
  // must honor `mockEstimateTokens` too — otherwise the real implementation
  // (which sums tool tokens onto the real calibrated estimate) ignores the
  // per-test value and the overflow scenarios below never trigger.
  estimatePromptTokensWithTools: (history: Message[]) =>
    typeof mockEstimateTokens === "function"
      ? mockEstimateTokens(history)
      : mockEstimateTokens,
  // `estimatePromptTokensWithTools` folds tool tokens in via this helper; 0
  // keeps the stubbed value unchanged.
  estimateToolsTokens: () => 0,
  // Conversation agent loop now calls this helper to canonicalize the
  // provider key shared with the calibration system. The tests here
  // don't exercise that path, so a passthrough mock is fine.
  getCalibrationProviderKey: (provider: {
    name: string;
    tokenEstimationProvider?: string;
  }) => provider.tokenEstimationProvider ?? provider.name,
}));

// Reducer: by default returns the input untouched and marks exhausted
let mockReducerStepFn:
  | ((msgs: Message[], cfg: unknown, state: unknown) => unknown)
  | null = null;
const makeInitialReducerState = () => ({
  appliedTiers: [] as string[],
  injectionMode: "full" as const,
  exhausted: false,
});
const runMockReducer = async (
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
};
mock.module(
  "../plugins/defaults/compaction/context-overflow-reducer.js",
  () => ({
    createInitialReducerState: makeInitialReducerState,
    reduceContextOverflow: runMockReducer,
  }),
);

// Stand-in for `ContextWindowManager`'s turn-scoped overflow ladder. Threads
// reducer state across a turn's rungs and delegates each rung to the mocked
// reducer, mirroring `reduceOverflowOneRung` / `resetOverflowRecovery` so the
// convergence driver exercises the same per-rung escalation the real manager
// drives.
function makeOverflowLadderStub(): {
  resetOverflowRecovery: () => void;
  reduceOverflowOneRung: (
    msgs: Message[],
    opts: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
} {
  let state: unknown;
  return {
    resetOverflowRecovery: () => {
      state = undefined;
    },
    reduceOverflowOneRung: async (msgs: Message[], opts: unknown) => {
      if (!state) state = makeInitialReducerState();
      const step = (await runMockReducer(msgs, opts, state)) as {
        state: unknown;
      };
      state = step.state;
      return step;
    },
  };
}

// Policy: default to fail_gracefully
let mockOverflowAction: string = "fail_gracefully";
mock.module("../daemon/context-overflow-policy.js", () => ({
  resolveOverflowAction: () => mockOverflowAction,
}));

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  setConversationHistoryStrippedAt: () => {},
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
  addMessage: (...args: unknown[]) => addMessageMock(...args),
  deleteMessageById: () => {},
  updateConversationContextWindow: () => {},
  updateConversationTitle: () => {},
  getConversationOriginChannel: () => null,
  getMessageById: () => null,
  updateMessageContent: () => {},
  updateMessageMetadata: () => {},
  setLastNotifiedInferenceProfile: () => {},
  getLastUserTimestampBefore: () => 0,
  resolveOverrideProfile: () => undefined,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

afterAll(() => {
  mock.module(
    "../memory/conversation-crud.js",
    () => conversationCrudRealSnapshot,
  );
  mock.module(
    "../context/token-estimator.js",
    () => tokenEstimatorRealSnapshot,
  );
  mock.module(
    "../daemon/conversation-runtime-assembly.js",
    () => conversationRuntimeAssemblyRealSnapshot,
  );
});

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

let mockApplyRuntimeInjections: (msgs: Message[]) => Message[] = (msgs) => msgs;
mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  applyRuntimeInjections: async (msgs: Message[]) => ({
    messages: mockApplyRuntimeInjections(msgs),
    blocks: {},
  }),
  stripInjectionsForCompaction: (msgs: Message[]) => msgs,
  isSlackChannelConversation: () => false,
  getSlackCompactionWatermarkForPrefix: () => null,
  loadSlackChronologicalContext: () => null,
  loadSlackChronologicalMessages: () => null,
  loadSlackActiveThreadFocusBlock: () => null,
  assembleSlackChronologicalMessages: () => null,
  assembleSlackActiveThreadFocusBlock: () => null,
}));

mock.module("../daemon/date-context.js", () => ({
  formatTurnTimestamp: () => "2026-01-01 (Thursday) 00:00:00 +00:00 (UTC)",
}));

mock.module("../plugins/defaults/history-repair/terminal.js", () => ({
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

const recordUsageMock = mock((..._args: unknown[]) => {});
const setAgentLoopExitReasonOnLatestLogMock = mock(() => {});
const addMessageMock = mock(
  (..._args: unknown[]) => ({ id: "mock-msg-id" }) as { id: string },
);
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
  classifyConversationError: (err: unknown, _ctx: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/context.?length.?exceeded/i.test(message)) {
      return {
        code: "CONTEXT_TOO_LARGE",
        userMessage: "Context too large.",
        retryable: false,
        errorCategory: "context_too_large",
      };
    }
    return {
      code: "CONVERSATION_PROCESSING_FAILED",
      userMessage: "Something went wrong processing your message.",
      retryable: false,
      errorCategory: "processing_failed",
    };
  },
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
  isContextTooLarge: (msg: string) =>
    /context.?length.?exceeded|prompt.?is.?too.?long|too many.*input.*tokens/i.test(
      msg,
    ),
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

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
  setAgentLoopExitReasonOnLatestLog: setAgentLoopExitReasonOnLatestLogMock,
}));

mock.module("../memory/archive-store.js", () => ({
  insertCompactionEpisode: () => ({
    episodeId: "mock-episode-id",
    jobId: "mock-job-id",
  }),
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { AgentLoop } from "../agent/loop.js";
import type { Conversation } from "../daemon/conversation.js";
import { runAgentLoopImpl } from "../daemon/conversation-agent-loop.js";
import {
  createMockProvider,
  type ScriptedResponse,
  textResponse,
  toolUseResponse,
} from "./helpers/mock-provider.js";

// ── Test helpers ─────────────────────────────────────────────────────

function makeCtx(
  overrides?: Partial<Conversation> & {
    providerResponses?: ScriptedResponse[];
    loopProvider?: Provider;
    loopTools?: ToolDefinition[];
    toolExecutor?: LoopToolExecutor;
  },
): Conversation {
  const {
    providerResponses,
    loopProvider,
    loopTools,
    toolExecutor,
    ...ctxOverrides
  } = overrides ?? {};
  const conversationId = ctxOverrides.conversationId ?? "test-conv";

  // Drive the real `AgentLoop` against a scripted provider, mocking only the
  // provider HTTP boundary. The loop owns its mid-loop budget gate, inline
  // compaction, and event emission, so these overflow tests exercise the real
  // escalation/persistence path.
  const loopProviderName =
    (ctxOverrides.provider as { name?: string } | undefined)?.name ??
    "mock-provider";
  const provider =
    loopProvider ??
    createMockProvider(
      providerResponses ?? [textResponse("response")],
      loopProviderName,
    ).provider;
  const agentLoop = new AgentLoop({
    provider: provider,
    systemPrompt: "system prompt",
    conversationId,
    tools: loopTools ?? [],
    toolExecutor,
  });

  const ctx = {
    conversationId: "test-conv",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ] as Message[],
    processing: true,
    isProcessing(this: { processing: boolean }) {
      return this.processing;
    },
    setProcessing(this: { processing: boolean }, value: boolean) {
      this.processing = value;
    },
    abortController: new AbortController(),
    currentRequestId: "test-req",

    agentLoop,
    provider: {
      name: "mock-provider",
      sendMessage: async () => ({
        content: [{ type: "text", text: "title" }],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      }),
    } as unknown as Conversation["provider"],
    systemPrompt: "system prompt",

    contextWindowManager: {
      updateConfig: () => {},
      shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
      maybeCompact: async () => ({ compacted: false }),
    } as unknown as Conversation["contextWindowManager"],
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
    channelCapabilities: undefined,
    commandIntent: undefined,
    trustContext: undefined,

    coreToolNames: new Set(),
    allowedToolNames: undefined,
    preactivatedSkillIds: undefined,
    skillProjectionState: new Map(),
    skillProjectionCache:
      new Map() as unknown as Conversation["skillProjectionCache"],

    traceEmitter: {
      emit: () => {},
    } as unknown as Conversation["traceEmitter"],
    profiler: {
      startRequest: () => {},
      emitSummary: () => {},
    } as unknown as Conversation["profiler"],
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
    prompter: {} as unknown as Conversation["prompter"],
    queue: {} as unknown as Conversation["queue"],

    getWorkspaceGitService: () => ({ ensureInitialized: async () => {} }),
    commitTurnChanges: async () => {},

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
      recordPkbQueryVectors: () => {},
    } as unknown as Conversation["graphMemory"],

    ...ctxOverrides,
  } as unknown as Conversation;
  // The convergence driver resolves the turn-scoped overflow ladder off the
  // manager; give every fake manager the ladder methods unless a test supplied
  // its own.
  const manager = ctx.contextWindowManager as unknown as Record<
    string,
    unknown
  >;
  if (typeof manager.reduceOverflowOneRung !== "function") {
    Object.assign(manager, makeOverflowLadderStub());
  }
  fakeContextWindowManagers.set(conversationId, ctx.contextWindowManager);
  return ctx;
}

/**
 * Build a realistic long conversation with interleaved tool calls.
 * Returns an array of messages simulating a 75+ message conversation
 * with a mix of text, tool_use, and tool_result blocks.
 */
function buildLongConversation(messageCount: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < messageCount; i++) {
    if (i % 3 === 0) {
      // User text message
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `User message ${i}: ${"x".repeat(200)} some detailed instructions about the task at hand`,
          },
        ],
      });
    } else if (i % 3 === 1) {
      // Assistant with tool_use
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `Thinking about step ${i}...` },
          {
            type: "tool_use",
            id: `tool-${i}`,
            name: i % 6 === 1 ? "bash" : "file_read",
            input: {
              command: `some command ${i}`,
              path: `/path/to/file-${i}.ts`,
            },
          },
        ],
      });
    } else {
      // User with tool_result
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `tool-${i - 1}`,
            content: `Result of tool call ${i - 1}: ${"output data ".repeat(50)}`,
            is_error: false,
          },
        ],
      });
    }
  }
  return messages as Message[];
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  mockLlmConfig = structuredClone(defaultLlmConfig);
  mockEstimateTokens = 1000;
  mockReducerStepFn = null;
  mockOverflowAction = "fail_gracefully";
  mockApplyRuntimeInjections = (msgs) => msgs;
  recordUsageMock.mockClear();
  setAgentLoopExitReasonOnLatestLogMock.mockClear();
  addMessageMock.mockClear();
  // Reset the plugin registry and re-register every default so the compaction
  // pipeline dispatches to the default middleware, which in turn hits the
  // mocked collaborators (`syncMessageToDisk`, …) these tests install.
  resetPluginRegistryAndRegisterDefaults();
});

describe("session-agent-loop overflow recovery (JARVIS-110)", () => {
  test("usage update context max follows active main-agent profile budget", async () => {
    // GIVEN an active main-agent profile that narrows the context budget
    mockLlmConfig = {
      ...structuredClone(defaultLlmConfig),
      activeProfile: "short-context",
      profiles: {
        "short-context": {
          source: "user",
          contextWindow: { maxInputTokens: 150_000 },
        },
      },
    };

    // AND a provider turn that reports 12k input tokens of usage
    const ctx = makeCtx({
      providerResponses: [
        {
          content: [{ type: "text", text: "response" }],
          model: "mock-model",
          usage: { inputTokens: 12_000, outputTokens: 300 },
          stopReason: "end_turn",
        },
      ],
    });

    // WHEN the turn runs to completion
    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    // THEN the recorded main-agent usage carries the profile's max budget
    const mainAgentUsageCall = recordUsageMock.mock.calls.find(
      (call) => call[5] === "main_agent",
    );
    expect(mainAgentUsageCall).toBeDefined();
    expect(mainAgentUsageCall?.[11]).toEqual({
      tokens: 12_000,
      maxTokens: 150_000,
    });
  });

  // ── Test 1 ────────────────────────────────────────────────────────
  // BUG: When the agent loop makes progress (adds messages to history)
  // before hitting context_too_large, the convergence loop's progress
  // check must recognize that the loop appended messages. If it fails to,
  // the reducer is never invoked — the error is surfaced immediately
  // without any compaction attempt.
  //
  // Expected behavior (PR 2 fix): After progress + context_too_large,
  // the system should still attempt compaction before surfacing error.
  test.todo(
    "context too large after progress triggers compaction retry instead of immediate failure",
    async () => {
      const events: ServerMessage[] = [];
      let reducerCalled = false;

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
          estimatedTokens: 50_000,
          compactionResult: {
            compacted: true,
            messages: msgs,
            compactedPersistedMessages: 5,
            summaryText: "Summary",
            previousEstimatedInputTokens: 190_000,
            estimatedInputTokens: 50_000,
            maxInputTokens: 200_000,
            thresholdTokens: 160_000,
            compactedMessages: 10,
            summaryCalls: 1,
            summaryInputTokens: 500,
            summaryOutputTokens: 200,
            summaryModel: "mock-model",
          },
        };
      };

      // Run 1 makes progress (a tool turn) then the following provider call
      // rejects with a context_too_large error; after the convergence reducer
      // compacts, the rerun recovers with plain text.
      const { provider } = createMockProvider([
        toolUseResponse("tu-progress", "bash", { command: "ls" }),
        new Error("prompt is too long: 242201 tokens > 200000 maximum"),
        textResponse("recovered after compaction"),
      ]);

      const ctx = makeCtx({
        loopProvider: provider,
        loopTools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        ],
        toolExecutor: async () => ({
          content: "file1.ts\nfile2.ts",
          isError: false,
        }),
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as Conversation["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // BUG: Currently the reducer is NOT called when progress was made before
      // context_too_large. The error is surfaced immediately.
      // After PR 2 fix, the reducer SHOULD be called to attempt compaction.
      expect(reducerCalled).toBe(true);

      // BUG: Currently a conversation_error IS emitted instead of retrying.
      // After PR 2 fix, there should be no conversation_error.
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
    },
  );

  // ── Test 2 ────────────────────────────────────────────────────────
  // When estimation says we're within budget but the provider rejects,
  // the post-run convergence loop should kick in and recover.
  // This test should PASS against current code (when no progress is made).
  test("overflow recovery compacts below limit even when estimation underestimates", async () => {
    const events: ServerMessage[] = [];
    let reducerCalled = false;

    // GIVEN the estimator reports 185k and the context manager's compaction
    // is a no-op, so the first call proceeds to the provider without any
    // up-front reduction.
    mockEstimateTokens = 185_000;

    // AND the post-run convergence reducer successfully compacts
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
        estimatedTokens: 100_000,
        compactionResult: {
          compacted: true,
          messages: msgs,
          compactedPersistedMessages: 10,
          summaryText: "Summary",
          previousEstimatedInputTokens: 185_000,
          estimatedInputTokens: 100_000,
          maxInputTokens: 200_000,
          thresholdTokens: 160_000,
          compactedMessages: 20,
          summaryCalls: 1,
          summaryInputTokens: 800,
          summaryOutputTokens: 300,
          summaryModel: "mock-model",
        },
      };
    };

    // AND a provider that rejects the first call as too long (revealing the
    // real 242k count the estimator missed), then succeeds on the rerun.
    const { provider, calls } = createMockProvider([
      new Error("prompt is too long: 242201 tokens > 200000 maximum"),
      textResponse("recovered"),
    ]);

    const ctx = makeCtx({
      loopProvider: provider,
      contextWindowManager: {
        updateConfig: () => {},
        shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
        maybeCompact: async () => ({ compacted: false }),
      } as unknown as Conversation["contextWindowManager"],
    });

    // WHEN the turn runs
    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // THEN the convergence reducer ran and the rerun recovered without a
    // user-facing conversation_error.
    expect(reducerCalled).toBe(true);
    const conversationError = events.find(
      (e) => e.type === "conversation_error",
    );
    expect(conversationError).toBeUndefined();
    expect(calls.length).toBe(2);
  });

  // ── Test 3 ────────────────────────────────────────────────────────
  // When the provider rejection reveals the actual token count (e.g.,
  // "242201 tokens > 200000"), the overflow reducer's `targetTokens`
  // should be a budget below the actual limit, not below the estimator's
  // inaccurate budget. With a preflightBudget of 190k but an actual count
  // of 242k (1.31x the estimate of 185k), the target is adjusted downward
  // based on the observed mismatch (190k / 1.31 ≈ 145k) so the reducer
  // converges toward the real ceiling rather than the optimistic estimate.
  test.todo(
    "forced compaction targets a lower budget when estimation has been inaccurate",
    async () => {
      const events: ServerMessage[] = [];
      let capturedTargetTokens: number | undefined;

      // Estimator says 185k (below 190k budget = 200k * 0.95)
      mockEstimateTokens = 185_000;

      // Reducer captures the targetTokens from the config
      mockReducerStepFn = (msgs: Message[], cfg: unknown) => {
        capturedTargetTokens = (cfg as { targetTokens: number }).targetTokens;
        return {
          messages: msgs,
          tier: "forced_compaction",
          state: {
            appliedTiers: ["forced_compaction"],
            injectionMode: "full",
            exhausted: false,
          },
          estimatedTokens: 100_000,
          compactionResult: {
            compacted: true,
            messages: msgs,
            compactedPersistedMessages: 10,
            summaryText: "Summary",
            previousEstimatedInputTokens: 185_000,
            estimatedInputTokens: 100_000,
            maxInputTokens: 200_000,
            thresholdTokens: 160_000,
            compactedMessages: 20,
            summaryCalls: 1,
            summaryInputTokens: 800,
            summaryOutputTokens: 300,
            summaryModel: "mock-model",
          },
        };
      };

      // The provider rejects the first call with a context_too_large error
      // (actual tokens 242201, far above the 185k estimate); after forced
      // compaction re-targets a lower budget, the rerun recovers with text.
      const { provider, calls } = createMockProvider([
        new Error("prompt is too long: 242201 tokens > 200000 maximum"),
        textResponse("recovered"),
      ]);

      const ctx = makeCtx({
        loopProvider: provider,
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as Conversation["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // The reducer should have been called with a corrected target
      expect(capturedTargetTokens).toBeDefined();

      // preflightBudget = 200_000 * 0.95 = 190_000
      // estimationErrorRatio = 242201 / 185000 ≈ 1.309
      // correctedTarget = floor(190000 / 1.309) ≈ 145_130
      // The corrected target must be LESS than the uncorrected preflightBudget
      const preflightBudget = 190_000;
      expect(capturedTargetTokens!).toBeLessThan(preflightBudget);

      // Verify the approximate corrected value (190000 / (242201/185000))
      const expectedCorrectedTarget = Math.floor(
        preflightBudget / (242201 / 185_000),
      );
      expect(capturedTargetTokens!).toBe(expectedCorrectedTarget);

      // Should recover without conversation_error
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
      expect(calls.length).toBe(2);
    },
  );

  // ── Test 4 ────────────────────────────────────────────────────────
  // A realistic 75+ message conversation with many tool calls where
  // token estimation underestimates. This test should PASS against
  // current code because the agent loop returns same-length history
  // (no progress), so the convergence loop kicks in.
  test.todo(
    "overflow recovery succeeds for 75+ message conversation with many tool calls",
    async () => {
      const events: ServerMessage[] = [];
      const longHistory = buildLongConversation(75);
      let reducerCalled = false;

      // Estimator says ~195k — just above budget so preflight reducer runs
      mockEstimateTokens = 195_000;

      // Reducer reduces to under budget
      mockReducerStepFn = (msgs: Message[]) => {
        reducerCalled = true;
        return {
          messages: msgs.slice(-10), // Keep only last 10 messages
          tier: "forced_compaction",
          state: {
            appliedTiers: ["forced_compaction"],
            injectionMode: "full",
            exhausted: false,
          },
          estimatedTokens: 50_000,
          compactionResult: {
            compacted: true,
            messages: msgs.slice(-10),
            compactedPersistedMessages: msgs.length - 10,
            summaryText: "Long conversation summary",
            previousEstimatedInputTokens: 195_000,
            estimatedInputTokens: 50_000,
            maxInputTokens: 200_000,
            thresholdTokens: 160_000,
            compactedMessages: msgs.length - 10,
            summaryCalls: 2,
            summaryInputTokens: 2000,
            summaryOutputTokens: 500,
            summaryModel: "mock-model",
          },
        };
      };

      // After the preflight reducer compacts the long history under budget,
      // a single provider call completes the turn with plain text.
      const { provider, calls } = createMockProvider([
        textResponse("Here's the analysis..."),
      ]);

      const ctx = makeCtx({
        loopProvider: provider,
        messages: longHistory,
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as Conversation["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "analyze this", "msg-1", (msg) =>
        events.push(msg),
      );

      // Preflight should trigger the reducer since 195k > 190k budget
      expect(reducerCalled).toBe(true);
      // Should succeed
      expect(calls.length).toBe(1);
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    },
  );

  // ── Test 5 ────────────────────────────────────────────────────────
  // BUG: When all 4 reducer tiers have been applied, then the agent
  // makes progress and context_too_large fires again, no emergency
  // compaction is attempted. The `else if` at line 1163 just surfaces
  // the error.
  //
  // Expected behavior (PR 2 fix): Even after all tiers are exhausted,
  // if progress was made, attempt emergency compaction with
  // `minKeepRecentUserTurns: 0` as a last resort.
  test.todo(
    "exhausted reducer tiers with progress still attempts emergency compaction",
    async () => {
      const events: ServerMessage[] = [];
      let emergencyCompactCalled = false;

      // Start with reducer already exhausted
      mockReducerStepFn = (msgs: Message[]) => {
        return {
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
          estimatedTokens: 195_000,
        };
      };

      // Run 1 makes progress (a tool turn) then the following provider call
      // rejects with context_too_large; after emergency compaction the rerun
      // recovers with plain text.
      const { provider } = createMockProvider([
        toolUseResponse("tu-1", "bash", { command: "find . -name '*.ts'" }),
        new Error("context_length_exceeded"),
        textResponse("recovered"),
      ]);

      const ctx = makeCtx({
        loopProvider: provider,
        loopTools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        ],
        toolExecutor: async () => ({
          content: "file1.ts\nfile2.ts\nfile3.ts",
          isError: false,
        }),
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async (
            _msgs: Message[],
            _signal: AbortSignal,
            opts?: Record<string, unknown>,
          ) => {
            if (opts?.force && opts?.minKeepRecentUserTurns === 0) {
              emergencyCompactCalled = true;
              return {
                compacted: true,
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text: "Hello" }],
                  },
                ] as Message[],
                compactedPersistedMessages: 50,
                summaryText: "Emergency summary",
                previousEstimatedInputTokens: 195_000,
                estimatedInputTokens: 50_000,
                maxInputTokens: 200_000,
                thresholdTokens: 160_000,
                compactedMessages: 50,
                summaryCalls: 1,
                summaryInputTokens: 1000,
                summaryOutputTokens: 300,
                summaryModel: "mock-model",
              };
            }
            return { compacted: false };
          },
        } as unknown as Conversation["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // BUG: Currently when progress was made + all tiers exhausted,
      // emergency compaction is NOT attempted. The error is surfaced directly.
      // After PR 2 fix, emergency compaction should be attempted.
      expect(emergencyCompactCalled).toBe(true);

      // BUG: Currently a conversation_error IS emitted.
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
    },
  );

  // ── Test 6 ────────────────────────────────────────────────────────
  // Tests mid-loop budget check via onCheckpoint.
  // The onCheckpoint callback estimates prompt tokens after each tool round.
  // When estimate exceeds the mid-loop threshold (85% of budget),
  // it returns "yield" to break the agent loop.
  // The session-agent-loop then runs compaction and re-enters the agent loop.
  test.todo(
    "onCheckpoint yields when token estimate exceeds mid-loop budget threshold",
    async () => {
      const events: ServerMessage[] = [];
      let compactionCalled = false;

      // estimatePromptTokens is called:
      // 1. During preflight budget check (low value, below budget)
      // 2. During onCheckpoint mid-loop check (high value, above 85% threshold)
      // Budget = 200_000 * 0.95 = 190_000
      // Mid-loop threshold = 190_000 * 0.85 = 161_500
      let estimateCallCount = 0;
      mockEstimateTokens = () => {
        estimateCallCount++;
        // First call: preflight check — below budget
        if (estimateCallCount === 1) return 100_000;
        // Subsequent calls: mid-loop check — above 85% threshold
        return 170_000;
      };

      // A tool round trips the mid-loop budget gate (170k > 161_500); the
      // gate compacts in place (productive) and the loop continues, so the
      // post-compaction provider call completes the turn with plain text.
      const { provider, calls } = createMockProvider([
        toolUseResponse("tu-1", "bash", { command: "ls" }),
        textResponse("done after compaction"),
      ]);

      const ctx = makeCtx({
        loopProvider: provider,
        loopTools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        ],
        toolExecutor: async () => ({
          content: "file1.ts\nfile2.ts",
          isError: false,
        }),
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => {
            compactionCalled = true;
            return {
              compacted: true,
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text", text: "Hello" }],
                },
              ] as Message[],
              compactedPersistedMessages: 5,
              summaryText: "Mid-loop compaction summary",
              previousEstimatedInputTokens: 170_000,
              estimatedInputTokens: 80_000,
              maxInputTokens: 200_000,
              thresholdTokens: 160_000,
              compactedMessages: 10,
              summaryCalls: 1,
              summaryInputTokens: 500,
              summaryOutputTokens: 200,
              summaryModel: "mock-model",
            };
          },
        } as unknown as Conversation["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // The mid-loop budget check should have triggered compaction
      expect(compactionCalled).toBe(true);

      // Provider called twice: the tool turn that tripped the gate, then the
      // post-compaction turn that completed the run.
      expect(calls.length).toBe(2);

      // No conversation_error should be emitted
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();

      // A context_compacted event should have been emitted
      const compacted = events.find((e) => e.type === "context_compacted");
      expect(compacted).toBeDefined();
    },
  );

  // ── Test 7 ────────────────────────────────────────────────────────
  // Tests that mid-loop budget check prevents context_too_large entirely.
  // Agent loop runs tool calls with growing history. After the estimate
  // exceeds the mid-loop threshold, the loop yields, compaction runs,
  // and the loop resumes. The provider NEVER rejects with context_too_large.
  test.todo(
    "mid-loop budget check prevents context_too_large when tools produce large results",
    async () => {
      const events: ServerMessage[] = [];
      let compactionCalled = false;

      // Budget = 200_000 * 0.95 = 190_000
      // Mid-loop threshold = 190_000 * 0.85 = 161_500
      // Simulate token growth: preflight = 50k, then each checkpoint call
      // returns a growing estimate. By tool call 3, we exceed the threshold.
      let estimateCallCount = 0;
      mockEstimateTokens = () => {
        estimateCallCount++;
        // First call: preflight — well below budget
        if (estimateCallCount === 1) return 50_000;
        // Checkpoint calls grow with each tool round
        if (estimateCallCount === 2) return 100_000; // tool 1
        if (estimateCallCount === 3) return 140_000; // tool 2
        // Tool 3: exceeds 161_500 threshold
        return 175_000;
      };

      let contextTooLargeEmitted = false;

      // Each tool round produces a large result; the estimate grows with each
      // checkpoint until tool round 3 trips the mid-loop gate (175k > 161_500).
      // Compaction runs in place (productive) and the loop continues, so the
      // following plain-text provider call completes the turn. The provider
      // never rejects with context_too_large.
      const { provider, calls } = createMockProvider([
        toolUseResponse("tu-0", "bash", { command: "cmd-0" }),
        toolUseResponse("tu-1", "bash", { command: "cmd-1" }),
        toolUseResponse("tu-2", "bash", { command: "cmd-2" }),
        textResponse("completed after mid-loop compaction"),
      ]);

      const ctx = makeCtx({
        loopProvider: provider,
        loopTools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        ],
        toolExecutor: async () => ({
          content: "x".repeat(10_000),
          isError: false,
        }),
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => {
            compactionCalled = true;
            return {
              compacted: true,
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text", text: "Hello" }],
                },
              ] as Message[],
              compactedPersistedMessages: 8,
              summaryText: "Compacted large tool results",
              previousEstimatedInputTokens: 175_000,
              estimatedInputTokens: 60_000,
              maxInputTokens: 200_000,
              thresholdTokens: 160_000,
              compactedMessages: 15,
              summaryCalls: 1,
              summaryInputTokens: 800,
              summaryOutputTokens: 300,
              summaryModel: "mock-model",
            };
          },
        } as unknown as Conversation["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => {
        events.push(msg);
        // Track if context_too_large was ever emitted
        if (
          msg.type === "conversation_error" &&
          "code" in msg &&
          msg.code === "CONVERSATION_PROCESSING_FAILED"
        ) {
          contextTooLargeEmitted = true;
        }
      });

      // Compaction should have been triggered by mid-loop budget check
      expect(compactionCalled).toBe(true);

      // The provider should NEVER have rejected with context_too_large
      expect(contextTooLargeEmitted).toBe(false);

      // Provider called four times: three tool rounds (the third trips the
      // mid-loop gate) plus the post-compaction text turn that completes.
      expect(calls.length).toBe(4);

      // No conversation_error
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();
    },
  );

  // ── Test 8 ────────────────────────────────────────────────────────
  // When mid-loop compaction exhausts maxAttempts but the agent loop
  // still yields (yieldedForBudget remains true), the incomplete turn
  // must escalate to the convergence loop instead of being silently
  // treated as a completed turn.
  test("exhausted mid-loop compaction attempts escalate to convergence loop", async () => {
    const events: ServerMessage[] = [];

    // Budget = 200_000 * 0.95 = 190_000
    // Mid-loop threshold = 190_000 * 0.85 = 161_500
    // Every estimate is above the threshold, so the first-call gate compacts
    // before the first provider call and every checkpoint trips the yield.
    mockEstimateTokens = 170_000;

    // The convergence reducer reduces tokens enough for the rerun to recover.
    let convergenceReducerCalled = false;
    mockReducerStepFn = (msgs: Message[]) => {
      convergenceReducerCalled = true;
      return {
        messages: msgs,
        tier: "forced_compaction",
        state: {
          appliedTiers: ["forced_compaction"],
          injectionMode: "full",
          exhausted: true,
        },
        estimatedTokens: 80_000,
      };
    };

    // Every provider call returns a tool_use, so each loop run does a tool
    // turn that trips the mid-loop budget gate. On the initial run the gate
    // calls compaction (which surfaces `exhausted: true`); the convergence
    // rerun runs without a compaction hook and yields "budget" directly.
    // With the reducer exhausted, the convergence loop terminates with the
    // turn still over budget and the orchestrator stamps `context_too_large`.
    const { provider, calls } = createMockProvider([
      toolUseResponse("tu-1", "bash", { command: "ls" }),
    ]);

    let compactionCallCount = 0;
    const ctx = makeCtx({
      loopProvider: provider,
      loopTools: [
        {
          name: "bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      ],
      toolExecutor: async () => ({ content: "output", isError: false }),
      contextWindowManager: {
        updateConfig: () => {},
        shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
        maybeCompact: async () => {
          compactionCallCount++;
          // Compaction's internal retry budget is exhausted — the
          // compactor itself ran maxAttempts passes and still couldn't
          // drop below the auto-threshold. `maybeCompact` surfaces this
          // via `exhausted: true` so the loop yields "budget" and the
          // orchestrator escalates straight to the convergence loop
          // instead of looping on a stuck compactor.
          return {
            compacted: true,
            exhausted: true,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text", text: "Hello" }],
              },
            ] as Message[],
            compactedPersistedMessages: 5,
            summaryText: "Compaction summary",
            previousEstimatedInputTokens: 170_000,
            estimatedInputTokens: 165_000, // barely reduced
            maxInputTokens: 200_000,
            thresholdTokens: 160_000,
            compactedMessages: 10,
            summaryCalls: 1,
            summaryInputTokens: 500,
            summaryOutputTokens: 200,
            summaryModel: "mock-model",
          };
        },
      } as unknown as Conversation["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // 1 initial auto-compact + 1 mid-loop compaction = 2 total. The
    // first mid-loop call surfaces `exhausted: true`, so the
    // orchestrator escalates immediately without retrying maybeCompact
    // — the retry budget for the compactor itself lives inside
    // `ContextWindowManager.maybeCompact`.
    expect(compactionCallCount).toBe(2);

    // Provider calls: 1 initial tool turn (yields budget) + 1 convergence
    // rerun that recovers. No mid-loop re-entries because the orchestrator
    // broke out on `exhausted` before re-invoking the loop.
    expect(calls.length).toBe(2);

    // After the compactor exhausted itself, the convergence loop
    // should have been triggered (contextTooLargeDetected set to true)
    expect(convergenceReducerCalled).toBe(true);
    expect(setAgentLoopExitReasonOnLatestLogMock).toHaveBeenCalledWith(
      "test-conv",
      "context_too_large",
    );
  });

  // ── Test 8b ───────────────────────────────────────────────────────
  // Counterpart to Test 8: when a mid-loop `maybeCompact` returns
  // productive (`compacted: true`, no `exhausted` flag), the loop
  // compacts in place and continues the run itself — it never yields
  // "budget", so the orchestrator does not escalate to the convergence
  // loop. Mid-loop iteration is now wholly internal to `AgentLoop.run`;
  // the orchestrator only reacts to the binary `exhausted`/timeout
  // signal carried back as a "budget" exit.
  test("productive mid-loop compaction continues in place without escalating", async () => {
    const events: ServerMessage[] = [];

    // Budget = 200_000 * 0.95 = 190_000
    // Mid-loop threshold = 190_000 * 0.85 = 161_500
    // Every estimate is above the threshold: the first-call gate compacts
    // before the first provider call, and each subsequent checkpoint trips
    // the yield even after a successful compaction (each tool result inflates
    // the context back past 85%).
    mockEstimateTokens = 170_000;

    // A single tool round reaches one checkpoint; the in-loop budget gate
    // trips there and compaction runs in place. The loop continues the run
    // itself — the following provider call returns plain text and the turn
    // completes — so the orchestrator never re-enters the convergence loop.
    const { provider, calls } = createMockProvider([
      toolUseResponse("tu-1", "bash", { command: "ls" }),
      textResponse("final answer"),
    ]);

    // Compaction reports `estimatedInputTokens` well below the 161_500
    // threshold — the "compaction is productive" signal (no `exhausted`
    // flag) that lets the loop continue in place.
    let compactionCallCount = 0;
    const ctx = makeCtx({
      loopProvider: provider,
      loopTools: [
        {
          name: "bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      ],
      toolExecutor: async () => ({ content: "output", isError: false }),
      contextWindowManager: {
        updateConfig: () => {},
        shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
        maybeCompact: async () => {
          compactionCallCount++;
          return {
            compacted: true,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text", text: "Hello" }],
              },
            ] as Message[],
            compactedPersistedMessages: 5,
            summaryText: "Compaction summary",
            previousEstimatedInputTokens: 170_000,
            estimatedInputTokens: 100_000,
            maxInputTokens: 200_000,
            thresholdTokens: 160_000,
            compactedMessages: 10,
            summaryCalls: 1,
            summaryInputTokens: 500,
            summaryOutputTokens: 200,
            summaryModel: "mock-model",
          };
        },
      } as unknown as Conversation["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // 1 initial auto-compact + 1 productive mid-loop compaction.
    expect(compactionCallCount).toBe(2);
    // The loop continued in place after compacting: a tool turn followed by
    // the post-compaction text turn, both within a single run.
    expect(calls.length).toBe(2);

    // No escalation to the convergence loop because the mid-loop
    // `maybeCompact` returned productive (no `exhausted` flag), and the turn
    // completed normally.
    expect(setAgentLoopExitReasonOnLatestLogMock).not.toHaveBeenCalledWith(
      "test-conv",
      "context_too_large",
    );
    expect(events.find((e) => e.type === "conversation_error")).toBeUndefined();
  });

  // ── Test 9 ────────────────────────────────────────────────────────
  // When the convergence loop reruns the agent loop and it still yields
  // at checkpoint (yieldedForBudget), the loop must continue reducing
  // through additional tiers instead of silently dropping the incomplete
  // turn.
  test("post-convergence yieldedForBudget continues reduction", async () => {
    const events: ServerMessage[] = [];

    // Budget = 200_000 * 0.95 = 190_000
    // Mid-loop threshold = 190_000 * 0.85 = 161_500
    let estimateCallCount = 0;
    mockEstimateTokens = () => {
      estimateCallCount++;
      // Preflight: below budget
      if (estimateCallCount === 1) return 100_000;
      // Every checkpoint call: above threshold — always triggers yield
      return 170_000;
    };

    // Every provider call returns a tool_use, so each loop run does a tool
    // turn that trips the mid-loop budget gate and yields "budget". The
    // initial run's gate calls compaction (exhausted); the convergence
    // reruns run without a compaction hook and yield directly.
    const { provider, calls } = createMockProvider([
      toolUseResponse("tu-1", "bash", { command: "ls" }),
    ]);

    // Convergence reducer: first call returns non-exhausted, second returns exhausted
    let reducerCallCount = 0;
    mockReducerStepFn = (msgs: Message[]) => {
      reducerCallCount++;
      if (reducerCallCount === 1) {
        return {
          messages: msgs,
          tier: "forced_compaction",
          state: {
            appliedTiers: ["forced_compaction"],
            injectionMode: "full",
            exhausted: false,
          },
          estimatedTokens: 80_000,
        };
      }
      // Second call: exhausted
      return {
        messages: msgs,
        tier: "tool_result_truncation",
        state: {
          appliedTiers: ["forced_compaction", "tool_result_truncation"],
          injectionMode: "full",
          exhausted: true,
        },
        estimatedTokens: 60_000,
      };
    };

    const ctx = makeCtx({
      loopProvider: provider,
      loopTools: [
        {
          name: "bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      ],
      toolExecutor: async () => ({ content: "output", isError: false }),
      contextWindowManager: {
        updateConfig: () => {},
        shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
        // Under the new architecture (Compaction Re-homing Arc, Bullet 1)
        // the retry budget lives inside `ContextWindowManager._maybeCompact`,
        // so a single daemon-level call represents the full manager retry
        // sequence. Signal `exhausted: true` immediately to escalate the
        // mid-loop to the convergence reducer.
        maybeCompact: async () => ({
          compacted: true,
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text", text: "Hello" }],
            },
          ] as Message[],
          compactedPersistedMessages: 5,
          summaryText: "Compaction summary",
          previousEstimatedInputTokens: 170_000,
          estimatedInputTokens: 165_000,
          maxInputTokens: 200_000,
          thresholdTokens: 160_000,
          compactedMessages: 10,
          summaryCalls: 1,
          summaryInputTokens: 500,
          summaryOutputTokens: 200,
          summaryModel: "mock-model",
          exhausted: true,
        }),
      } as unknown as Conversation["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // Reducer should have been called twice: once for first convergence tier,
    // once more after yieldedForBudget triggered re-entry
    expect(reducerCallCount).toBe(2);

    // Provider calls: 1 initial run + 2 convergence reruns = 3 calls, each a
    // tool turn that yields "budget". The mid-loop no longer drives
    // daemon-level retries — the manager owns its retry budget and signals
    // exhaustion via the `exhausted` flag.
    expect(calls.length).toBe(3);
    expect(setAgentLoopExitReasonOnLatestLogMock).toHaveBeenCalledWith(
      "test-conv",
      "context_too_large",
    );
  });

  // ── Test 9 ────────────────────────────────────────────────────────
  // When the `auto_compress_latest_turn` rerun (the last layer of the
  // overflow-recovery ladder) still yields at the mid-loop checkpoint,
  // the turn cannot proceed. Before PR 1 of the Compaction Visibility
  // workstream this terminated silently — no `agent_loop_exit_reason`,
  // no client notice, no durable transcript row. Now the loop must:
  //   1. emit a `conversation_error` event with code
  //      `BUDGET_YIELD_UNRECOVERED`,
  //   2. persist a `role="assistant"` notice via the persistence
  //      pipeline (so reloads keep the message),
  //   3. stamp `budget_yield_unrecovered` onto the latest llm_request_logs
  //      row.
  test("budget_yield_unrecovered: classified error emitted, persisted, and stamped", async () => {
    const events: ServerMessage[] = [];

    // Every estimate after the very first preflight is above the mid-loop
    // threshold (190_000 × 0.85 = 161_500). This makes every checkpoint
    // yield, including the one inside the auto_compress rerun.
    let estimateCallCount = 0;
    mockEstimateTokens = () => {
      estimateCallCount++;
      if (estimateCallCount === 1) return 100_000;
      return 170_000;
    };

    // The reduction ladder applies a middle tier first, then escalates to its
    // terminal auto-compress-latest-turn rung and reports exhaustion. The
    // terminal rung is what produces a `budget_yield_unrecovered` outcome when
    // its rerun still yields at the mid-loop checkpoint.
    let reducerCallCount = 0;
    mockReducerStepFn = (msgs: Message[]) => {
      reducerCallCount++;
      const terminal = reducerCallCount >= 2;
      return {
        messages: msgs,
        tier: terminal ? "auto_compress_latest_turn" : "forced_compaction",
        state: {
          appliedTiers: terminal
            ? ["forced_compaction", "auto_compress_latest_turn"]
            : ["forced_compaction"],
          injectionMode: "full" as const,
          exhausted: terminal,
        },
        estimatedTokens: terminal ? 60_000 : 80_000,
      };
    };

    // The overflow policy permits the terminal auto-compress-latest-turn rung,
    // so the ladder runs it as its final step.
    mockOverflowAction = "auto_compress_latest_turn";

    // Every provider call returns a tool_use, so each loop run does a tool
    // turn that trips the mid-loop budget gate and yields "budget" —
    // including the final auto_compress rerun.
    const { provider } = createMockProvider([
      toolUseResponse("tu-1", "bash", { command: "ls" }),
    ]);

    // Forced `maybeCompact` is invoked through the loop's own pre-call budget
    // gate at two call sites (the reduction-ladder rungs are mocked out, so
    // their summary calls don't reach this manager):
    //   1. First-call (turn-start) gate (`force: true`) — the loop owns the
    //      turn-start compaction. It succeeds, but the mocked estimate stays
    //      above the mid-loop threshold, so the turn proceeds and the mid-loop
    //      gate still trips on the next iteration.
    //   2. Mid-loop after the first tool turn (`force: true`) — must signal
    //      `exhausted: true` so the daemon escalates to the convergence
    //      reducer instead of looping forever.
    let forcedMaybeCompactCallCount = 0;
    const ctx = makeCtx({
      loopProvider: provider,
      loopTools: [
        {
          name: "bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      ],
      toolExecutor: async () => ({ content: "output", isError: false }),
      contextWindowManager: {
        updateConfig: () => {},
        shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
        maybeCompact: async (
          _msgs: Message[],
          _signal: AbortSignal,
          opts?: { force?: boolean },
        ) => {
          // Only forced compactions drive this test; any non-forced probe is
          // a no-op.
          if (!opts?.force) {
            return { compacted: false };
          }
          forcedMaybeCompactCallCount++;
          if (forcedMaybeCompactCallCount === 1) {
            // First-call (turn-start) gate: succeeds, but the mocked estimate
            // stays above the threshold so the turn proceeds to the call and
            // the mid-loop gate still trips next iteration.
            return {
              compacted: true,
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text", text: "turn-start compacted" }],
                },
              ] as Message[],
              compactedPersistedMessages: 5,
              summaryText: "Turn-start summary",
              previousEstimatedInputTokens: 170_000,
              estimatedInputTokens: 165_000,
              maxInputTokens: 200_000,
              thresholdTokens: 160_000,
              compactedMessages: 10,
              summaryCalls: 1,
              summaryInputTokens: 500,
              summaryOutputTokens: 200,
              summaryModel: "mock-model",
            };
          }
          if (forcedMaybeCompactCallCount === 2) {
            // Mid-loop call — the manager owns its own retry budget; signal
            // exhaustion to escalate to convergence.
            return {
              compacted: true,
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text", text: "mid-loop compacted" }],
                },
              ] as Message[],
              compactedPersistedMessages: 5,
              summaryText: "Mid-loop summary",
              previousEstimatedInputTokens: 170_000,
              estimatedInputTokens: 165_000,
              maxInputTokens: 200_000,
              thresholdTokens: 160_000,
              compactedMessages: 10,
              summaryCalls: 1,
              summaryInputTokens: 500,
              summaryOutputTokens: 200,
              summaryModel: "mock-model",
              exhausted: true,
            };
          }
          // Defensive fallback for any additional forced probe; the two gate
          // call sites above are the only ones this test exercises.
          return {
            compacted: true,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text", text: "compacted" }],
              },
            ] as Message[],
            compactedPersistedMessages: 5,
            summaryText: "Fallback summary",
            previousEstimatedInputTokens: 170_000,
            estimatedInputTokens: 90_000,
            maxInputTokens: 200_000,
            thresholdTokens: 160_000,
            compactedMessages: 10,
            summaryCalls: 1,
            summaryInputTokens: 500,
            summaryOutputTokens: 200,
            summaryModel: "mock-model",
          };
        },
      } as unknown as Conversation["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // The classified error is emitted to the client.
    const errorEvents = events.filter((e) => e.type === "conversation_error");
    expect(errorEvents).toHaveLength(1);
    const errorEvent = errorEvents[0];
    if (errorEvent && "code" in errorEvent) {
      expect(errorEvent.code).toBe("BUDGET_YIELD_UNRECOVERED");
      expect(errorEvent.retryable).toBe(true);
      expect(errorEvent.errorCategory).toBe("budget_yield_unrecovered");
    } else {
      throw new Error("conversation_error event missing `code` field");
    }

    // The exit reason is stamped onto the latest llm_request_logs row.
    expect(setAgentLoopExitReasonOnLatestLogMock).toHaveBeenCalledWith(
      "test-conv",
      "budget_yield_unrecovered",
    );

    // A `role="assistant"` notice is persisted via the persistence pipeline.
    // The default persistence terminal calls
    // `addMessage(conversationId, role, content, metadata, addOptions)` —
    // we look for the call whose role positional arg is "assistant" and
    // whose content positional arg mentions compaction.
    const assistantPersistCall = addMessageMock.mock.calls.find((call) => {
      const role = call[1];
      const content = call[2];
      return (
        role === "assistant" &&
        typeof content === "string" &&
        content.includes("compact")
      );
    });
    expect(assistantPersistCall).toBeDefined();
  });
});

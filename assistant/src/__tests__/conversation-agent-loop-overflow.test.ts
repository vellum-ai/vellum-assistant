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

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type {
  AgentEvent,
  AgentLoopRunOptions,
  AgentLoopRunResult,
  MidLoopCompaction,
} from "../agent/loop.js";
import type { LLMConfig } from "../config/schemas/llm.js";
import type { ContextWindowResult } from "../context/window-manager.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { defaultCompactionTerminal } from "../plugins/defaults/compaction/terminal.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import { getMiddlewaresFor } from "../plugins/registry.js";
import type {
  CompactionArgs,
  CompactionResult,
  TurnContext,
} from "../plugins/types.js";
import { PluginTimeoutError } from "../plugins/types.js";
import type { ContentBlock, Message } from "../providers/types.js";

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
// preflight overflow gate and the convergence path) and the raw entry point
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
  // The preflight overflow gate calls this calibrated wrapper directly, so it
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
  getConversationOverrideProfileFromRow: () => undefined,
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

import {
  type AgentLoopConversationContext,
  runAgentLoopImpl,
} from "../daemon/conversation-agent-loop.js";
import { stripInjectionsForCompaction } from "../daemon/conversation-runtime-assembly.js";

// ── Test helpers ─────────────────────────────────────────────────────

type AgentLoopRun = (
  messages: Message[],
  onEvent: (event: AgentEvent) => void,
  options?: AgentLoopRunOptions,
) => Promise<Message[]>;

/**
 * Faithful re-implementation of `AgentLoop.compact()` for the mock loop: run
 * the compaction pipeline against the supplied turn context (which carries the
 * test's `contextWindowManager`), invoke the orchestrator-supplied hooks, and
 * return the continuation history — or `null` on timeout/exhaustion so the
 * caller yields "budget".
 */
async function simulateInlineCompaction(
  compaction: MidLoopCompaction,
  history: Message[],
  turnContext: TurnContext | undefined,
  signal: AbortSignal | undefined,
  onEvent: (event: AgentEvent) => void | Promise<void>,
  compactionCircuit: CompactionCircuit,
  overrideProfile: string | null,
): Promise<Message[] | null> {
  await onEvent({ type: "context_compacting" });
  // The agent loop strips runtime injections (identity-stubbed in this suite),
  // records the history-stripped marker via `history_stripped`, then owns the
  // forced-compaction decision for its mid-loop budget gate: it sets `force`,
  // the turn actor's trust class, and the resolved inference-profile override
  // directly on the options bag before invoking the pipeline.
  const rawHistory = stripInjectionsForCompaction(history);
  await onEvent({ type: "history_stripped" });
  let result: CompactionResult;
  try {
    result = await runPipeline<CompactionArgs, CompactionResult>(
      "compaction",
      getMiddlewaresFor("compaction"),
      (args) => defaultCompactionTerminal(args, turnContext as TurnContext),
      {
        messages: rawHistory,
        signal,
        options: {
          force: true,
          actorTrustClass: turnContext?.trust.trustClass,
          overrideProfile,
        },
      },
      turnContext as TurnContext,
      DEFAULT_TIMEOUTS.compaction,
    );
  } catch (error) {
    if (error instanceof PluginTimeoutError) {
      await compactionCircuit.recordOutcome(
        {
          currentRequestId: turnContext?.requestId,
          currentTurnTrustContext: turnContext?.trust,
          turnCount: turnContext?.turnIndex ?? 0,
        },
        true,
        onEvent,
      );
      return null;
    }
    throw error;
  }
  const compactResult = result as ContextWindowResult;
  if (compactResult.summaryFailed !== undefined) {
    await compactionCircuit.recordOutcome(
      {
        currentRequestId: turnContext?.requestId,
        currentTurnTrustContext: turnContext?.trust,
        turnCount: turnContext?.turnIndex ?? 0,
      },
      compactResult.summaryFailed,
      onEvent,
    );
  }
  await onEvent({
    type: "compaction_completed",
    result: compactResult,
    basis: rawHistory,
  });
  if (compactResult.exhausted ?? false) {
    return null;
  }
  return compaction.reinject();
}

/**
 * Adapt a `Message[]`-returning mock loop body into `run()`'s real result
 * shape. Mirrors the production loop: the pause-reason carried back is
 * whatever the most recent `onCheckpoint` call yielded with (null when it
 * never yielded), so the orchestrator derives its yield bookkeeping the same
 * way it does against the real loop.
 */
const asAgentLoopRun = (
  fn: AgentLoopRun,
  compactionCircuit: CompactionCircuit,
): ((
  messages: Message[],
  onEvent: (event: AgentEvent) => void | Promise<void>,
  options?: AgentLoopRunOptions,
) => Promise<AgentLoopRunResult>) => {
  return async (messages, onEvent, options) => {
    let exitReason: AgentLoopRunResult["exitReason"] = null;
    let wrapped = options;
    if (options?.onCheckpoint) {
      const inner = options.onCheckpoint;
      wrapped = {
        ...options,
        onCheckpoint: async (info) => {
          // Handoff is offered first, mirroring the loop's ordering.
          const decision = await inner(info);
          if (decision !== "continue") {
            exitReason = decision;
            return decision;
          }
          // The mid-loop budget gate and inline compaction both live inside
          // `AgentLoop.run`. Replicate them here — same formula, stubbed
          // estimator, and the loop's own `compact()` ceremony — so these
          // orchestrator tests drive the real escalation path now that the
          // orchestrator's `onCheckpoint` is handoff-only and compaction
          // runs inline rather than via an orchestrator re-entry loop.
          const contextWindow = options.resolveContextWindow?.();
          if (contextWindow?.overflowRecovery.enabled) {
            const { maxInputTokens, overflowRecovery } = contextWindow;
            const safetyMargin =
              info.history.length > 50
                ? Math.max(overflowRecovery.safetyMarginRatio, 0.15)
                : overflowRecovery.safetyMarginRatio;
            const preflightBudget = Math.floor(
              maxInputTokens * (1 - safetyMargin),
            );
            const estimated =
              typeof mockEstimateTokens === "function"
                ? mockEstimateTokens(info.history)
                : mockEstimateTokens;
            if (estimated > preflightBudget * 0.85) {
              // Mirror `AgentLoop.compact()`: when a compaction path is
              // supplied, run it in place and continue; on timeout or
              // exhaustion it returns null, so the loop yields "budget".
              const compacted = options.compaction
                ? await simulateInlineCompaction(
                    options.compaction,
                    info.history,
                    options.turnContext,
                    options.signal,
                    onEvent,
                    compactionCircuit,
                    options.resolveOverrideProfile?.() ??
                      options.overrideProfile ??
                      null,
                  )
                : null;
              if (compacted) {
                exitReason = null;
                return "continue";
              }
              exitReason = "budget";
              return "budget";
            }
          }
          exitReason = null;
          return "continue";
        },
      };
    }
    const history = await fn(messages, onEvent, wrapped);
    // Mirror the loop's forward-progress signal: it sets `appendedNewMessages`
    // when it pushes a new assistant message, which for these mock bodies (that
    // never return a compaction-shrunk history) means the returned history grew
    // past the input.
    const appendedNewMessages = history.length > messages.length;
    return { history, exitReason, appendedNewMessages };
  };
};

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

  const compactionCircuit = new CompactionCircuit("test-conv");

  return {
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

    agentLoop: {
      run: asAgentLoopRun(agentLoopRun, compactionCircuit),
      getToolTokenBudget: () => 0,
      getResolvedTools: () => [],
      // Tests in this file don't exercise calibration, so returning
      // undefined is fine — the estimator falls back to the per-provider
      // aggregate key.
      getActiveModel: () => undefined,
      compactionCircuit,
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
  // Reset the plugin registry and re-register every default so the
  // orchestrator's pipelines (`overflowReduce`, `persistence`, …) dispatch to
  // the default middleware, which in turn hits the mocked collaborators
  // (`reduceContextOverflow`, `syncMessageToDisk`, …) these tests install.
  resetPluginRegistryAndRegisterDefaults();
});

describe("session-agent-loop overflow recovery (JARVIS-110)", () => {
  test("usage update context max follows active main-agent profile budget", async () => {
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

    const ctx = makeCtx({
      agentLoopRun: async (messages, onEvent) => {
        onEvent({
          type: "usage",
          inputTokens: 12_000,
          outputTokens: 300,
          model: "mock-model",
          providerDurationMs: 25,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "response" }],
          },
        ];
      },
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

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
  // before hitting context_too_large, the convergence loop at line 864
  // checks `updatedHistory.length === preRunHistoryLength` which is
  // false when progress was made. This means the reducer is never
  // invoked — the error is surfaced immediately at line 1163-1175
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

      let agentLoopCallCount = 0;
      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        agentLoopCallCount++;
        if (agentLoopCallCount === 1) {
          // Simulate: agent makes progress (tool calls + results added)
          // then hits context_too_large on next LLM call
          const progressMessages: Message[] = [
            ...messages,
            {
              role: "assistant" as const,
              content: [
                { type: "text", text: "Let me check that." },
                {
                  type: "tool_use",
                  id: "tu-progress",
                  name: "bash",
                  input: { command: "ls" },
                },
              ] as ContentBlock[],
            },
            {
              role: "user" as const,
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-progress",
                  content: "file1.ts\nfile2.ts",
                  is_error: false,
                },
              ] as ContentBlock[],
            },
          ];

          // Emit events for the progress that was made
          onEvent({
            type: "tool_use",
            id: "tu-progress",
            name: "bash",
            input: { command: "ls" },
          });
          onEvent({
            type: "tool_result",
            toolUseId: "tu-progress",
            content: "file1.ts\nfile2.ts",
            isError: false,
          });
          onEvent({
            type: "message_complete",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Let me check that." },
                {
                  type: "tool_use",
                  id: "tu-progress",
                  name: "bash",
                  input: { command: "ls" },
                },
              ],
            },
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 50,
            model: "test-model",
            providerDurationMs: 100,
          });

          // Then context_too_large error occurs on the *next* LLM call
          onEvent({
            type: "error",
            error: new Error(
              "prompt is too long: 242201 tokens > 200000 maximum",
            ),
          });
          onEvent({
            type: "usage",
            inputTokens: 0,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 10,
          });

          // Return the history WITH progress (more messages than input)
          return progressMessages;
        }

        // Second call (after compaction): succeed
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered after compaction" }],
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
              { type: "text", text: "recovered after compaction" },
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
    let callCount = 0;
    let reducerCalled = false;

    // Estimator says 185k (below 190k budget = 200k * 0.95)
    mockEstimateTokens = 185_000;

    // Reducer successfully compacts
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

    const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
      // Prime the assistant row anchor — production code emits this from
      // `AgentLoop.run` just before `provider.sendMessage`.
      await onEvent({ type: "llm_call_started" });
      callCount++;
      if (callCount === 1) {
        // Provider rejects with "prompt is too long: 242201 tokens > 200000"
        // even though estimator said 185k
        onEvent({
          type: "error",
          error: new Error(
            "prompt is too long: 242201 tokens > 200000 maximum",
          ),
        });
        onEvent({
          type: "usage",
          inputTokens: 0,
          outputTokens: 0,
          model: "test-model",
          providerDurationMs: 10,
        });
        // No progress — return same messages
        return messages;
      }
      // Second call succeeds
      onEvent({
        type: "message_complete",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
        },
      });
      onEvent({
        type: "usage",
        inputTokens: 80_000,
        outputTokens: 200,
        model: "test-model",
        providerDurationMs: 500,
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

    // The reducer should be called in the convergence loop
    expect(reducerCalled).toBe(true);
    // Should recover without conversation_error
    const conversationError = events.find(
      (e) => e.type === "conversation_error",
    );
    expect(conversationError).toBeUndefined();
    expect(callCount).toBe(2);
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
      let callCount = 0;
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

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        callCount++;
        if (callCount === 1) {
          // Provider rejects: actual tokens 242201, way above estimate of 185k
          onEvent({
            type: "error",
            error: new Error(
              "prompt is too long: 242201 tokens > 200000 maximum",
            ),
          });
          onEvent({
            type: "usage",
            inputTokens: 0,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 10,
          });
          // No progress — return same messages
          return messages;
        }
        // Second call succeeds after compaction
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 80_000,
          outputTokens: 200,
          model: "test-model",
          providerDurationMs: 500,
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
      expect(callCount).toBe(2);
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
      let callCount = 0;
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

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        callCount++;
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Here's the analysis..." }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50_000,
          outputTokens: 300,
          model: "test-model",
          providerDurationMs: 800,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [
              { type: "text", text: "Here's the analysis..." },
            ] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        messages: longHistory,
        contextWindowManager: {
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "analyze this", "msg-1", (msg) =>
        events.push(msg),
      );

      // Preflight should trigger the reducer since 195k > 190k budget
      expect(reducerCalled).toBe(true);
      // Should succeed
      expect(callCount).toBe(1);
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

      let agentLoopCallCount = 0;
      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        agentLoopCallCount++;
        if (agentLoopCallCount === 1) {
          // Agent makes progress (tool calls succeed, messages grow)
          const progressMessages: Message[] = [
            ...messages,
            {
              role: "assistant" as const,
              content: [
                { type: "text", text: "Running analysis..." },
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "bash",
                  input: { command: "find . -name '*.ts'" },
                },
              ] as ContentBlock[],
            },
            {
              role: "user" as const,
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-1",
                  content: "file1.ts\nfile2.ts\nfile3.ts",
                  is_error: false,
                },
              ] as ContentBlock[],
            },
          ];

          onEvent({
            type: "tool_use",
            id: "tu-1",
            name: "bash",
            input: { command: "find . -name '*.ts'" },
          });
          onEvent({
            type: "tool_result",
            toolUseId: "tu-1",
            content: "file1.ts\nfile2.ts\nfile3.ts",
            isError: false,
          });
          onEvent({
            type: "message_complete",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Running analysis..." },
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "bash",
                  input: { command: "find . -name '*.ts'" },
                },
              ],
            },
          });
          onEvent({
            type: "usage",
            inputTokens: 190_000,
            outputTokens: 100,
            model: "test-model",
            providerDurationMs: 200,
          });

          // Then context_too_large on the next LLM call within the loop
          onEvent({
            type: "error",
            error: new Error("context_length_exceeded"),
          });
          onEvent({
            type: "usage",
            inputTokens: 0,
            outputTokens: 0,
            model: "test-model",
            providerDurationMs: 10,
          });

          return progressMessages;
        }

        // After emergency compaction, succeed
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "recovered" }],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 50_000,
          outputTokens: 100,
          model: "test-model",
          providerDurationMs: 200,
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
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
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

      let agentLoopCallCount = 0;
      const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        agentLoopCallCount++;

        if (agentLoopCallCount === 1) {
          // Simulate a tool round: assistant calls a tool, results come back
          const withProgress: Message[] = [
            ...messages,
            {
              role: "assistant" as const,
              content: [
                { type: "text", text: "Let me check." },
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "bash",
                  input: { command: "ls" },
                },
              ] as ContentBlock[],
            },
            {
              role: "user" as const,
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-1",
                  content: "file1.ts\nfile2.ts",
                  is_error: false,
                },
              ] as ContentBlock[],
            },
          ];

          onEvent({
            type: "message_complete",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Let me check." },
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "bash",
                  input: { command: "ls" },
                },
              ],
            },
          });
          onEvent({
            type: "usage",
            inputTokens: 100,
            outputTokens: 50,
            model: "test-model",
            providerDurationMs: 100,
          });

          // Call onCheckpoint — this should trigger the mid-loop budget check
          // which sees 170_000 > 161_500 and returns "yield"
          if (options?.onCheckpoint) {
            const decision = await options.onCheckpoint({
              turnIndex: 0,
              toolCount: 1,
              hasToolUse: true,
              history: withProgress,
            });
            if (decision !== "continue") {
              // Agent loop stops when checkpoint yields
              return withProgress;
            }
          }

          return withProgress;
        }

        // Second call (after compaction): complete successfully
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done after compaction" }],
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
              { type: "text", text: "done after compaction" },
            ] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
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
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // The mid-loop budget check should have triggered compaction
      expect(compactionCalled).toBe(true);

      // Agent loop should have been called twice: once before yield, once after compaction
      expect(agentLoopCallCount).toBe(2);

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

      let agentLoopCallCount = 0;
      let contextTooLargeEmitted = false;

      const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
        // Prime the assistant row anchor — production code emits this from
        // `AgentLoop.run` just before `provider.sendMessage`.
        await onEvent({ type: "llm_call_started" });
        agentLoopCallCount++;

        if (agentLoopCallCount === 1) {
          const currentHistory = [...messages];

          // Simulate 5 tool rounds — but the checkpoint should yield at round 3
          for (let i = 0; i < 5; i++) {
            const toolId = `tu-${i}`;
            const assistantMsg: Message = {
              role: "assistant" as const,
              content: [
                { type: "text", text: `Step ${i}` },
                {
                  type: "tool_use",
                  id: toolId,
                  name: "bash",
                  input: { command: `cmd-${i}` },
                },
              ] as ContentBlock[],
            };
            const resultMsg: Message = {
              role: "user" as const,
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolId,
                  content: "x".repeat(10_000),
                  is_error: false,
                },
              ] as ContentBlock[],
            };
            currentHistory.push(assistantMsg, resultMsg);

            onEvent({
              type: "message_complete",
              message: assistantMsg,
            });
            onEvent({
              type: "usage",
              inputTokens: 50_000 + i * 20_000,
              outputTokens: 50,
              model: "test-model",
              providerDurationMs: 100,
            });

            if (options?.onCheckpoint) {
              const decision = await options.onCheckpoint({
                turnIndex: i,
                toolCount: 1,
                hasToolUse: true,
                history: currentHistory,
              });
              if (decision !== "continue") {
                return currentHistory;
              }
            }
          }

          return currentHistory;
        }

        // Second call (after compaction): complete
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "completed after mid-loop compaction" },
            ],
          },
        });
        onEvent({
          type: "usage",
          inputTokens: 60_000,
          outputTokens: 100,
          model: "test-model",
          providerDurationMs: 200,
        });
        return [
          ...messages,
          {
            role: "assistant" as const,
            content: [
              { type: "text", text: "completed after mid-loop compaction" },
            ] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        contextWindowManager: {
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
        } as unknown as AgentLoopConversationContext["contextWindowManager"],
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

      // Agent loop called twice: once (yielded at tool 3), once after compaction
      expect(agentLoopCallCount).toBe(2);

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
    let estimateCallCount = 0;
    mockEstimateTokens = () => {
      estimateCallCount++;
      // Preflight: below budget
      if (estimateCallCount === 1) return 100_000;
      // Every checkpoint call: above threshold — always triggers yield
      return 170_000;
    };

    let agentLoopCallCount = 0;
    const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
      // Prime the assistant row anchor — production code emits this from
      // `AgentLoop.run` just before `provider.sendMessage`.
      await onEvent({ type: "llm_call_started" });
      agentLoopCallCount++;

      // Every call: simulate tool progress then yield at checkpoint
      const withProgress: Message[] = [
        ...messages,
        {
          role: "assistant" as const,
          content: [
            { type: "text", text: `Tool call ${agentLoopCallCount}` },
            {
              type: "tool_use",
              id: `tu-${agentLoopCallCount}`,
              name: "bash",
              input: { command: "ls" },
            },
          ] as ContentBlock[],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result",
              tool_use_id: `tu-${agentLoopCallCount}`,
              content: "output",
              is_error: false,
            },
          ] as ContentBlock[],
        },
      ];

      onEvent({
        type: "message_complete",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `Tool call ${agentLoopCallCount}` },
            {
              type: "tool_use",
              id: `tu-${agentLoopCallCount}`,
              name: "bash",
              input: { command: "ls" },
            },
          ],
        },
      });
      onEvent({
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
        providerDurationMs: 100,
      });

      // Always yield at checkpoint — simulates compaction not helping
      if (options?.onCheckpoint) {
        const decision = await options.onCheckpoint({
          turnIndex: 0,
          toolCount: 1,
          hasToolUse: true,
          history: withProgress,
        });
        if (decision !== "continue") {
          return withProgress;
        }
      }

      return withProgress;
    };

    let compactionCallCount = 0;
    // Convergence reducer: reduce tokens enough to succeed
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

    const ctx = makeCtx({
      agentLoopRun,
      contextWindowManager: {
        shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
        maybeCompact: async () => {
          compactionCallCount++;
          // Compaction's internal retry budget is exhausted — the
          // compactor itself ran maxAttempts passes and still couldn't
          // drop below the auto-threshold. `maybeCompact` surfaces this
          // via `exhausted: true` so the orchestrator escalates
          // straight to the convergence loop instead of looping on a
          // stuck compactor.
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
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // 1 initial auto-compact + 1 mid-loop compaction = 2 total. The
    // first mid-loop call surfaces `exhausted: true`, so the
    // orchestrator escalates immediately without retrying maybeCompact
    // — the retry budget for the compactor itself lives inside
    // `ContextWindowManager.maybeCompact`.
    expect(compactionCallCount).toBe(2);

    // Agent loop: 1 initial + 1 convergence re-run = 2 calls. No
    // mid-loop re-entries because the orchestrator broke out on
    // `exhausted` before re-invoking the agent loop.
    expect(agentLoopCallCount).toBe(2);

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
    let estimateCallCount = 0;
    mockEstimateTokens = () => {
      estimateCallCount++;
      // Preflight: below budget.
      if (estimateCallCount === 1) return 100_000;
      // Every checkpoint estimate: above threshold — always trips the
      // yield. Simulates a long turn where each tool call's result
      // inflates the context past 85% even after a successful compaction.
      return 170_000;
    };

    // A single tool round reaches one checkpoint; the in-loop budget
    // gate trips there and compaction runs in place. The loop continues
    // the run itself rather than handing control back, so the
    // orchestrator invokes `run()` exactly once.
    let agentLoopCallCount = 0;
    const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
      await onEvent({ type: "llm_call_started" });
      agentLoopCallCount++;

      const withProgress: Message[] = [
        ...messages,
        {
          role: "assistant" as const,
          content: [
            { type: "text", text: `Tool call ${agentLoopCallCount}` },
            {
              type: "tool_use",
              id: `tu-${agentLoopCallCount}`,
              name: "bash",
              input: { command: "ls" },
            },
          ] as ContentBlock[],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result",
              tool_use_id: `tu-${agentLoopCallCount}`,
              content: "output",
              is_error: false,
            },
          ] as ContentBlock[],
        },
      ];

      onEvent({
        type: "message_complete",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `Tool call ${agentLoopCallCount}` },
            {
              type: "tool_use",
              id: `tu-${agentLoopCallCount}`,
              name: "bash",
              input: { command: "ls" },
            },
          ],
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
          history: withProgress,
        });
      }

      return withProgress;
    };

    // Compaction reports `estimatedInputTokens` well below the 161_500
    // threshold — the "compaction is productive" signal (no `exhausted`
    // flag) that lets the loop continue in place.
    let compactionCallCount = 0;
    const ctx = makeCtx({
      agentLoopRun,
      contextWindowManager: {
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
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // 1 initial auto-compact + 1 productive mid-loop compaction. The
    // loop continues in place after compacting, so the orchestrator
    // never re-enters `run()` — it is invoked exactly once.
    expect(compactionCallCount).toBe(2);
    expect(agentLoopCallCount).toBe(1);

    // No escalation to the convergence loop because the mid-loop
    // `maybeCompact` returned productive (no `exhausted` flag).
    expect(setAgentLoopExitReasonOnLatestLogMock).not.toHaveBeenCalledWith(
      "test-conv",
      "context_too_large",
    );
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

    let agentLoopCallCount = 0;
    const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
      // Prime the assistant row anchor — production code emits this from
      // `AgentLoop.run` just before `provider.sendMessage`.
      await onEvent({ type: "llm_call_started" });
      agentLoopCallCount++;

      const withProgress: Message[] = [
        ...messages,
        {
          role: "assistant" as const,
          content: [
            { type: "text", text: `Tool call ${agentLoopCallCount}` },
            {
              type: "tool_use",
              id: `tu-${agentLoopCallCount}`,
              name: "bash",
              input: { command: "ls" },
            },
          ] as ContentBlock[],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result",
              tool_use_id: `tu-${agentLoopCallCount}`,
              content: "output",
              is_error: false,
            },
          ] as ContentBlock[],
        },
      ];

      onEvent({
        type: "message_complete",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `Tool call ${agentLoopCallCount}` },
            {
              type: "tool_use",
              id: `tu-${agentLoopCallCount}`,
              name: "bash",
              input: { command: "ls" },
            },
          ],
        },
      });
      onEvent({
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
        providerDurationMs: 100,
      });

      // Always yield at checkpoint — simulates reduction not helping enough
      if (options?.onCheckpoint) {
        const decision = await options.onCheckpoint({
          turnIndex: 0,
          toolCount: 1,
          hasToolUse: true,
          history: withProgress,
        });
        if (decision !== "continue") {
          return withProgress;
        }
      }

      return withProgress;
    };

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
      agentLoopRun,
      contextWindowManager: {
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
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // Reducer should have been called twice: once for first convergence tier,
    // once more after yieldedForBudget triggered re-entry
    expect(reducerCallCount).toBe(2);

    // Agent loop: 1 initial + 2 convergence re-runs = 3 calls. The mid-loop
    // no longer drives daemon-level retries — the manager owns its retry
    // budget and signals exhaustion via the `exhausted` flag.
    expect(agentLoopCallCount).toBe(3);
    expect(setAgentLoopExitReasonOnLatestLogMock).toHaveBeenCalledWith(
      "test-conv",
      "context_too_large",
    );
  });

  // ── Test 8 ────────────────────────────────────────────────────────
  // BUG: The preflight overflow reducer's budget check uses
  // step.estimatedTokens (computed on bare ctx.messages) without
  // accounting for tokens added by applyRuntimeInjections(). This
  // causes the reducer to stop early when the bare estimate is under
  // budget, even though post-injection tokens exceed it — leading to
  // a wasted provider round-trip that gets rejected.
  //
  // After fix: the budget check re-estimates on runMessages (with
  // injections) so the reducer continues to the next tier.
  test("preflight reducer continues when post-injection tokens exceed budget", async () => {
    const events: ServerMessage[] = [];

    // Injections add an extra message, bumping the token count.
    const injectionMessage: Message = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "injected context " + "x".repeat(500),
        },
      ],
    };
    mockApplyRuntimeInjections = (msgs) => [...msgs, injectionMessage];

    // Budget = 200_000 * 0.95 = 190_000
    // The estimator returns different values based on whether the
    // injection message is present:
    //   - bare history (no injection msg) → 195_000 (triggers preflight)
    //   - after tier 1 bare → 185_000 (under budget, would stop early without fix)
    //   - after tier 1 with injection → 195_000 (still over budget)
    //   - after tier 2 bare → 170_000
    //   - after tier 2 with injection → 175_000 (under budget, reducer stops)
    let reducerCallCount = 0;
    mockEstimateTokens = (msgs?: Message[]) => {
      const hasInjection = msgs?.some(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(
            (b: { type: string; text?: string }) =>
              b.type === "text" &&
              typeof b.text === "string" &&
              b.text.startsWith("injected context"),
          ),
      );
      if (reducerCallCount === 0) {
        // Before any reduction: preflight check on runMessages (with injection)
        return 195_000;
      }
      if (reducerCallCount === 1) {
        // After tier 1
        return hasInjection ? 195_000 : 185_000;
      }
      // After tier 2
      return hasInjection ? 175_000 : 170_000;
    };

    mockReducerStepFn = (msgs: Message[]) => {
      reducerCallCount++;
      const tier =
        reducerCallCount === 1 ? "forced_compaction" : "tool_result_truncation";
      return {
        messages: msgs,
        tier,
        state: {
          appliedTiers:
            reducerCallCount === 1
              ? ["forced_compaction"]
              : ["forced_compaction", "tool_result_truncation"],
          injectionMode: "full" as const,
          exhausted: reducerCallCount >= 2,
        },
        // Bare-history estimate (what the reducer sees on ctx.messages)
        estimatedTokens: reducerCallCount === 1 ? 185_000 : 170_000,
        compactionResult: {
          compacted: true,
          messages: msgs,
          compactedPersistedMessages: 5,
          summaryText: "Summary",
          previousEstimatedInputTokens: 195_000,
          estimatedInputTokens: reducerCallCount === 1 ? 185_000 : 170_000,
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

    const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
      // Prime the assistant row anchor — production code emits this from
      // `AgentLoop.run` just before `provider.sendMessage`.
      await onEvent({ type: "llm_call_started" });
      onEvent({
        type: "message_complete",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      });
      onEvent({
        type: "usage",
        inputTokens: 170_000,
        outputTokens: 200,
        model: "test-model",
        providerDurationMs: 500,
      });
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
      contextWindowManager: {
        shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
        maybeCompact: async () => ({ compacted: false }),
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // The reducer must be called twice — the first tier's bare estimate
    // (185k) is under budget (190k), but post-injection tokens (195k)
    // still exceed it. Without the fix, the reducer would stop after
    // tier 1 and the provider call would likely fail.
    expect(reducerCallCount).toBe(2);

    // Should succeed without errors
    const conversationError = events.find(
      (e) => e.type === "conversation_error",
    );
    expect(conversationError).toBeUndefined();
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

    // Convergence reducer becomes exhausted on the second tier so the
    // loop escalates from convergence to the action-resolution block.
    let reducerCallCount = 0;
    mockReducerStepFn = (msgs: Message[]) => {
      reducerCallCount++;
      const exhausted = reducerCallCount >= 2;
      return {
        messages: msgs,
        tier: exhausted ? "tool_result_truncation" : "forced_compaction",
        state: {
          appliedTiers: exhausted
            ? ["forced_compaction", "tool_result_truncation"]
            : ["forced_compaction"],
          injectionMode: "full" as const,
          exhausted,
        },
        estimatedTokens: exhausted ? 60_000 : 80_000,
      };
    };

    // The overflow policy directs us into auto_compress_latest_turn so the
    // emergency compaction + final agentLoop.run path executes.
    mockOverflowAction = "auto_compress_latest_turn";

    let agentLoopCallCount = 0;
    const agentLoopRun: AgentLoopRun = async (messages, onEvent, options) => {
      // Prime the assistant row anchor — production code emits this from
      // `AgentLoop.run` just before `provider.sendMessage`.
      await onEvent({ type: "llm_call_started" });
      agentLoopCallCount++;

      const withProgress: Message[] = [
        ...messages,
        {
          role: "assistant" as const,
          content: [
            { type: "text", text: `tool call ${agentLoopCallCount}` },
            {
              type: "tool_use",
              id: `tu-${agentLoopCallCount}`,
              name: "bash",
              input: { command: "ls" },
            },
          ] as ContentBlock[],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result",
              tool_use_id: `tu-${agentLoopCallCount}`,
              content: "output",
              is_error: false,
            },
          ] as ContentBlock[],
        },
      ];

      onEvent({
        type: "message_complete",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `tool call ${agentLoopCallCount}` },
            {
              type: "tool_use",
              id: `tu-${agentLoopCallCount}`,
              name: "bash",
              input: { command: "ls" },
            },
          ],
        },
      });
      onEvent({
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
        providerDurationMs: 100,
      });

      // Every checkpoint yields — including the final auto_compress rerun.
      if (options?.onCheckpoint) {
        const decision = await options.onCheckpoint({
          turnIndex: 0,
          toolCount: 1,
          hasToolUse: true,
          history: withProgress,
        });
        if (decision !== "continue") {
          return withProgress;
        }
      }

      return withProgress;
    };

    // `maybeCompact` is invoked through three distinct call sites:
    //   1. Start-of-turn compaction (no `force` option) — return a no-op
    //      so the start-of-turn pass doesn't perturb state. The mock's
    //      `shouldCompact` already returns `needed: false`, but the
    //      orchestrator still invokes the compaction pipeline.
    //   2. Mid-loop after the initial agent-loop yield (`force: true`) —
    //      must signal `exhausted: true` so the daemon escalates to the
    //      convergence reducer instead of looping forever.
    //   3. auto_compress_latest_turn emergency compaction (`force: true`,
    //      `minKeepRecentUserTurns: 0`) — succeeds and drops tokens below
    //      threshold; the subsequent rerun yields again and is classified
    //      as BUDGET_YIELD_UNRECOVERED.
    let forcedMaybeCompactCallCount = 0;
    const ctx = makeCtx({
      agentLoopRun,
      contextWindowManager: {
        shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
        maybeCompact: async (
          _msgs: Message[],
          _signal: AbortSignal,
          opts?: { force?: boolean },
        ) => {
          // Start-of-turn calls pass no `force` option; route them to a
          // no-op so only the mid-loop and emergency paths drive the test.
          if (!opts?.force) {
            return { compacted: false };
          }
          forcedMaybeCompactCallCount++;
          if (forcedMaybeCompactCallCount === 1) {
            // Mid-loop call — under the new architecture (Compaction
            // Re-homing Arc, Bullet 1) the manager owns its own retry
            // budget; signal exhaustion to escalate to convergence.
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
          // Emergency compaction call from auto_compress_latest_turn.
          return {
            compacted: true,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text", text: "compacted" }],
              },
            ] as Message[],
            compactedPersistedMessages: 5,
            summaryText: "Emergency summary",
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
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
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

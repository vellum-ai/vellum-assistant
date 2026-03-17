/**
 * Overflow recovery test suite for JARVIS-110.
 *
 * Reproduces the failure modes observed in long conversations (75+ messages)
 * where context overflow recovery fails because:
 *   1. Progress during the agent loop bypasses the convergence retry
 *   2. Token estimation significantly underestimates actual token count
 *   3. No mid-loop budget check to prevent hitting the provider limit
 *
 * All tests are test.todo — they document expected behavior for bugs
 * to be fixed in subsequent PRs (PR 2 for tests 1–5, PR 3 for tests 6–7).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { ContentBlock, Message } from "../providers/types.js";

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
      maxInputTokens: 200_000,
      thresholdTokens: 160_000,
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

// ── Overflow recovery mocks ──────────────────────────────────────────

// Token estimator — controllable per-test via mockEstimateTokens.
// Can be a number (constant) or a function for dynamic behavior.
let mockEstimateTokens: number | (() => number) = 1000;
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () =>
    typeof mockEstimateTokens === "function"
      ? mockEstimateTokens()
      : mockEstimateTokens,
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

// Approval: default to denied
let mockApprovalResult = { approved: false };
mock.module("../daemon/context-overflow-approval.js", () => ({
  requestCompressionApproval: async () => mockApprovalResult,
  CONTEXT_OVERFLOW_TOOL_NAME: "context_overflow_compression",
}));

let hookBlocked = false;
let hookBlockedBy = "";

mock.module("../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: async (hookName: string) => {
      if (hookName === "pre-message" && hookBlocked) {
        return { blocked: true, blockedBy: hookBlockedBy };
      }
      return { blocked: false };
    },
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
  getMessageById: () => null,
  updateMessageContent: () => {},
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
  consolidateAssistantMessages: () => {},
}));

const recordUsageMock = mock(() => {});
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
  hookBlocked = false;
  hookBlockedBy = "";
  mockEstimateTokens = 1000;
  mockReducerStepFn = null;
  mockOverflowAction = "fail_gracefully";
  mockApprovalResult = { approved: false };
  recordUsageMock.mockClear();
});

describe("session-agent-loop overflow recovery (JARVIS-110)", () => {
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
  test.todo(
    "overflow recovery compacts below limit even when estimation underestimates",
    async () => {
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
    },
  );

  // ── Test 3 ────────────────────────────────────────────────────────
  // BUG: When the provider rejection reveals actual token count (e.g.,
  // "242201 tokens > 200000"), the reducer should target a budget below
  // the actual limit (not below the estimator's inaccurate budget).
  // Currently the reducer always uses `preflightBudget` (190k) as the
  // target, but the actual tokens were 242k — so 190k is already too
  // high relative to the real count. The target should be adjusted
  // downward based on the observed mismatch.
  //
  // Expected behavior (PR 4 fix): `targetInputTokensOverride` should
  // be adjusted based on the ratio between estimated and actual tokens.
  // BUG: The targetTokens passed to the reducer is preflightBudget = 190k.
  // But when the actual token count is 242k (1.31x the estimate of 185k),
  // the target should be adjusted downward to account for the estimation
  // inaccuracy. For example: 190k / 1.31 ≈ 145k.
  // Planned fix: targetInputTokensOverride should be adjusted based on
  // the ratio between estimated and actual tokens.
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
      const agentLoopRun: AgentLoopRun = async (
        messages,
        onEvent,
        _signal,
        _requestId,
        onCheckpoint,
      ) => {
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
          if (onCheckpoint) {
            const decision = onCheckpoint({
              turnIndex: 0,
              toolCount: 1,
              hasToolUse: true,
              history: withProgress,
            });
            if (decision === "yield") {
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

      const agentLoopRun: AgentLoopRun = async (
        messages,
        onEvent,
        _signal,
        _requestId,
        onCheckpoint,
      ) => {
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

            if (onCheckpoint) {
              const decision = onCheckpoint({
                turnIndex: i,
                toolCount: 1,
                hasToolUse: true,
                history: currentHistory,
              });
              if (decision === "yield") {
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
    const agentLoopRun: AgentLoopRun = async (
      messages,
      onEvent,
      _signal,
      _requestId,
      onCheckpoint,
    ) => {
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
      if (onCheckpoint) {
        const decision = onCheckpoint({
          turnIndex: 0,
          toolCount: 1,
          hasToolUse: true,
          history: withProgress,
        });
        if (decision === "yield") {
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
          // Compaction "succeeds" but doesn't actually shrink enough
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

    // 1 initial auto-compact + 3 mid-loop compaction attempts = 4 total
    expect(compactionCallCount).toBe(4);

    // Agent loop: 1 initial + 3 mid-loop re-entries + 1 convergence re-run = 5 calls
    expect(agentLoopCallCount).toBe(5);

    // After exhausting mid-loop attempts, the convergence loop should
    // have been triggered (contextTooLargeDetected set to true)
    expect(convergenceReducerCalled).toBe(true);
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
    const agentLoopRun: AgentLoopRun = async (
      messages,
      onEvent,
      _signal,
      _requestId,
      onCheckpoint,
    ) => {
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
      if (onCheckpoint) {
        const decision = onCheckpoint({
          turnIndex: 0,
          toolCount: 1,
          hasToolUse: true,
          history: withProgress,
        });
        if (decision === "yield") {
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
        }),
      } as unknown as AgentLoopConversationContext["contextWindowManager"],
    });

    await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

    // Reducer should have been called twice: once for first convergence tier,
    // once more after yieldedForBudget triggered re-entry
    expect(reducerCallCount).toBe(2);

    // Agent loop: 1 initial + 3 mid-loop re-entries + 2 convergence re-runs = 6 calls
    expect(agentLoopCallCount).toBe(6);
  });
});

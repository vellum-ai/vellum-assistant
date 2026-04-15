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

// ── Overflow recovery mocks ──────────────────────────────────────────

// Token estimator returns a small value by default (well within budget)
// so preflight does not trigger unless the test overrides it.
let mockEstimateTokens = 1000;
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () => mockEstimateTokens,
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
  getLastUserTimestampBefore: () => 0,
}));

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

mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  applyRuntimeInjections: (msgs: Message[]) => msgs,
  stripInjectionsForCompaction: (msgs: Message[]) => msgs,
  findLastInjectedNowContent: () => null,
  readNowScratchpad: () => null,
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
    } as unknown as AgentLoopConversationContext["graphMemory"],

    ...overrides,
  } as AgentLoopConversationContext;
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
  recordRequestLogMock.mockClear();
  syncMessageToDiskMock.mockClear();
  rebuildConversationDiskViewFromDbStateMock.mockClear();
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

  describe("pre-message hook blocking", () => {
    test("emits error and returns early when pre-message hook blocks", async () => {
      hookBlocked = true;
      hookBlockedBy = "test-hook";
      const events: ServerMessage[] = [];
      const ctx = makeCtx();

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect((errorEvent as { message: string }).message).toContain(
        "test-hook",
      );
    });

    test("removes user message when hook blocks without skipPreMessageRollback", async () => {
      hookBlocked = true;
      hookBlockedBy = "guard";
      const ctx = makeCtx();
      const originalLength = ctx.messages.length;

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

      expect(ctx.messages.length).toBe(originalLength - 1);
    });

    test("keeps user message when hook blocks with skipPreMessageRollback", async () => {
      hookBlocked = true;
      hookBlockedBy = "guard";
      const ctx = makeCtx();
      const originalLength = ctx.messages.length;

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {}, {
        skipPreMessageRollback: true,
      });

      expect(ctx.messages.length).toBe(originalLength);
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

    test("interactive deny produces graceful assistant response instead of conversation_error", async () => {
      const events: ServerMessage[] = [];

      // Reducer exhausts all tiers but context is still too large
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

      mockOverflowAction = "request_user_approval";
      mockApprovalResult = { approved: false };

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

      // Should NOT emit conversation_error
      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeUndefined();

      // Should emit a graceful assistant text delta instead
      const textDeltas = events.filter(
        (e) => e.type === "assistant_text_delta",
      );
      expect(textDeltas.length).toBeGreaterThanOrEqual(1);
      const lastDelta = textDeltas[textDeltas.length - 1] as {
        text: string;
      };
      expect(lastDelta.text).toContain("compression was declined");
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
          const decision = onCheckpoint({
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
          onCheckpoint({
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

    test("does not yield during browser flow even when handoff is available", async () => {
      const events: ServerMessage[] = [];

      const agentLoopRun: AgentLoopRun = async (
        messages,
        onEvent,
        _signal,
        _reqId,
        onCheckpoint,
      ) => {
        // All tool uses are browser_ prefixed
        onEvent({
          type: "tool_use",
          id: "tu-1",
          name: "browser_navigate",
          input: {},
        });
        onEvent({
          type: "tool_result",
          toolUseId: "tu-1",
          content: "navigated",
          isError: false,
        });
        onEvent({
          type: "message_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "browsing" }],
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
          onCheckpoint({
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
            content: [{ type: "text", text: "browsing" }] as ContentBlock[],
          },
        ];
      };

      const ctx = makeCtx({
        agentLoopRun,
        canHandoffAtCheckpoint: () => true,
      } as unknown as Partial<AgentLoopConversationContext>);

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // Browser flows should NOT yield
      const handoff = events.find((e) => e.type === "generation_handoff");
      expect(handoff).toBeUndefined();
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
});

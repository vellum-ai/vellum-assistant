import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/ipc-protocol.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ── Module mocks (must precede imports of the module under test) ─────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
  getSocketPath: () => "/tmp/test.sock",
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
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    apiKeys: {},
    workspaceGit: { turnCommitMaxWaitMs: 10 },
    ui: {},
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
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

mock.module("../memory/conversation-store.js", () => ({
  getConversationThreadType: () => "default",
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
    guardianContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  addMessage: () => ({ id: "mock-msg-id" }),
  deleteMessageById: () => {},
  updateConversationContextWindow: () => {},
  updateConversationTitle: () => {},
  getConversationOriginChannel: () => null,
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",
    lexicalHits: 0,
    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
}));

mock.module("../memory/app-store.js", () => ({
  getApp: () => null,
  listAppFiles: () => [],
  getAppsDir: () => "/tmp/apps",
}));

mock.module("../memory/app-git-service.js", () => ({
  commitAppTurnChanges: () => Promise.resolve(),
}));

mock.module("../daemon/session-memory.js", () => ({
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
      lexicalHits: 0,
      semanticHits: 0,
      recencyHits: 0,
      injectedTokens: 0,
      latencyMs: 0,
    },
    dynamicProfile: { text: "" },
    softConflictInstruction: null,
    recallInjectionStrategy: "prepend_user_block" as const,
    conflictClarification: null,
  }),
}));

mock.module("../daemon/session-runtime-assembly.js", () => ({
  applyRuntimeInjections: (msgs: Message[]) => msgs,
  stripInjectedContext: (msgs: Message[]) => msgs,
}));

mock.module("../daemon/session-dynamic-profile.js", () => ({
  stripDynamicProfileMessages: (msgs: Message[]) => msgs,
  injectDynamicProfileIntoUserMessage: (msg: Message) => msg,
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

mock.module("../daemon/session-history.js", () => ({
  consolidateAssistantMessages: () => {},
}));

mock.module("../daemon/session-usage.js", () => ({
  recordUsage: () => {},
}));

mock.module("../daemon/session-attachments.js", () => ({
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

mock.module("../daemon/session-media-retry.js", () => ({
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

mock.module("../daemon/session-error.js", () => ({
  classifySessionError: (_err: unknown, _ctx: unknown) => ({
    code: "SESSION_PROCESSING_FAILED",
    userMessage: "Something went wrong processing your message.",
    retryable: false,
  }),
  isUserCancellation: (err: unknown, ctx: { aborted?: boolean }) => {
    if (!ctx.aborted) return false;
    if (err instanceof DOMException && err.name === "AbortError") return true;
    if (err instanceof Error && err.name === "AbortError") return true;
    return false;
  },
  buildSessionErrorMessage: (
    sessionId: string,
    classified: Record<string, unknown>,
  ) => ({
    type: "session_error",
    sessionId,
    ...classified,
  }),
  isContextTooLarge: (msg: string) => /context.?length.?exceeded/i.test(msg),
}));

mock.module("../daemon/session-slash.js", () => ({
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
  type AgentLoopSessionContext,
  runAgentLoopImpl,
} from "../daemon/session-agent-loop.js";

// ── Test helpers ─────────────────────────────────────────────────────

type AgentLoopRun = (
  messages: Message[],
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  requestId?: string,
  onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
) => Promise<Message[]>;

function makeCtx(
  overrides?: Partial<AgentLoopSessionContext> & {
    agentLoopRun?: AgentLoopRun;
  },
): AgentLoopSessionContext {
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
    } as unknown as AgentLoopSessionContext["agentLoop"],
    provider: {
      name: "mock-provider",
      sendMessage: async () => ({
        content: [{ type: "text", text: "title" }],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      }),
    } as unknown as AgentLoopSessionContext["provider"],
    systemPrompt: "system prompt",

    contextWindowManager: {
      maybeCompact: async () => ({ compacted: false }),
    } as unknown as AgentLoopSessionContext["contextWindowManager"],
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,

    conflictGate: {
      evaluate: async () => null,
    } as unknown as AgentLoopSessionContext["conflictGate"],
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
    guardianContext: undefined,

    coreToolNames: new Set(),
    allowedToolNames: undefined,
    preactivatedSkillIds: undefined,
    skillProjectionState: new Map(),
    skillProjectionCache:
      new Map() as unknown as AgentLoopSessionContext["skillProjectionCache"],

    traceEmitter: {
      emit: () => {},
    } as unknown as AgentLoopSessionContext["traceEmitter"],
    profiler: {
      startRequest: () => {},
      emitSummary: () => {},
    } as unknown as AgentLoopSessionContext["profiler"],
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
    prompter: {} as unknown as AgentLoopSessionContext["prompter"],
    queue: {} as unknown as AgentLoopSessionContext["queue"],

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
  } as AgentLoopSessionContext;
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  hookBlocked = false;
  hookBlockedBy = "";
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

      const sessionError = events.find((e) => e.type === "session_error");
      expect(sessionError).toBeDefined();
    });

    test("non-error agent loop completion does not emit session_error", async () => {
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

      const sessionError = events.find((e) => e.type === "session_error");
      expect(sessionError).toBeUndefined();
      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });
  });

  describe("context window exhaustion (context-too-large recovery)", () => {
    test("triggers forced compaction when context-too-large is detected", async () => {
      const events: ServerMessage[] = [];
      let callCount = 0;
      let compactForceCalled = false;

      const agentLoopRun: AgentLoopRun = async (messages, onEvent) => {
        callCount++;
        if (callCount === 1) {
          // First call: emit context_too_large error, return same messages (no progress)
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
        // Second call (after compaction): succeed
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
          maybeCompact: async (
            _msgs: Message[],
            _signal: AbortSignal,
            opts?: { force?: boolean },
          ) => {
            if (opts?.force) {
              compactForceCalled = true;
              return {
                compacted: true,
                messages: [
                  { role: "user", content: [{ type: "text", text: "Hello" }] },
                ] as Message[],
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
              };
            }
            return { compacted: false };
          },
        } as unknown as AgentLoopSessionContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(compactForceCalled).toBe(true);
      expect(callCount).toBe(2);
      const compactEvent = events.find((e) => e.type === "context_compacted");
      expect(compactEvent).toBeDefined();
    });

    test("emits session_error when context stays too large after all recovery attempts", async () => {
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
        } as unknown as AgentLoopSessionContext["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const sessionError = events.find((e) => e.type === "session_error");
      expect(sessionError).toBeDefined();
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

      const sessionError = events.find((e) => e.type === "session_error");
      expect(sessionError).toBeDefined();
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
      } as unknown as Partial<AgentLoopSessionContext>);

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
          onCheckpoint({ turnIndex: 0, toolCount: 1, hasToolUse: true });
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
      } as unknown as Partial<AgentLoopSessionContext>);

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
          onCheckpoint({ turnIndex: 0, toolCount: 1, hasToolUse: true });
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
      } as unknown as Partial<AgentLoopSessionContext>);

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
      // Should NOT emit a session_error for user cancellation
      const sessionError = events.find((e) => e.type === "session_error");
      expect(sessionError).toBeUndefined();
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
      } as unknown as Partial<AgentLoopSessionContext>);

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

      // The providerErrorUserMessage should trigger a synthesized assistant_text_delta
      const textDeltas = events.filter(
        (e) => e.type === "assistant_text_delta",
      );
      expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    });
  });
});

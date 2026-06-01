/**
 * Verifies that `runAgentLoopImpl` reads the conversation row's
 * `inferenceProfile` column at turn start and threads it through to
 * `AgentLoop.run()` as the per-turn `overrideProfile`. Background
 * conversations intentionally skip the column so background fan-out
 * (subagents, scheduled tasks, update bulletins) runs on the workspace
 * defaults rather than inheriting an interactive override.
 *
 * This is the "conversation-agent-loop integration" half of the
 * inference-profiles plumbing — the resolver/provider/agent-loop layers are
 * exercised separately by their own tests.
 */

import { createRequire } from "node:module";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent, AgentLoopRunOptions } from "../agent/loop.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import { makeMockLogger } from "./helpers/mock-logger.js";

// Snapshot the real `conversation-crud` exports before `mock.module()` below
// replaces them. We use a synchronous CJS-style require (via `createRequire`)
// because static `import` is hoisted above `mock.module()` calls — but bun's
// own `mock.module()` is NOT hoisted, so the only way to grab the real
// exports at this exact line is the synchronous require. The spread freezes
// each function reference — holding the module object directly would yield
// the *mocked* values after `mock.module` runs, since the require'd object
// is a live binding. `afterAll` re-mocks with this snapshot so downstream
// files in the same `bun test` run get the real exports back (Bun's
// `mock.module()` persists across files; `mock.restore()` does not restore
// module mocks).
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
  getLogger: () => makeMockLogger(),
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
      profiles: {
        "quality-optimized": {
          contextWindow: { maxInputTokens: 50000 },
        },
      },
      callSites: {},
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    workspaceGit: { turnCommitMaxWaitMs: 10 },
    memory: { retrieval: { scratchpadInjection: { enabled: true } } },
    ui: {},
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () => 1000,
  estimatePromptTokensRaw: () => 1000,
  estimateToolsTokens: () => 0,
}));

mock.module("../daemon/context-overflow-reducer.js", () => ({
  createInitialReducerState: () => ({
    appliedTiers: [],
    injectionMode: "full" as const,
    exhausted: false,
  }),
  reduceContextOverflow: async (msgs: Message[]) => ({
    messages: msgs,
    tier: "forced_compaction",
    state: {
      appliedTiers: ["forced_compaction"],
      injectionMode: "full",
      exhausted: true,
    },
    estimatedTokens: 1000,
  }),
}));

mock.module("../daemon/context-overflow-policy.js", () => ({
  resolveOverflowAction: () => "fail_gracefully",
}));

// Mutable conversation-row stub so each test can drive the column values
// the loop reads. `null` simulates an evicted/missing row.
let mockConversationRow: {
  id: string;
  conversationType?: string;
  inferenceProfile?: string | null;
  [key: string]: unknown;
} | null = {
  id: "conv-1",
  conversationType: "standard",
  inferenceProfile: null,
  contextSummary: null,
  contextCompactedMessageCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedCost: 0,
  title: null,
};

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  setConversationHistoryStrippedAt: () => {},
  updateConversationUsage: () => {},
  updateMessageMetadata: () => {},
  getMessages: () => [],
  getConversation: () => mockConversationRow,
  getConversationOverrideProfileFromRow: (
    row: { conversationType?: string; inferenceProfile?: string | null } | null,
  ) => {
    if (row?.conversationType === "background") return undefined;
    const profile = row?.inferenceProfile;
    return typeof profile === "string" ? profile : undefined;
  },
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
  setLastNotifiedInferenceProfile: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
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
  prepareMemoryContext: async () => ({
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
  applyRuntimeInjections: async (msgs: Message[]) => ({
    messages: msgs,
    blocks: {},
  }),
  stripInjectionsForCompaction: (msgs: Message[]) => msgs,
  findLastInjectedNowContent: () => null,
  readNowScratchpad: () => null,
  readPkbContext: () => null,
  getPkbAutoInjectList: () => [],
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
  defaultHistoryRepairTerminal: (args: { history: Message[] }) => ({
    messages: args.history,
    stats: {
      assistantToolResultsMigrated: 0,
      missingToolResultsInserted: 0,
      orphanToolResultsDowngraded: 0,
      consecutiveSameRoleMerged: 0,
    },
  }),
  deepRepairHistory: (msgs: Message[]) => ({ messages: msgs, stats: {} }),
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
  classifyConversationError: () => ({
    code: "CONVERSATION_PROCESSING_FAILED",
    userMessage: "Something went wrong processing your message.",
    retryable: false,
    errorCategory: "processing_failed",
  }),
  isUserCancellation: () => false,
  buildConversationErrorMessage: (
    conversationId: string,
    classified: Record<string, unknown>,
  ) => ({
    type: "conversation_error",
    conversationId,
    ...classified,
  }),
  isContextTooLarge: () => false,
}));

mock.module("../daemon/conversation-slash.js", () => ({
  isProviderOrderingError: () => false,
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
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import {
  type AgentLoopConversationContext,
  runAgentLoopImpl,
} from "../daemon/conversation-agent-loop.js";

// ── Test helpers ─────────────────────────────────────────────────────

/** Captures the options the orchestrator passes to `agentLoop.run`. */
interface CapturedAgentLoopRun {
  callSite: LLMCallSite | undefined;
  overrideProfile: string | undefined;
  resolvedOverrideProfile: string | undefined;
  resolvedMaxInputTokens: number | undefined;
}

let mutateBeforeResolveOverrideProfile: (() => void) | undefined;

function makeCtx(
  captured: CapturedAgentLoopRun[],
  overrides?: Partial<AgentLoopConversationContext>,
): AgentLoopConversationContext {
  const agentLoopRun = async (
    messages: Message[],
    _onEvent: (event: AgentEvent) => void,
    options?: AgentLoopRunOptions,
  ): Promise<Message[]> => {
    mutateBeforeResolveOverrideProfile?.();
    captured.push({
      callSite: options?.callSite,
      overrideProfile: options?.overrideProfile,
      resolvedOverrideProfile: options?.resolveOverrideProfile?.(),
      resolvedMaxInputTokens: options?.resolveContextWindow?.().maxInputTokens,
    });
    return [
      ...messages,
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "response" }],
      },
    ];
  };

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
      getResolvedTools: () => [] as ToolDefinition[],
      getActiveModel: () => undefined,
      compactionCircuit: new CompactionCircuit("test-conv"),
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
  // Reset the conversation-row stub before each test. Defaults match a
  // standard, profile-less interactive conversation.
  mockConversationRow = {
    id: "conv-1",
    conversationType: "standard",
    inferenceProfile: null,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  };
  mutateBeforeResolveOverrideProfile = undefined;
  resetPluginRegistryAndRegisterDefaults();
});

afterAll(() => {
  // Restore real module mocks for downstream files; see the snapshot
  // block near the top of this file for why this is necessary.
  mock.module(
    "../memory/conversation-crud.js",
    () => conversationCrudRealSnapshot,
  );
  mock.module(
    "../memory/conversation-disk-view.js",
    () => conversationDiskViewRealSnapshot,
  );
});

describe("runAgentLoopImpl — per-conversation inferenceProfile", () => {
  test("non-background conversation with inferenceProfile threads it through as overrideProfile", async () => {
    mockConversationRow = {
      id: "conv-1",
      conversationType: "standard",
      inferenceProfile: "quality-optimized",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      title: null,
    };

    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured);

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBe("quality-optimized");
    }
  });

  test("background conversation ignores inferenceProfile column", async () => {
    mockConversationRow = {
      id: "conv-1",
      conversationType: "background",
      inferenceProfile: "quality-optimized",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      title: null,
    };

    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured);

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBeUndefined();
    }
  });

  test("absence of inferenceProfile column behaves identically to today (no override)", async () => {
    // `mockConversationRow` already defaults to inferenceProfile: null.
    // Also explicitly cover the case where the column is missing entirely.
    mockConversationRow = {
      id: "conv-1",
      conversationType: "standard",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      title: null,
    };

    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured);

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBeUndefined();
    }
  });

  test("explicit options.overrideProfile takes precedence over the column read", async () => {
    // Subagent path: SubagentManager forwards the parent's pinned profile
    // into the spawned (background) conversation's runAgentLoop call via
    // `options.overrideProfile`. The agent loop must respect that even
    // though the subagent's own conversation row is `background` (which
    // would otherwise zero out the override per the rule above).
    mockConversationRow = {
      id: "conv-1",
      conversationType: "background",
      inferenceProfile: null,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      title: null,
    };

    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured);

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {}, {
      overrideProfile: "fast",
    });

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.overrideProfile).toBe("fast");
    }
  });

  test("re-resolves inferenceProfile when a tool changes it mid-turn", async () => {
    mockConversationRow = {
      id: "conv-1",
      conversationType: "standard",
      inferenceProfile: null,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      title: null,
    };
    mutateBeforeResolveOverrideProfile = () => {
      mockConversationRow = {
        ...mockConversationRow!,
        inferenceProfile: "quality-optimized",
      };
    };

    const captured: CapturedAgentLoopRun[] = [];
    const ctx = makeCtx(captured);

    await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].overrideProfile).toBeUndefined();
    expect(captured[0].resolvedOverrideProfile).toBe("quality-optimized");
    expect(captured[0].resolvedMaxInputTokens).toBe(50000);
    expect(ctx.currentTurnOverrideProfile).toBeUndefined();
  });
});

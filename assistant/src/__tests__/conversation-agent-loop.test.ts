import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import type { LoopToolExecutor } from "../agent/loop.js";
import {
  queueConversationNotice,
  resetConversationNoticesForTests,
} from "../daemon/conversation-notices.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getConversationDirName } from "../persistence/conversation-directories.js";
import type { UserPromptSubmitContext } from "../plugin-api/types.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { registerPlugin } from "../plugins/registry.js";
import type { Message, Provider, ToolDefinition } from "../providers/types.js";
import { ContextOverflowError } from "../providers/types.js";
import { getWorkspaceDir } from "../util/platform.js";

const conversationCrudRealSnapshot = {
  ...(createRequire(import.meta.url)(
    "../persistence/conversation-crud.js",
  ) as Record<string, unknown>),
};
const conversationDiskViewRealSnapshot = {
  ...(createRequire(import.meta.url)(
    "../persistence/conversation-disk-view.js",
  ) as Record<string, unknown>),
};
let mockUiConfig: { userTimezone?: string; detectedTimezone?: string } = {};
// Disable the catalog default so resolution lands on llm.default.
const disabledCatalogDefaultProfiles: Record<string, unknown> = {
  balanced: { source: "managed", status: "disabled" },
};
let mockLlmProfiles: Record<string, unknown> = {
  ...disabledCatalogDefaultProfiles,
};
let mockLlmActiveProfile: string | undefined;

// ── Module mocks (must precede imports of the module under test) ─────

// The real AgentLoop resolves the per-conversation ContextWindowManager from
// the compaction store keyed by conversationId. These orchestrator tests build
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
      profiles: mockLlmProfiles,
      // The call-site tweak applies under BOTH resolution semantics (the
      // legacy cascade layers it over llm.default; override-or-default
      // applies it over the winner), so the small context window that the
      // overflow/compaction tests depend on holds regardless of the
      // override-or-default-resolution flag.
      callSites: {
        mainAgent: {
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
      },
      activeProfile: mockLlmActiveProfile,
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    workspaceGit: { turnCommitMaxWaitMs: 10 },
    memory: { retrieval: { scratchpadInjection: { enabled: true } } },
    ui: mockUiConfig,
    compaction: { enabled: true, autoThreshold: 0.7 },
    conversations: { skipAutoRetitling: true },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// ── Overflow recovery mocks ──────────────────────────────────────────

// Token estimator returns a small value by default (well within budget)
// so preflight does not trigger unless the test overrides it. Both the
// calibrated entry point (`estimatePromptTokens`, which backs the preflight
// overflow gate and reactive overflow recovery) and the raw entry point
// (`estimatePromptTokensRaw`, used by the pre-send calibration capture) are
// stubbed so either call site can drive the test.
let mockEstimateTokens = 1000;
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () => mockEstimateTokens,
  estimatePromptTokensRaw: () => mockEstimateTokens,
  // The preflight overflow gate calls this calibrated wrapper directly, so it
  // must honor `mockEstimateTokens` too rather than fall through to the real
  // implementation.
  estimatePromptTokensWithTools: () => mockEstimateTokens,
  // Pass-through: `estimatePromptTokensWithTools` computes `toolTokenBudget`
  // via this helper. Return 0 so the mocked estimate is not perturbed.
  estimateToolsTokens: () => 0,
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
  if (mockReducerStepFn) {
    return mockReducerStepFn(msgs, cfg, state);
  }
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
// reducer, mirroring `reduceOverflowOneRung` / `resetOverflowRecovery`.
// `recoverContextOverflow` adapts a rung into the `ContextWindowResult` the
// agent loop's compaction path consumes, mirroring the real manager's
// `overflowStepToResult` so the loop sees the rung's reduced history, injection
// mode, terminal auto-compress flag, and exhaustion.
function makeOverflowLadderStub(): {
  resetOverflowRecovery: () => void;
  reduceOverflowOneRung: (
    msgs: Message[],
    opts: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  recoverContextOverflow: (
    msgs: Message[],
    opts: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
} {
  let state: unknown;
  const reduceOverflowOneRung = async (msgs: Message[], opts: unknown) => {
    if (!state) {
      state = makeInitialReducerState();
    }
    const step = (await runMockReducer(msgs, opts, state)) as {
      state: unknown;
    };
    state = step.state;
    return step;
  };
  return {
    resetOverflowRecovery: () => {
      state = undefined;
    },
    reduceOverflowOneRung,
    recoverContextOverflow: async (msgs: Message[], opts: unknown) => {
      const step = (await reduceOverflowOneRung(msgs, opts)) as {
        messages: Message[];
        estimatedTokens?: number;
        state: {
          appliedTiers: string[];
          injectionMode: string;
          exhausted: boolean;
        };
        compactionResult?: Record<string, unknown>;
      };
      const base = step.compactionResult ?? {
        compacted: false,
        messages: step.messages,
      };
      return {
        ...base,
        messages: step.messages,
        injectionMode: step.state.injectionMode,
        autoCompressApplied: step.state.appliedTiers.includes(
          "auto_compress_latest_turn",
        ),
        exhausted: step.state.exhausted,
      };
    },
  };
}

// Policy: default to fail_gracefully
let mockOverflowAction: string = "fail_gracefully";
mock.module("../plugins/defaults/compaction/overflow-policy.js", () => ({
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
  createdAt: 1_700_000_000_000,
  contextSummary: null,
  contextCompactedMessageCount: 0,
  slackContextCompactionWatermarkTs: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedCost: 0,
  title: null,
};
let mockMessageById: Record<string, unknown> | null = null;

// The in-flight delta files the writers create for the (unmocked-path)
// test conversation. Files are uuid-named at reserve time, so tests locate
// them by listing the directory. Partial flushes land here instead of
// `updateMessageContent`; the finalize seam folds the file inline and
// deletes it, so mid-turn assertions read it during the provider's hold.
function inflightDir(): string {
  return join(
    getWorkspaceDir(),
    "conversations",
    getConversationDirName("test-conv", 1_700_000_000_000),
    "inflight",
  );
}

function inflightDeltaFiles(): string[] {
  try {
    return readdirSync(inflightDir())
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(inflightDir(), f));
  } catch {
    return [];
  }
}

/** The single in-flight delta file expected during a mid-hold read. */
function soleInflightDeltaPath(): string {
  const files = inflightDeltaFiles();
  if (files.length !== 1) {
    throw new Error(`expected exactly one in-flight file, saw ${files.length}`);
  }
  return files[0];
}
const deleteMessageByIdMock = mock(() => ({
  segmentIds: [],
  deletedSummaryIds: [],
}));
const reserveMessageMock = mock(async () => ({ id: "msg-reserve" }));
const updateMessageContentMock = mock(() => {});
const finalizeMessageContentMock = mock(() => {});
const addMessageMock = mock(() => ({ id: "mock-msg-id" }));
mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
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
  addMessage: addMessageMock,
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
  finalizeMessageContent: finalizeMessageContentMock,
  recordConversationPersistedSeq: () => {},
  getConversationPersistedSeq: () => null,
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
// `../persistence/conversation-attention-store.js`; without these stubs the
// real modules would try to open a SQLite DB and read a real config.
const indexMessageNowMock = mock(async () => ({
  indexedSegments: 0,
  enqueuedJobs: 0,
}));
const projectAssistantMessageMock = mock(() => false);
const publishSyncInvalidationMock = mock(async () => {});
mock.module("../plugins/defaults/memory/indexer.js", () => ({
  indexMessageNow: indexMessageNowMock,
}));
mock.module("../persistence/conversation-attention-store.js", () => ({
  projectAssistantMessage: projectAssistantMessageMock,
}));
mock.module("../runtime/sync/sync-publisher.js", () => ({
  publishSyncInvalidation: publishSyncInvalidationMock,
}));

afterAll(() => {
  mock.module(
    "../persistence/conversation-crud.js",
    () => conversationCrudRealSnapshot,
  );
  mock.module(
    "../persistence/conversation-disk-view.js",
    () => conversationDiskViewRealSnapshot,
  );
});

const syncMessageToDiskMock = mock(() => {});
const rebuildConversationDiskViewFromDbStateMock = mock(() => {});
mock.module("../persistence/conversation-disk-view.js", () => ({
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

mock.module("../apps/app-store.js", () => ({
  getApp: () => null,
  listAppFiles: () => [],
  getAppsDir: () => "/tmp/apps",
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
const defaultApplyRuntimeInjectionsImpl = async (
  msgs: Message[],
  _options?: unknown,
) => ({
  messages: msgs,
  blocks: { ...mockInjectionBlocks },
});
const applyRuntimeInjectionsMock = mock(defaultApplyRuntimeInjectionsImpl);
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
    if (!context || compactedRenderedMessages <= 0) {
      return null;
    }
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
  isRepairableOrderingError: () => false,
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

let mockConversationErrorClassification = {
  code: "CONVERSATION_PROCESSING_FAILED",
  userMessage: "Something went wrong processing your message.",
  retryable: false,
  errorCategory: "processing_failed",
};

mock.module("../daemon/conversation-error.js", () => ({
  classifyConversationError: (_err: unknown, _ctx: unknown) =>
    mockConversationErrorClassification,
  isUserCancellation: (err: unknown, ctx: { aborted?: boolean }) => {
    if (!ctx.aborted) {
      return false;
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      return true;
    }
    if (err instanceof Error && err.name === "AbortError") {
      return true;
    }
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

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: recordRequestLogMock,
  backfillMessageIdOnLogs: backfillMessageIdOnLogsMock,
  setAgentLoopExitReasonOnLatestLog: setAgentLoopExitReasonOnLatestLogMock,
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { AgentLoop } from "../agent/loop.js";
import type { Conversation } from "../daemon/conversation.js";
import {
  applyCompactionResult,
  runAgentLoopImpl,
} from "../daemon/conversation-agent-loop.js";
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
  let processing = true;

  // Drive the real `AgentLoop` against a scripted provider, mocking only the
  // provider HTTP boundary. The loop owns its mid-loop budget gate, inline
  // compaction, and event emission, so these orchestrator tests exercise the
  // real escalation/persistence path.
  //
  // Name the loop's provider after `ctx.provider` so the two stay in sync,
  // mirroring production where the orchestrator hands the same provider to
  // the loop. The loop stamps this name onto `usage.actualProvider` whenever
  // a response omits its own, which is what the request-log fallback reads.
  // Tests that need to introspect provider calls (or sequence a rejection)
  // build their own `loopProvider` via `createMockProvider`.
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
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
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
    conversationType: mockConversationRow?.conversationType ?? undefined,
    source: mockConversationRow?.source ?? undefined,
    contextSummary: mockConversationRow?.contextSummary ?? null,
    contextCompactedMessageCount:
      mockConversationRow?.contextCompactedMessageCount ?? 0,
    contextCompactedAt: mockConversationRow?.contextCompactedAt ?? null,
    slackContextCompactionWatermarkTs:
      mockConversationRow?.slackContextCompactionWatermarkTs ?? null,
    lastNotifiedInferenceProfile:
      mockConversationRow?.lastNotifiedInferenceProfile ?? null,
    processingStartedAt: mockConversationRow?.processingStartedAt ?? null,

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

    buildCurrentSystemPrompt: () => "system prompt",
    syncLoopSystemPrompt: () => {},
    modelOverride: undefined,

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
  // Reactive overflow recovery resolves the turn-scoped reduction ladder off
  // the manager; give every fake manager the ladder methods unless a test
  // supplied its own.
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

type CompactionResult = Parameters<typeof applyCompactionResult>[1];

function makeCompactionResult(
  overrides?: Partial<CompactionResult>,
): CompactionResult {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }],
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
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  mockUiConfig = {};
  mockLlmProfiles = { ...disabledCatalogDefaultProfiles };
  mockLlmActiveProfile = undefined;
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
    createdAt: 1_700_000_000_000,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    slackContextCompactionWatermarkTs: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  };
  mockMessageById = null;
  setConversationHistoryStrippedAtMock.mockClear();
  setConversationHistoryStrippedAtMock.mockImplementation(() => {});
  applyRuntimeInjectionsMock.mockClear();
  applyRuntimeInjectionsMock.mockImplementation(
    defaultApplyRuntimeInjectionsImpl,
  );
  resolveTurnTimezoneContextMock.mockClear();
  formatTurnTimestampMock.mockClear();
  mockSlackChronologicalContext = null;
  loadSlackChronologicalContextMock.mockClear();
  getSlackCompactionWatermarkForPrefixMock.mockClear();
  deleteMessageByIdMock.mockClear();
  reserveMessageMock.mockClear();
  updateMessageContentMock.mockClear();
  finalizeMessageContentMock.mockClear();
  rmSync(inflightDir(), { recursive: true, force: true });
  addMessageMock.mockClear();
  mockConversationErrorClassification = {
    code: "CONVERSATION_PROCESSING_FAILED",
    userMessage: "Something went wrong processing your message.",
    retryable: false,
    errorCategory: "processing_failed",
  };
  indexMessageNowMock.mockClear();
  projectAssistantMessageMock.mockClear();
  publishSyncInvalidationMock.mockClear();
  resolveAssistantAttachmentsMock.mockClear();
  resolveAssistantAttachmentsMock.mockImplementation(async () => ({
    assistantAttachments: [],
    emittedAttachments: [],
    directiveWarnings: [],
  }));
  mockMessageById = null;
  resetConversationNoticesForTests();
  // The compaction pipeline runs through the plugin registry; reset and
  // re-register every default so it dispatches to middleware backed by the
  // mocked collaborators these tests install (`syncMessageToDisk`, etc.)
  // instead of hitting the bare terminal.
  resetPluginRegistryAndRegisterDefaults();
});

describe("session-agent-loop", () => {
  describe("user-prompt-submit hook failures", () => {
    test("passes the effective profile to hooks even when it was already announced", async () => {
      mockLlmProfiles = {
        balanced: {
          label: "Balanced",
          model: "accounts/fireworks/models/glm-5p2",
        },
        quality: { label: "Quality", model: "claude-opus-4-8" },
      };
      mockLlmActiveProfile = "quality";
      const observedProfileKeys: string[] = [];
      registerPlugin({
        manifest: {
          name: "test-observe-model-profile",
          version: "1.0.0",
        },
        hooks: {
          "user-prompt-submit": async (ctx: UserPromptSubmitContext) => {
            observedProfileKeys.push(ctx.modelProfileKey);
          },
        },
      });

      const ctx = makeCtx({
        inferenceProfile: "balanced",
        lastNotifiedInferenceProfile: "balanced",
        providerResponses: [textResponse("ok")],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", () => {});

      expect(observedProfileKeys).toEqual(["balanced"]);
    });

    test("logs and continues with prior hook mutations", async () => {
      registerPlugin({
        manifest: {
          name: "test-user-prompt-rewrite",
          version: "1.0.0",
        },
        hooks: {
          "user-prompt-submit": async (_ctx: UserPromptSubmitContext) => ({
            latestMessages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: "rewritten prompt" }],
              },
            ],
          }),
        },
      });
      registerPlugin({
        manifest: {
          name: "test-user-prompt-throw",
          version: "1.0.0",
        },
        hooks: {
          "user-prompt-submit": async () => {
            throw new Error("simulated hook failure");
          },
        },
      });

      const events: ServerMessage[] = [];
      const ctx = makeCtx({ providerResponses: [textResponse("ok")] });
      const runSpy = spyOn(ctx.agentLoop, "run");

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(runSpy).toHaveBeenCalledTimes(1);
      const call = runSpy.mock.calls[0]?.[0] as
        | { messages: Message[] }
        | undefined;
      expect(call?.messages[0]?.content).toEqual([
        { type: "text", text: "rewritten prompt" },
      ]);
      expect(
        events.find((event) => event.type === "conversation_error"),
      ).toBeUndefined();
      expect(
        events.find((event) => event.type === "message_complete"),
      ).toBeDefined();
    });
  });

  describe("conversation notices", () => {
    test("emits queued billing notices after a successful turn", async () => {
      const events: ServerMessage[] = [];
      const ctx = makeCtx({ providerResponses: [textResponse("ok")] });
      queueConversationNotice(ctx.conversationId, "memory-v3-test", {
        source: "memory_v3",
        code: "PROVIDER_BILLING",
        userMessage: "You've run out of credits.",
        errorCategory: "credits_exhausted",
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(
        events.find((event) => event.type === "conversation_error"),
      ).toBeUndefined();
      const messageCompleteIndex = events.findIndex(
        (event) => event.type === "message_complete",
      );
      const conversationNoticeIndex = events.findIndex(
        (event) => event.type === "conversation_notice",
      );

      expect(messageCompleteIndex).toBeGreaterThanOrEqual(0);
      expect(conversationNoticeIndex).toBeGreaterThan(messageCompleteIndex);
      expect(events[conversationNoticeIndex]).toEqual({
        type: "conversation_notice",
        conversationId: "test-conv",
        source: "memory_v3",
        code: "PROVIDER_BILLING",
        userMessage: "You've run out of credits.",
        errorCategory: "credits_exhausted",
      });
    });

    test("clears queued notices when post-loop success work fails", async () => {
      resolveAssistantAttachmentsMock.mockImplementation(async () => {
        throw new Error("attachment resolution failed");
      });
      const events: ServerMessage[] = [];
      const ctx = makeCtx({ providerResponses: [textResponse("ok")] });
      queueConversationNotice(ctx.conversationId, "memory-v3-test", {
        source: "memory_v3",
        code: "PROVIDER_BILLING",
        userMessage: "You've run out of credits.",
        errorCategory: "credits_exhausted",
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(
        events.find((event) => event.type === "conversation_notice"),
      ).toBeUndefined();
      expect(
        events.find((event) => event.type === "message_complete"),
      ).toBeUndefined();
      expect(
        events.find((event) => event.type === "conversation_error"),
      ).toBeDefined();
    });
  });

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

    test("freezes the client timezone snapshot on the conversation, not the options bag", async () => {
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

      // The turn-start client timezone and the long-absence gap are frozen on
      // the conversation as `currentTurnTemporalSnapshot`; the live
      // `clientTimezone` would otherwise be clobbered mid-turn. `current_time`
      // is not frozen — it is computed fresh at each injection inside
      // `applyRuntimeInjections`.
      expect(ctx.currentTurnTemporalSnapshot).toEqual({
        clientTimezone: "America/Los_Angeles",
        timeSinceLastMessage: null,
      });
      // Neither the timezones nor the long-absence gap are threaded through the
      // options bag — `applyRuntimeInjections` sources the client timezone and
      // gap from the snapshot and the config timezones from config
      // (`ui.userTimezone`, `ui.detectedTimezone`).
      const injectionOptions = applyRuntimeInjectionsMock.mock.calls[0]?.[1];
      expect(injectionOptions).not.toHaveProperty("timestamp");
      expect(injectionOptions).not.toHaveProperty("clientTimezone");
      expect(injectionOptions).not.toHaveProperty("configuredUserTimezone");
      expect(injectionOptions).not.toHaveProperty("detectedTimezone");
      expect(injectionOptions).not.toHaveProperty("timeSinceLastMessage");
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

  describe("disk pressure injection context", () => {
    // The loop sets `ctx.diskPressureCleanupModeActive` for the duration of the
    // turn (the disk-pressure-warning injector reads it via the per-conversation
    // registry) and resets it in the turn-end cleanup path. Snapshot the flag at
    // each `applyRuntimeInjections` call so assertions observe its value while
    // injection runs, not the post-turn reset.
    function captureCleanupFlagDuringInjection(ctx: {
      diskPressureCleanupModeActive?: boolean;
    }): () => Array<boolean | undefined> {
      const observed: Array<boolean | undefined> = [];
      applyRuntimeInjectionsMock.mockImplementation(async (msgs: Message[]) => {
        observed.push(ctx.diskPressureCleanupModeActive);
        return { messages: msgs, blocks: { ...mockInjectionBlocks } };
      });
      return () => observed;
    }

    test("sets the cleanup-mode flag on the conversation for cleanup-mode turns", async () => {
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
        } as Conversation["trustContext"],
      });
      const cleanupFlagDuringInjection = captureCleanupFlagDuringInjection(ctx);

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
      expect(cleanupFlagDuringInjection()).toEqual([true]);
    });

    test("sets the cleanup-mode flag on the conversation for local-owner turns", async () => {
      mockDiskPressureDecision = {
        action: "allow-cleanup-mode",
        reason: "local-owner",
      };
      const ctx = makeCtx();
      const cleanupFlagDuringInjection = captureCleanupFlagDuringInjection(ctx);

      await runAgentLoopImpl(ctx, "free up space", "msg-1", () => {});

      expect(classifyDiskPressureTurnPolicyMock).toHaveBeenCalledWith(
        mockDiskPressureStatus,
        expect.objectContaining({
          sourceChannel: "vellum",
          sourceInterface: "web",
          trustContext: null,
        }),
      );
      expect(cleanupFlagDuringInjection()).toEqual([true]);
    });

    test("keeps the cleanup-mode flag set across overflow recovery reinjection", async () => {
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
        } as Conversation["trustContext"],
      });
      const cleanupFlagDuringInjection = captureCleanupFlagDuringInjection(ctx);

      await runAgentLoopImpl(ctx, "free up space", "msg-1", () => {});

      expect(applyRuntimeInjectionsMock.mock.calls.length).toBeGreaterThan(1);
      const flags = cleanupFlagDuringInjection();
      expect(flags.length).toBeGreaterThan(1);
      expect(flags.every((flag) => flag === true)).toBe(true);
    });

    test("blocks policy-denied turns before runtime injection or model execution", async () => {
      mockDiskPressureDecision = {
        action: "block",
        reason: "trusted-contact",
      };
      const events: ServerMessage[] = [];
      const activityStates: unknown[][] = [];
      const ctx = makeCtx({
        emitActivityState: (...args: unknown[]) => {
          activityStates.push(args);
        },
      });
      const runSpy = spyOn(ctx.agentLoop, "run");

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(runSpy).not.toHaveBeenCalled();
      expect(applyRuntimeInjectionsMock).not.toHaveBeenCalled();
      expect(activityStates).toContainEqual([
        "idle",
        "error_terminal",
        { anchor: "global", requestId: "test-req" },
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
      expect(ctx.isProcessing()).toBe(false);
      expect(ctx.abortController).toBeNull();
      expect(ctx.currentRequestId).toBeUndefined();
      expect(drainQueue).toHaveBeenCalledWith("loop_complete");
      expect(activityStates).toContainEqual([
        "idle",
        "error_terminal",
        { anchor: "global", requestId: "test-req" },
      ]);
    });
  });

  describe("tool execution errors via agent loop", () => {
    test("error events from agent loop are classified and emitted", async () => {
      const events: ServerMessage[] = [];

      // The model calls a tool whose executor throws, surfacing an `error`
      // event from the loop's catch handler.
      const ctx = makeCtx({
        providerResponses: [toolUseResponse("tu-1", "bash", { cmd: "ls" })],
        toolExecutor: async () => {
          throw new Error("Tool execution failed: permission denied");
        },
      });
      await runAgentLoopImpl(ctx, "run ls", "msg-1", (msg) => events.push(msg));

      const conversationError = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationError).toBeDefined();
    });

    test("non-error agent loop completion does not emit conversation_error", async () => {
      const events: ServerMessage[] = [];

      const ctx = makeCtx({
        providerResponses: [textResponse("All good")],
      });
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

      // The provider response carries its own `actualProvider`, so the logged
      // row should record that name rather than the runtime provider.
      const ctx = makeCtx({
        providerResponses: [
          {
            content: [{ type: "text", text: "Hi there." }],
            model: "gpt-4.1-2026-03-01",
            usage: { inputTokens: 12, outputTokens: 3 },
            stopReason: "end_turn",
            actualProvider: "fireworks",
            rawRequest,
            rawResponse,
          },
        ],
        provider: {
          name: "openrouter",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as Conversation["provider"],
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

      // The provider response omits `actualProvider`, so the loop stamps the
      // runtime provider name onto the usage event and the row records it.
      const ctx = makeCtx({
        providerResponses: [
          {
            content: [{ type: "text", text: "Hi there." }],
            model: "gpt-4.1-2026-03-01",
            usage: { inputTokens: 12, outputTokens: 3 },
            stopReason: "end_turn",
            rawRequest,
            rawResponse,
          },
        ],
        provider: {
          name: "openrouter",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as Conversation["provider"],
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

      const ctx = makeCtx({
        providerResponses: [
          {
            content: [{ type: "text", text: "Hi there." }],
            model: "gpt-5.4",
            usage: { inputTokens: 12, outputTokens: 3 },
            stopReason: "end_turn",
            actualProvider: "openai",
            rawRequest,
            rawResponse,
          },
        ],
        provider: {
          name: "openai",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as Conversation["provider"],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(recordRequestLogMock).toHaveBeenCalledTimes(1);
      const call = recordRequestLogMock.mock.calls[0] as unknown as unknown[];
      expect(call[1]).toBe(JSON.stringify(rawRequest));
      expect(call[2]).toBe(JSON.stringify(rawResponse));
    });
  });

  describe("usage accounting", () => {
    test("records the actual provider for usage accounting", async () => {
      const events: ServerMessage[] = [];

      const ctx = makeCtx({
        providerResponses: [
          {
            content: [{ type: "text", text: "Hi there." }],
            model: "gpt-4.1-2026-03-01",
            usage: { inputTokens: 12, outputTokens: 3 },
            stopReason: "end_turn",
            actualProvider: "fireworks",
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
          },
        ],
        provider: {
          name: "openrouter",
          sendMessage: async () => ({
            content: [{ type: "text", text: "title" }],
            model: "mock",
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }),
        } as unknown as Conversation["provider"],
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

    test("persists the served model onto the assistant row's metadata at finalize", async () => {
      const events: ServerMessage[] = [];

      const ctx = makeCtx({
        providerResponses: [
          {
            content: [{ type: "text", text: "Hi there." }],
            model: "gpt-4.1-2026-03-01",
            usage: { inputTokens: 12, outputTokens: 3 },
            stopReason: "end_turn",
          },
        ],
      });

      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      // The finalize write carries the `message_complete` event's model
      // (`response.model`) as metadata alongside the content, in one write.
      const finalizeCall = finalizeMessageContentMock.mock.calls.find(
        (call) => (call as unknown[])[2] !== undefined,
      ) as unknown[] | undefined;
      expect(finalizeCall).toBeDefined();
      expect(finalizeCall?.[2]).toEqual({ model: "gpt-4.1-2026-03-01" });
    });
  });

  describe("checkpoint handoff (infinite loop prevention)", () => {
    test("yields at checkpoint when canHandoffAtCheckpoint returns true", async () => {
      const events: ServerMessage[] = [];

      // A tool turn drives the loop to its first mid-loop checkpoint, where the
      // orchestrator yields for a queued handoff.
      const ctx = makeCtx({
        providerResponses: [toolUseResponse("tu-1", "file_read", {})],
        loopTools: [
          {
            name: "file_read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        toolExecutor: async () => ({ content: "file content", isError: false }),
        canHandoffAtCheckpoint: () => true,
      } as unknown as Partial<Conversation>);

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

      // The tool turn reaches a checkpoint, but with handoff disabled the loop
      // continues to the next turn and completes normally.
      const ctx = makeCtx({
        providerResponses: [
          toolUseResponse("tu-1", "file_read", {}),
          textResponse("done"),
        ],
        loopTools: [
          {
            name: "file_read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        toolExecutor: async () => ({ content: "content", isError: false }),
        canHandoffAtCheckpoint: () => false,
      } as unknown as Partial<Conversation>);

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

      // The provider completes its response but the user cancels mid-turn, so
      // the orchestrator observes the aborted signal once the loop returns.
      const provider: Provider = {
        name: "mock",
        async sendMessage(_messages, options) {
          options?.onEvent?.({ type: "text_delta", text: "partial" });
          abortController.abort();
          return textResponse("partial");
        },
      };

      const ctx = makeCtx({ loopProvider: provider, abortController });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const cancelled = events.find((e) => e.type === "generation_cancelled");
      expect(cancelled).toBeDefined();
    });

    test("handles AbortError thrown from agent loop as user cancellation", async () => {
      const events: ServerMessage[] = [];
      const abortController = new AbortController();

      // The provider rejects with an AbortError after the user cancels.
      const provider: Provider = {
        name: "mock",
        async sendMessage() {
          abortController.abort();
          throw new DOMException("The operation was aborted", "AbortError");
        },
      };

      const ctx = makeCtx({ loopProvider: provider, abortController });
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

      // The provider completes its response but the user cancels mid-turn.
      const provider: Provider = {
        name: "mock",
        async sendMessage(_messages, options) {
          options?.onEvent?.({ type: "text_delta", text: "partial" });
          abortController.abort();
          return textResponse("partial");
        },
      };

      const ctx = makeCtx({ loopProvider: provider, abortController });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      const cancelled = events.find((e) => e.type === "generation_cancelled");
      expect(cancelled).toBeDefined();
      // resolveAssistantAttachments should NOT have been called
      expect(resolveAssistantAttachmentsMock).not.toHaveBeenCalled();
    });
  });

  describe("finally block cleanup", () => {
    test("increments turnCount after successful run", async () => {
      // GIVEN a real loop that answers in a single text turn
      const ctx = makeCtx({ providerResponses: [textResponse("hi")] });
      expect(ctx.turnCount).toBe(0);

      // WHEN the orchestrator runs the turn to completion
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // THEN the finally block increments the turn count
      expect(ctx.turnCount).toBe(1);
    });

    test("clears processing state and abort controller", async () => {
      // GIVEN a real loop that answers in a single text turn
      const ctx = makeCtx({ providerResponses: [textResponse("hi")] });

      // WHEN the orchestrator runs the turn to completion
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // THEN the finally block clears all per-turn processing state
      expect(ctx.isProcessing()).toBe(false);
      expect(ctx.abortController).toBeNull();
      expect(ctx.currentRequestId).toBeUndefined();
      expect(ctx.commandIntent).toBeUndefined();
      // Turn-scoped interactivity is stamped during the run and must be cleared
      // so paths that bypass this loop (e.g. opportunity wakes) don't inherit a
      // stale value instead of falling back to live client state.
      expect(ctx.currentTurnIsNonInteractive).toBeUndefined();
    });

    test("clears state and surfaces a processing error when the provider call fails", async () => {
      // GIVEN a real loop whose provider rejects with an unexpected error
      const events: ServerMessage[] = [];
      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage() {
            throw new Error("unexpected crash");
          },
        } as unknown as Provider,
      });

      // WHEN the orchestrator runs the turn
      await runAgentLoopImpl(ctx, "hi", "msg-1", (msg) => events.push(msg));

      // THEN the finally block clears per-turn state and the failure is
      // surfaced as a processing-failed conversation error
      expect(ctx.isProcessing()).toBe(false);
      expect(ctx.abortController).toBeNull();
      expect(
        events.find((event) => event.type === "conversation_error"),
      ).toMatchObject({
        type: "conversation_error",
        code: "CONVERSATION_PROCESSING_FAILED",
        errorCategory: "processing_failed",
      });
    });

    test("drains queue after completion", async () => {
      // GIVEN a real loop that answers in a single text turn
      let drainReason: string | undefined;
      const ctx = makeCtx({
        providerResponses: [textResponse("ok")],
        drainQueue: (reason: string) => {
          drainReason = reason;
        },
      } as unknown as Partial<Conversation>);

      // WHEN the orchestrator runs the turn to completion
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // THEN the queue is drained with the loop-complete reason
      expect(drainReason).toBe("loop_complete");
    });

    test("abort watchdog drives a wedged turn to its finally", async () => {
      // GIVEN a provider whose call wedges: it acknowledges the user cancel
      // (aborts the signal) but its promise never settles and never observes
      // the signal — the exact condition that latched `processing` true.
      const events: ServerMessage[] = [];
      const abortController = new AbortController();
      let drainReason: string | undefined;
      // The provider's call wedges on this promise. It settles only on test
      // teardown so the abandoned `run()` can unwind cleanly instead of leaking
      // background work (e.g. partial-persist debounce timers) into later tests.
      let releaseHang: (reason: unknown) => void = () => {};
      const hang = new Promise<never>((_, reject) => {
        releaseHang = reject;
      });
      const provider: Provider = {
        name: "mock-provider",
        sendMessage(_messages, _options) {
          abortController.abort();
          // Never observes the signal — the exact condition that latched
          // `processing` true before the watchdog existed.
          return hang;
        },
      };
      const ctx = makeCtx({
        loopProvider: provider,
        abortController,
        // Fire the watchdog quickly instead of the ~45s production default.
        abortWatchdogMs: 30,
        drainQueue: (reason: string) => {
          drainReason = reason;
        },
      } as unknown as Partial<Conversation>);

      try {
        // WHEN the orchestrator runs the turn
        await runAgentLoopImpl(ctx, "hi", "msg-1", (msg) => events.push(msg));

        // THEN the watchdog forces the turn to its finally: processing clears,
        // the abort controller is torn down, the queue drains, and the user
        // sees a cancellation (not an error).
        expect(ctx.isProcessing()).toBe(false);
        expect(ctx.abortController).toBeNull();
        expect(drainReason).toBe("loop_complete");
        expect(
          events.find((e) => e.type === "generation_cancelled"),
        ).toBeDefined();
        expect(
          events.find((e) => e.type === "conversation_error"),
        ).toBeUndefined();
      } finally {
        // Let the abandoned run() reject and unwind, then flush microtasks.
        releaseHang(
          new DOMException("The operation was aborted", "AbortError"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
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

      expect(ctx.isProcessing()).toBe(false);
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

      // GIVEN a real loop whose provider rejects with a generic error
      // (non-ordering, non-context-too-large) so the loop emits `error` and
      // the orchestrator sets `providerErrorUserMessage`.
      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage() {
            throw new Error("Internal processing failure");
          },
        } as unknown as Provider,
      });
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

      // GIVEN a real loop whose provider rejects: the loop emits
      // `provider_error` (writing an `llm_request_logs` row with
      // messageId=null — the orphan we link) then `error` (which sets
      // `state.providerErrorUserMessage`, activating the synthetic-message
      // branch below the loop).
      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage() {
            throw new Error("upstream 500");
          },
        } as unknown as Provider,
      });
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

    test("does not persist managed credential refresh failures as assistant text", async () => {
      mockConversationErrorClassification = {
        code: "MANAGED_KEY_INVALID",
        userMessage: "Couldn't refresh assistant credentials.",
        retryable: false,
        errorCategory: "managed_key_invalid",
      };
      const events: ServerMessage[] = [];

      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage() {
            throw new Error("API key has expired.");
          },
        } as unknown as Provider,
      });
      await runAgentLoopImpl(ctx, "hello", "msg-1", (msg) => events.push(msg));

      expect(
        events.filter((event) => event.type === "assistant_text_delta"),
      ).toHaveLength(0);

      const conversationError = events.find(
        (event) => event.type === "conversation_error",
      );
      expect(conversationError).toBeDefined();
      expect(conversationError).toMatchObject({
        code: "MANAGED_KEY_INVALID",
        userMessage: "Couldn't refresh assistant credentials.",
        errorCategory: "managed_key_invalid",
      });

      expect(addMessageMock).not.toHaveBeenCalled();
      expect(recordRequestLogMock).not.toHaveBeenCalled();
      expect(backfillMessageIdOnLogsMock).not.toHaveBeenCalled();
      expect(deleteMessageByIdMock).toHaveBeenCalledTimes(1);
      const deleteCall = deleteMessageByIdMock.mock.calls[0] as unknown as [
        string,
      ];
      expect(deleteCall[0]).toBe("msg-reserve");
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

      // GIVEN a real loop that answers with a single finalized assistant turn
      const ctx = makeCtx({
        providerResponses: [textResponse("indexed reply")],
      });
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
        },
        unknown,
      ];
      const indexCall = indexCallArgs[0];
      expect(indexCall).toMatchObject({
        messageId: "msg-reserve",
        conversationId: "test-conv",
        role: "assistant",
        createdAt: 1234567,
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

    test("terminal message_complete is emitted before the deferred indexer runs (LUM-2654)", async () => {
      // Regression guard for LUM-2654 ("long delay between last streaming token
      // and send-button becoming available"). The terminal `message_complete`
      // SSE — which the client uses to flip stop→send — is emitted before the
      // non-critical finalize side-effects (memory segment indexing, lexical
      // indexing, attention projection), which the orchestrator drains from its
      // end-of-turn tail. The tail runs within the turn, so the indexer still
      // fires exactly once; this test pins the ordering by asserting
      // `message_complete` is already in the client stream when it does.
      mockMessageById = {
        id: "msg-reserve",
        conversationId: "test-conv",
        createdAt: 1234567,
        role: "assistant",
        content: "[]",
        metadata: null,
      };

      const events: ServerMessage[] = [];
      let messageCompleteSeenWhenIndexed: boolean | undefined;
      indexMessageNowMock.mockImplementationOnce(async () => {
        messageCompleteSeenWhenIndexed = events.some(
          (event) => event.type === "message_complete",
        );
        return { indexedSegments: 0, enqueuedJobs: 0 };
      });

      const ctx = makeCtx({
        providerResponses: [textResponse("indexed reply")],
      });
      await runAgentLoopImpl(ctx, "hi", "msg-1", (msg) => events.push(msg));

      // The deferred indexer runs exactly once, within the turn…
      expect(indexMessageNowMock).toHaveBeenCalledTimes(1);
      // …and only after the terminal SSE that re-enables the composer.
      expect(messageCompleteSeenWhenIndexed).toBe(true);
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

      // GIVEN a real loop that answers with a single finalized assistant turn
      const ctx = makeCtx({ providerResponses: [textResponse("quiet")] });
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

      // A single reducer rung reduces the oversized context so the loop
      // re-enters after the first call's overflow rejection.
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

      // GIVEN a real loop whose first call rejects with context-too-large
      // (reserving msg-strand-A but never finalizing it), then recovers via
      // the reactive overflow ladder on re-entry. The re-entry's
      // `llm_call_started` must delete the stranded msg-strand-A before
      // reserving msg-strand-B.
      const ctx = makeCtx({
        providerResponses: [
          new ContextOverflowError(
            "context_length_exceeded: 250000 tokens > 200000 maximum",
            "mock-provider",
            { actualTokens: 250_000, maxTokens: 200_000 },
          ),
          textResponse("retry succeeded"),
        ],
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as Conversation["contextWindowManager"],
      });
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

      // GIVEN a real loop that reserves an assistant row at
      // `llm_call_started`, then whose provider rejects: the loop emits
      // `provider_error` (writing the llm_request_log row) and `error`
      // (arming `state.providerErrorUserMessage`), exiting with no
      // `message_complete` so the synthetic-error branch below the loop
      // fires.
      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage() {
            throw new Error("upstream 500");
          },
        } as unknown as Provider,
      });
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

    test("managed-key provider-error cleanup publishes message invalidation after deleting the reservation", async () => {
      reserveMessageMock.mockImplementationOnce(async () => ({
        id: "msg-managed-key-reservation",
      }));
      mockConversationErrorClassification = {
        code: "MANAGED_KEY_INVALID",
        userMessage: "Couldn't refresh assistant credentials.",
        retryable: false,
        errorCategory: "managed_key_invalid",
      };

      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage() {
            throw new Error("API key has expired.");
          },
        } as unknown as Provider,
      });
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      expect(deleteMessageByIdMock).toHaveBeenCalledTimes(1);
      const deleteCall = deleteMessageByIdMock.mock.calls[0] as unknown as [
        string,
      ];
      expect(deleteCall[0]).toBe("msg-managed-key-reservation");
      expect(addMessageMock).not.toHaveBeenCalled();
      expect(syncMessageToDiskMock).not.toHaveBeenCalled();

      const messagePublishes = (
        publishSyncInvalidationMock.mock.calls as unknown as Array<[string[]]>
      ).filter((args) => args[0]?.includes("conversation:test-conv:messages"));
      expect(messagePublishes).toHaveLength(1);
    });
  });

  describe("partial persistence", () => {
    // The legacy flow reserves an empty assistant row at `llm_call_started`
    // (`content: "[]"`) and never touches it again until
    // `handleMessageComplete` fires the single authoritative
    // `updateContent`. Between those events the row is empty for the full
    // duration of a turn — a browser refresh mid-turn sees nothing where
    // the in-progress assistant reply should be.
    //
    // Partial persistence closes that durability gap with a debounced
    // flush from `handleTextDelta` (250ms timer). `handleToolUse`
    // intentionally does NOT flush — `AgentLoop.run` emits `tool_use`
    // strictly AFTER `message_complete`, so any flush from that handler
    // would land after the authoritative finalize and overwrite the
    // finalized row. The indexer + projector still fire ONLY at
    // `message_complete` — partial rows are never indexed.
    //
    // These tests pin down the wire-level contract by counting
    // `updateMessageContent` calls and inspecting the JSON payload of the
    // partial-flush writes. The indexing / sync-invalidation paths are
    // covered by the pre-allocation block above.

    test("debounced time gate flushes one partial write after PARTIAL_PERSIST_DEBOUNCE_MS", async () => {
      mockMessageById = {
        id: "msg-reserve",
        conversationId: "test-conv",
        createdAt: 1234567,
        role: "assistant",
        content: "[]",
        metadata: null,
      };

      // GIVEN a real loop whose provider streams two small deltas (each under
      // the 1024-char size gate) then holds the turn open past the 250ms
      // debounce window before completing, so a single debounced partial
      // flush lands before `message_complete`.
      let midTurnDeltaLines: string[] | undefined;
      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage(_messages, options) {
            options?.onEvent?.({ type: "text_delta", text: "Hello, " });
            options?.onEvent?.({ type: "text_delta", text: "world." });
            // The debounced flush lands at PARTIAL_PERSIST_DEBOUNCE_MS
            // (1000ms); read the delta file mid-hold (finalize deletes it
            // at turn end).
            await new Promise((resolve) => setTimeout(resolve, 1050));
            midTurnDeltaLines = readFileSync(soleInflightDeltaPath(), "utf8")
              .trim()
              .split("\n");
            await new Promise((resolve) => setTimeout(resolve, 100));
            return textResponse("Hello, world.");
          },
        },
      });

      // WHEN the orchestrator runs the turn to completion
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // Exactly one debounced partial flush landed, in the delta file:
      // one flush of both accumulated deltas writes block 0 once — one
      // JSONL line. Without the debounce gate each delta would flush
      // separately (2 lines). The row itself sees no mid-stream write at
      // all — it was born holding the `{ ref }` at reserve time.
      expect(updateMessageContentMock).toHaveBeenCalledTimes(0);
      expect(midTurnDeltaLines).toHaveLength(1);
      const delta = JSON.parse(midTurnDeltaLines![0]) as {
        block: { type: string; text?: string };
      };
      expect(delta.block).toEqual({ type: "text", text: "Hello, world." });
      // The finalize seam folds the authoritative content inline and
      // removes the delta file.
      const finalize = finalizeMessageContentMock.mock.calls[0] as unknown as [
        string,
        string,
      ];
      expect(finalize[0]).toBe("msg-reserve");
      expect(JSON.parse(finalize[1])).toEqual([
        { type: "text", text: "Hello, world." },
      ]);
      expect(inflightDeltaFiles()).toHaveLength(0);
    });

    test("handleToolUse does NOT trigger a partial flush of its own", async () => {
      // `AgentLoop.run` emits `tool_use` strictly AFTER `message_complete`,
      // so a flush from the tool_use handler would land after the
      // authoritative final `updateContent` and overwrite the finalized
      // row (Codex P1 / Vargas review feedback). The handler must be a
      // no-op for the partial-persist accumulator.
      mockMessageById = {
        id: "msg-reserve",
        conversationId: "test-conv",
        createdAt: 1234567,
        role: "assistant",
        content: "[]",
        metadata: null,
      };

      // GIVEN a real loop that runs one tool turn — the loop emits `tool_use`
      // strictly AFTER `message_complete` — and then answers with a final
      // text turn. The tool executor returns immediately.
      const ctx = makeCtx({
        providerResponses: [
          toolUseResponse("tu-no-flush", "file_read", { path: "/foo" }),
          textResponse("done"),
        ],
        loopTools: [
          {
            name: "file_read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
        toolExecutor: async () => ({ content: "ok", isError: false }),
      });

      // WHEN the orchestrator runs the turn to completion
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // Three finalize writes land and no stray partial flush:
      //   - one finalize per `message_complete` (the tool turn and the final
      //     text turn), plus
      //   - the grouped tool-result user-row's turn-boundary finalize.
      // `handleToolUse` fires after `message_complete` removed the assistant
      // writer, so a stray flush from it would fall back to
      // `updateMessageContent` — the zero count is the regression guard.
      expect(updateMessageContentMock).toHaveBeenCalledTimes(0);
      expect(finalizeMessageContentMock).toHaveBeenCalledTimes(3);
      expect(inflightDeltaFiles()).toHaveLength(0);
    });

    test("handleMessageComplete clears any pending debounce timer before the final flush", async () => {
      mockMessageById = {
        id: "msg-reserve",
        conversationId: "test-conv",
        createdAt: 1234567,
        role: "assistant",
        content: "[]",
        metadata: null,
      };

      // GIVEN a real loop whose first turn streams a short delta (scheduling a
      // debounce timer) and completes as a tool turn — so `message_complete`
      // arrives before the 250ms timer and clears it. The tool executor then
      // holds the loop open well past the original debounce window, proving a
      // late timer does NOT fire a stray partial flush, before a final text
      // turn ends the run.
      const ctx = makeCtx({
        providerResponses: [
          {
            content: [
              { type: "text", text: "Quick reply." },
              {
                type: "tool_use",
                id: "tu-keep-alive",
                name: "file_read",
                input: {},
              },
            ],
            model: "mock-model",
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: "tool_use",
          },
          textResponse("done"),
        ],
        loopTools: [
          {
            name: "file_read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        toolExecutor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return { content: "ok", isError: false };
        },
      });

      // WHEN the orchestrator runs the turn to completion
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // Three finalize writes land: one per `message_complete` (the tool
      // turn and the final text turn) plus the grouped tool-result row's
      // turn-boundary finalize. The debounced partial would have fired
      // during the tool executor's hold — after `message_complete` removed
      // the assistant writer — so a stray late flush would fall back to
      // `updateMessageContent`; the timer-clear at the top of
      // `handleMessageComplete` is what keeps that count at zero.
      expect(updateMessageContentMock).toHaveBeenCalledTimes(0);
      expect(finalizeMessageContentMock).toHaveBeenCalledTimes(3);
      expect(inflightDeltaFiles()).toHaveLength(0);
    });

    test("partial flushes never trigger the indexer or attention projector", async () => {
      mockMessageById = {
        id: "msg-reserve",
        conversationId: "test-conv",
        createdAt: 1234567,
        role: "assistant",
        content: "[]",
        metadata: null,
      };

      // GIVEN a real loop whose provider streams a delta then holds the turn
      // open past the 250ms debounce window so the partial flush lands BEFORE
      // `message_complete`. The indexer/projector counts are snapshotted at
      // that mid-turn point (after the partial flush, before completion).
      let snapshot: [number, number] | undefined;
      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage(_messages, options) {
            options?.onEvent?.({ type: "text_delta", text: "hello world" });
            await new Promise((resolve) => setTimeout(resolve, 1100));
            snapshot = [
              indexMessageNowMock.mock.calls.length,
              projectAssistantMessageMock.mock.calls.length,
            ];
            return textResponse("hello world");
          },
        },
      });

      // WHEN the orchestrator runs the turn to completion
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      expect(snapshot).toBeDefined();
      // Indexer + projector were both ZERO during the mid-turn partial
      // flush — they only fire from `handleMessageComplete` after the
      // authoritative `updateContent`.
      expect(snapshot![0]).toBe(0);
      expect(snapshot![1]).toBe(0);
      // After the loop completes the indexer + projector each ran exactly
      // once (the pre-allocation finalize path).
      expect(indexMessageNowMock).toHaveBeenCalledTimes(1);
      expect(projectAssistantMessageMock).toHaveBeenCalledTimes(1);
    });

    test("partial flushes redact secrets from text blocks before writing", async () => {
      mockMessageById = {
        id: "msg-reserve",
        conversationId: "test-conv",
        createdAt: 1234567,
        role: "assistant",
        content: "[]",
        metadata: null,
      };
      // A GitHub PAT-shaped token mid-stream — the redaction discipline
      // mirrors `handleMessageComplete`'s final flush so a refresh mid-turn
      // never sees plaintext credentials in the persisted row.
      const ghToken = "ghp_" + "a".repeat(36);
      const payload = "Here's the key: " + ghToken + " enjoy.";

      // GIVEN a real loop whose provider streams the PAT-bearing payload as a
      // delta then holds the turn open past the 250ms debounce window so the
      // partial flush lands before `message_complete`.
      let midTurnDeltaFile: string | undefined;
      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage(_messages, options) {
            options?.onEvent?.({ type: "text_delta", text: payload });
            await new Promise((resolve) => setTimeout(resolve, 1050));
            midTurnDeltaFile = readFileSync(soleInflightDeltaPath(), "utf8");
            await new Promise((resolve) => setTimeout(resolve, 100));
            return textResponse(payload);
          },
        },
      });

      // WHEN the orchestrator runs the turn to completion
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // The raw PAT must never appear in the persisted snapshot — neither
      // in the in-flight delta file the partial flush wrote, nor in the
      // finalized inline content. The redaction substitute is
      // implementation-defined; the contract here is "the literal token
      // string is gone".
      expect(midTurnDeltaFile).toBeDefined();
      expect(midTurnDeltaFile).not.toContain(ghToken);
      const finalizeArgs = finalizeMessageContentMock.mock
        .calls[0] as unknown as [string, string];
      expect(finalizeArgs[1]).not.toContain(ghToken);
    });

    test("provider-error cleanup deletes a row that has accumulated partial content", async () => {
      // Regression check: the pre-allocation orphan-cleanup branch
      // already deletes the reserved row when the LLM call exits via
      // `provider_error`. Partial-persist writes content to that row
      // mid-turn; the cleanup must still fire and the row (along with
      // its partial content) must still be deleted before the synthetic
      // error message lands.
      reserveMessageMock.mockImplementationOnce(async () => ({
        id: "msg-orphan-with-partial",
      }));

      // GIVEN a real loop whose provider streams a delta — landing a debounced
      // partial flush on the reserved row — then rejects, so the loop emits
      // `provider_error` and `error` and exits with no `message_complete`.
      const ctx = makeCtx({
        loopProvider: {
          name: "mock-provider",
          async sendMessage(_messages, options) {
            options?.onEvent?.({ type: "text_delta", text: "hello world" });
            await new Promise((resolve) => setTimeout(resolve, 1100));
            throw new Error("upstream 500");
          },
        },
      });

      // WHEN the orchestrator runs the turn
      await runAgentLoopImpl(ctx, "hi", "msg-1", () => {});

      // The partial flush landed in the orphan row's in-flight delta file
      // exactly once (before the provider error) — the stranded fold skips
      // the deleted row, so the file's single delta line is the evidence.
      // The orphan row was then deleted; the synthetic error message is
      // inserted separately via `addMessage` (`mock-msg-id`) and never
      // touched by a content write.
      const orphanFiles = inflightDeltaFiles();
      expect(orphanFiles).toHaveLength(1);
      const orphanLines = readFileSync(orphanFiles[0], "utf8")
        .trim()
        .split("\n");
      expect(orphanLines).toHaveLength(1);
      expect(updateMessageContentMock).toHaveBeenCalledTimes(0);
      expect(deleteMessageByIdMock).toHaveBeenCalledTimes(1);
      const deleteCall = deleteMessageByIdMock.mock.calls[0] as unknown as [
        string,
      ];
      expect(deleteCall[0]).toBe("msg-orphan-with-partial");
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
    test("first-call compaction runs in the loop and drops the Slack watermark", async () => {
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
      const maybeCompactInputs: Message[][] = [];

      // Sits above the loop's first-call gate threshold (~80.75k), so the
      // loop's first-call gate owns the turn-start compaction.
      mockEstimateTokens = 90_000;

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
        } as Conversation["trustContext"],
        getTurnChannelContext: () => ({
          userMessageChannel: "slack" as const,
          assistantMessageChannel: "slack" as const,
        }),
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async (messages: Message[]) => {
            maybeCompactInputs.push(messages);
            // Drop back under budget so the post-compaction provider call
            // proceeds.
            mockEstimateTokens = 1000;
            return {
              compacted: true,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "summary" }],
                },
                messages[messages.length - 1]!,
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
        } as unknown as Conversation["contextWindowManager"],
      });

      await runAgentLoopImpl(
        ctx,
        "next reply",
        "user-msg-first-call",
        () => {},
      );

      // The loop compacts its own stripped working history, never the loaded
      // Slack transcript array, so provenance cannot be projected and the
      // watermark is left untouched — matching mid-loop compaction.
      expect(maybeCompactInputs.length).toBeGreaterThan(0);
      expect(maybeCompactInputs[0]).not.toBe(renderedSlackMessages);
      expect(
        updateConversationSlackContextWatermarkMock,
      ).not.toHaveBeenCalled();
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

      const maybeCompactInputs: Message[][] = [];

      // AND a real loop that runs one tool turn and then a final text turn.
      // The tool executor raises the token estimate above the mid-loop budget
      // threshold so the loop compacts in place at the post-tool checkpoint —
      // over its own in-loop history, which does not match the loaded Slack
      // rows.
      const ctx = makeCtx({
        providerResponses: [
          toolUseResponse("tu-mid-loop", "file_read", { path: "/foo" }),
          textResponse("final response"),
        ],
        loopTools: [
          {
            name: "file_read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
        toolExecutor: async () => {
          mockEstimateTokens = 90_000;
          return { content: "ok", isError: false };
        },
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
        } as Conversation["trustContext"],
        getTurnChannelContext: () => ({
          userMessageChannel: "slack" as const,
          assistantMessageChannel: "slack" as const,
        }),
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async (messages: Message[]) => {
            maybeCompactInputs.push(messages);
            // The mid-loop gate compacted its in-loop basis; drop the estimate
            // back under budget so the post-compaction provider call proceeds.
            mockEstimateTokens = 1000;
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
        } as unknown as Conversation["contextWindowManager"],
      });

      await runAgentLoopImpl(ctx, "next reply", "user-msg-mid-loop", () => {});

      // The mid-loop gate compacts the loop's own in-loop history, never the
      // loaded Slack rows — the mismatch this test guards against. No
      // start-of-turn compaction runs, so this is the turn's only compaction.
      expect(maybeCompactInputs).toHaveLength(1);
      expect(maybeCompactInputs[0]).not.toBe(renderedSlackMessages);
      expect(getSlackCompactionWatermarkForPrefixMock).toHaveBeenCalledWith(
        null,
        2,
      );
      expect(
        updateConversationSlackContextWatermarkMock,
      ).not.toHaveBeenCalled();
    });

    test("next inbound Slack turn loads chronological context using the persisted watermark", async () => {
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
        } as Conversation["trustContext"],
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
    });

    test("subsequent Slack turn loads chronological context using the persisted long-thread watermark", async () => {
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
        } as Conversation["trustContext"],
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

    test("applyCompactionResult advances the persisted count from the trusted in-context boundary", async () => {
      // Trusted views slice past the already-compacted prefix, so a further
      // compaction advances the persisted count from the mirrored DB boundary.

      // GIVEN a trusted (guardian) conversation that has already compacted 5
      // persisted messages, so its in-context history starts past that prefix
      const ctx = makeCtx({
        contextCompactedMessageCount: 5,
        trustContext: {
          trustClass: "guardian",
        } as Conversation["trustContext"],
      });

      // WHEN a turn compacts 4 more in-context messages
      await applyCompactionResult(
        ctx,
        makeCompactionResult({ compactedPersistedMessages: 4 }),
        () => {},
        "req-1",
      );

      // THEN the persisted count advances from the prior boundary (5 + 4)
      expect(ctx.contextCompactedMessageCount).toBe(9);
    });

    test("applyCompactionResult resets the persisted count to the unsliced boundary for untrusted views", async () => {
      // Untrusted views render history unsliced (boundary 0), so a compaction
      // must record only the new summary's prefix instead of adding to the raw
      // mirror — otherwise future loads slice past unsummarized rows.

      // GIVEN an untrusted view of a conversation whose raw DB count mirrors a
      // 5-message compacted prefix — but untrusted views render that history
      // unsliced (boundary 0), so the compactor operates on the full list
      const ctx = makeCtx({
        contextCompactedMessageCount: 5,
        trustContext: {
          trustClass: "unknown",
        } as Conversation["trustContext"],
      });

      // WHEN that turn compacts 4 in-context messages
      await applyCompactionResult(
        ctx,
        makeCompactionResult({ compactedPersistedMessages: 4 }),
        () => {},
        "req-1",
      );

      // THEN the persisted count reflects only the new summary's prefix (0 + 4)
      // rather than double-counting the raw mirror (which would yield 9)
      expect(ctx.contextCompactedMessageCount).toBe(4);
    });
  });

  describe("compaction-strip marker persistence", () => {
    test("records historyStrippedAt when overflow-recovery strip runs", async () => {
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

      // GIVEN a real loop that appends a tool turn and then rejects with a
      // context-too-large error on the following call — reactive overflow
      // recovery strips that appended history when it compacts before a final
      // call recovers.
      const ctx = makeCtx({
        providerResponses: [
          toolUseResponse("t1", "file_read", {}),
          new ContextOverflowError(
            "context_length_exceeded: 250000 tokens > 200000 maximum",
            "mock-provider",
            { actualTokens: 250_000, maxTokens: 200_000 },
          ),
          textResponse("recovered"),
        ],
        loopTools: [
          {
            name: "file_read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        toolExecutor: async () => ({ content: "ok", isError: false }),
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as Conversation["contextWindowManager"],
      });

      // WHEN the loop runs the turn to completion
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

      // GIVEN a real loop that appends a tool turn and then rejects with a
      // context-too-large error on the following call, driving the
      // overflow-recovery strip whose marker-write helper is stubbed to throw,
      // before a final call recovers.
      const ctx = makeCtx({
        providerResponses: [
          toolUseResponse("t1", "file_read", {}),
          new ContextOverflowError(
            "context_length_exceeded: 250000 tokens > 200000 maximum",
            "mock-provider",
            { actualTokens: 250_000, maxTokens: 200_000 },
          ),
          textResponse("recovered"),
        ],
        loopTools: [
          {
            name: "file_read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        toolExecutor: async () => ({ content: "ok", isError: false }),
        contextWindowManager: {
          updateConfig: () => {},
          shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
          maybeCompact: async () => ({ compacted: false }),
        } as unknown as Conversation["contextWindowManager"],
      });

      // Must not throw — the strip-site marker write is wrapped in try/catch.
      await expect(
        runAgentLoopImpl(ctx, "hello", "msg-1", () => {}),
      ).resolves.toBeUndefined();
    });
  });
});

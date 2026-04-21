/**
 * Tests for compaction event emission.
 *
 * Verifies that forceCompact() emits a `context_compacted` event (carrying
 * the fresh `estimatedInputTokens` / `maxInputTokens`) after a successful
 * compaction, so the UI indicator refreshes without waiting for the next full
 * turn. The `context_compacted` event is the single source of truth for the
 * indicator — the paired `usage_update` intentionally omits
 * `contextWindowTokens` to avoid a redundant SwiftUI invalidation.
 */
import { describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  AgentLoopConfig,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ContextWindowResult } from "../context/window-manager.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede Conversation import
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

mock.module("../memory/guardian-action-store.js", () => ({
  getGuardianActionRequest: () => null,
  resolveGuardianActionRequest: () => {},
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    llm: {
      default: {
        provider: "mock-provider",
        model: "mock-model",
        maxTokens: 4096,
        effort: "high" as const,
        speed: "standard",
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
    timeouts: { permissionTimeoutSec: 1 },
    skills: { entries: {}, allowBundled: true },
    permissions: { mode: "workspace" },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
  loadSkillBySelector: () => ({ skill: null }),
  ensureSkillIcon: async () => null,
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => [],
}));

mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
  findHighestPriorityRule: () => null,
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => [],
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  createConversation: () => ({ id: "conv-1" }),
  addMessage: () => ({ id: `msg-${Date.now()}` }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../memory/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: `att-${Date.now()}` }),
  linkAttachmentToMessage: () => {},
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

// Per-test compaction result — set before calling forceCompact().
let mockCompactResult: ContextWindowResult = {
  messages: [],
  compacted: false,
  previousEstimatedInputTokens: 0,
  estimatedInputTokens: 0,
  maxInputTokens: 0,
  thresholdTokens: 0,
  compactedMessages: 0,
  compactedPersistedMessages: 0,
  summaryCalls: 0,
  summaryInputTokens: 0,
  summaryOutputTokens: 0,
  summaryModel: "",
  summaryText: "",
};

mock.module("../context/window-manager.js", () => ({
  ContextWindowManager: class {
    nonPersistedPrefixCount = 0;
    summaryIsInjected = false;
    constructor() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact(): Promise<ContextWindowResult> {
      return mockCompactResult;
    }
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

mock.module("../memory/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

mock.module("../memory/auto-analysis-enqueue.js", () => ({
  enqueueAutoAnalysisOnCompaction: () => {},
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor(
      _provider: unknown,
      _systemPrompt: string,
      _config?: Partial<AgentLoopConfig>,
    ) {}
    getToolTokenBudget() {
      return 0;
    }
    getActiveModel() {
      return undefined;
    }
    async run(
      _messages: Message[],
      _onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
    ): Promise<Message[]> {
      return [];
    }
  },
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  listPendingCanonicalGuardianRequestsByDestinationConversation: () => [],
  listCanonicalGuardianRequests: () => [],
  listPendingRequestsByConversationScope: () => [],
  createCanonicalGuardianRequest: () => ({
    id: "mock-cg-id",
    code: "MOCK",
    status: "pending",
  }),
  getCanonicalGuardianRequest: () => null,
  getCanonicalGuardianRequestByCode: () => null,
  updateCanonicalGuardianRequest: () => {},
  resolveCanonicalGuardianRequest: () => {},
  createCanonicalGuardianDelivery: () => ({ id: "mock-cgd-id" }),
  listCanonicalGuardianDeliveries: () => [],
  listPendingCanonicalGuardianRequestsByDestinationChat: () => [],
  updateCanonicalGuardianDelivery: () => {},
  generateCanonicalRequestCode: () => "MOCK-CODE",
}));

// ---------------------------------------------------------------------------
// Import Conversation AFTER mocks
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider() {
  return {
    name: "mock-provider",
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

function makeConversation(
  collected: ServerMessage[],
  id = "conv-compact-events",
): Conversation {
  return new Conversation(
    id,
    makeProvider(),
    "system prompt",
    4096,
    (msg) => {
      collected.push(msg);
    },
    "/tmp",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("forceCompact event emission", () => {
  test("emits context_compacted and a usage_update without contextWindow when compacted", async () => {
    const collected: ServerMessage[] = [];
    mockCompactResult = {
      messages: [],
      compacted: true,
      previousEstimatedInputTokens: 150_000,
      estimatedInputTokens: 80_000,
      maxInputTokens: 200_000,
      thresholdTokens: 160_000,
      compactedMessages: 10,
      compactedPersistedMessages: 5,
      summaryCalls: 1,
      summaryInputTokens: 500,
      summaryOutputTokens: 200,
      summaryModel: "test-model",
      summaryText: "summary text",
    };

    const conversation = makeConversation(collected);
    await conversation.forceCompact();

    const compactedEvents = collected.filter(
      (m) => m.type === "context_compacted",
    );
    expect(compactedEvents.length).toBe(1);
    const compactedEvent = compactedEvents[0] as Extract<
      ServerMessage,
      { type: "context_compacted" }
    >;
    expect(compactedEvent.conversationId).toBe("conv-compact-events");
    expect(compactedEvent.estimatedInputTokens).toBe(80_000);
    expect(compactedEvent.maxInputTokens).toBe(200_000);
    expect(compactedEvent.previousEstimatedInputTokens).toBe(150_000);
    expect(compactedEvent.summaryCalls).toBe(1);
    expect(compactedEvent.summaryInputTokens).toBe(500);
    expect(compactedEvent.summaryOutputTokens).toBe(200);
    expect(compactedEvent.summaryModel).toBe("test-model");

    const usageEvents = collected.filter((m) => m.type === "usage_update");
    expect(usageEvents.length).toBe(1);
    const usageEvent = usageEvents[0] as Extract<
      ServerMessage,
      { type: "usage_update" }
    >;
    // `context_compacted` is now the single source of truth for the UI
    // indicator after compaction; the paired `usage_update` intentionally
    // omits contextWindow to avoid a redundant SwiftUI invalidation.
    expect(usageEvent.contextWindowTokens).toBeUndefined();
    expect(usageEvent.contextWindowMaxTokens).toBeUndefined();
    expect(usageEvent.inputTokens).toBe(500);
    expect(usageEvent.outputTokens).toBe(200);
    expect(usageEvent.model).toBe("test-model");
  });

  test("emits context_compacted even when summary LLM was skipped (truncation-only path)", async () => {
    const collected: ServerMessage[] = [];
    mockCompactResult = {
      messages: [],
      compacted: true,
      previousEstimatedInputTokens: 150_000,
      estimatedInputTokens: 80_000,
      maxInputTokens: 200_000,
      thresholdTokens: 160_000,
      compactedMessages: 10,
      compactedPersistedMessages: 5,
      summaryCalls: 0,
      summaryInputTokens: 0,
      summaryOutputTokens: 0,
      summaryModel: "",
      summaryText: "",
    };

    const conversation = makeConversation(collected, "conv-compact-trunc");
    await conversation.forceCompact();

    // The truncation-only path does not call the summary LLM, so
    // `recordUsage` early-returns on 0/0 tokens and no `usage_update` is
    // emitted. The client instead picks up the fresh context-window tokens
    // from the `context_compacted` event, which carries the post-compaction
    // `estimatedInputTokens` and `maxInputTokens` alongside `conversationId`.
    const compactedEvents = collected.filter(
      (m) => m.type === "context_compacted",
    );
    expect(compactedEvents.length).toBe(1);
    const compactedEvent = compactedEvents[0] as Extract<
      ServerMessage,
      { type: "context_compacted" }
    >;
    expect(compactedEvent.conversationId).toBe("conv-compact-trunc");
    expect(compactedEvent.estimatedInputTokens).toBe(80_000);
    expect(compactedEvent.maxInputTokens).toBe(200_000);

    // No usage_update synthesis in the truncation-only path (the previous
    // synthetic fallback was removed now that context_compacted carries
    // conversationId and refreshes the indicator on the client).
    expect(collected.filter((m) => m.type === "usage_update").length).toBe(0);
  });

  test("skips emission when compacted is false", async () => {
    const collected: ServerMessage[] = [];
    mockCompactResult = {
      messages: [],
      compacted: false,
      previousEstimatedInputTokens: 0,
      estimatedInputTokens: 0,
      maxInputTokens: 0,
      thresholdTokens: 0,
      compactedMessages: 0,
      compactedPersistedMessages: 0,
      summaryCalls: 0,
      summaryInputTokens: 0,
      summaryOutputTokens: 0,
      summaryModel: "",
      summaryText: "",
    };

    const conversation = makeConversation(collected, "conv-compact-noop");
    await conversation.forceCompact();

    expect(collected.filter((m) => m.type === "context_compacted").length).toBe(
      0,
    );
    expect(collected.filter((m) => m.type === "usage_update").length).toBe(0);
  });
});

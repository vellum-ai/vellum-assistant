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

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent } from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { ContextWindowResult } from "../plugins/defaults/compaction/window-manager.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede Conversation import
// ---------------------------------------------------------------------------

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
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
      profiles: {
        // Disable the catalog default so resolution lands on llm.default.
        balanced: { source: "managed", status: "disabled" },
        "cost-optimized": { source: "managed", status: "disabled" },
      },
      callSites: {
        // This file's blanket assistant-feature-flags mock forces the
        // override-or-default resolution flag ON, so the windows the
        // gate-sizing tests depend on live in call-site tweaks (which apply
        // under both resolution semantics) rather than llm.default.
        mainAgent: {
          contextWindow: { maxInputTokens: 100000 },
        },
        // Resolves a SMALLER window than mainAgent — exercised by the
        // maybeCompact gate-sizing tests below.
        memoryRetrospective: {
          contextWindow: { maxInputTokens: 50000 },
        },
      },
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    memory: { v2: { enabled: false } },
    conversations: { skipAutoRetitling: false },
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

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  setConversationHistoryStrippedAt: () => {},
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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../persistence/attachments-store.js", () => ({
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

// Config payloads handed to the manager's updateConfig — runCompaction calls
// it with the (possibly sizing-threaded) resolved context-window config
// before delegating to the manager.
const updateConfigCalls: Array<{ maxInputTokens?: number }> = [];

mock.module("../plugins/defaults/compaction/window-manager.js", () => ({
  ContextWindowManager: class {
    estimateInputTokens() {
      return 0;
    }
    get tokenCountInputs() {
      return { systemPrompt: "", tools: undefined };
    }
    nonPersistedPrefixCount = 0;
    constructor() {}
    updateConfig(cfg: { maxInputTokens?: number }) {
      updateConfigCalls.push(cfg);
    }
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact(): Promise<ContextWindowResult> {
      return mockCompactResult;
    }
    resetOverflowRecovery() {}
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

mock.module("../persistence/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    compactionCircuit = new CompactionCircuit("test-conv");
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    getResolvedTools() {
      return [];
    }
    getActiveModel() {
      return undefined;
    }
    async run(_options: {
      messages: Message[];
      onEvent: (event: AgentEvent) => void;
    }): Promise<Message[]> {
      return [];
    }
  },
}));

mock.module("../contacts/canonical-guardian-store.js", () => ({
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
    (msg) => {
      collected.push(msg);
    },
    "/tmp",
    { maxTokens: 4096 },
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
    // Quality signals derived from the summary text itself.
    expect(compactedEvent.summaryCharCount).toBe("summary text".length);
    expect(compactedEvent.summaryHeaderCount).toBe(0);
    expect(compactedEvent.summaryHadMemoryEcho).toBe(false);

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

describe("maybeCompact gate sizing", () => {
  test("default sizing resolves mainAgent's window; wake sizing resolves the wake's call-site window", async () => {
    // The auto-threshold gate derives its trip point from the
    // context-window config pushed via updateConfig. Sized against
    // mainAgent (100k here), a wake whose call site resolves a smaller
    // window (memoryRetrospective → 50k) would pass the gate un-compacted
    // and then overflow at the provider — threading the sizing makes the
    // gate see the 50k window instead.
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
    const conversation = makeConversation([], "conv-compact-sizing");

    updateConfigCalls.length = 0;
    await conversation.maybeCompact();
    await conversation.maybeCompact({ callSite: "memoryRetrospective" });

    expect(updateConfigCalls.map((cfg) => cfg.maxInputTokens)).toEqual([
      100000, 50000,
    ]);
  });

  test("forceCompact keeps mainAgent sizing", async () => {
    mockCompactResult = { ...mockCompactResult, compacted: false };
    const conversation = makeConversation([], "conv-compact-force-sizing");

    updateConfigCalls.length = 0;
    await conversation.forceCompact();

    expect(updateConfigCalls.map((cfg) => cfg.maxInputTokens)).toEqual([
      100000,
    ]);
  });
});

// ---------------------------------------------------------------------------
// computeSummaryQualitySignals — imported lazily after mocks are installed so
// the logger stub and other module replacements take effect first.
// ---------------------------------------------------------------------------

import { computeSummaryQualitySignals } from "../daemon/conversation-agent-loop.js";

describe("computeSummaryQualitySignals", () => {
  test("counts `## ` headers at the start of lines", () => {
    const summary =
      "Narrative opener.\n\n## What We're Working On\n- x\n\n## Open Threads\n- y";
    const signals = computeSummaryQualitySignals(summary);
    expect(signals.headerCount).toBe(2);
    expect(signals.charCount).toBe(summary.length);
    expect(signals.hadMemoryEcho).toBe(false);
  });

  test("reports empty signals for an empty summary", () => {
    const signals = computeSummaryQualitySignals("");
    expect(signals.charCount).toBe(0);
    expect(signals.headerCount).toBe(0);
    expect(signals.hadMemoryEcho).toBe(false);
  });

  test("flags summaries that leaked injection tags", () => {
    const leaked =
      "## Facts\nThe user had a `<memory __injected>` block in their history";
    expect(computeSummaryQualitySignals(leaked).hadMemoryEcho).toBe(true);

    const turnCtxLeak = "A <turn_context> fragment snuck through";
    expect(computeSummaryQualitySignals(turnCtxLeak).hadMemoryEcho).toBe(true);

    const nowLeak = "<NOW.md> scratchpad echo";
    expect(computeSummaryQualitySignals(nowLeak).hadMemoryEcho).toBe(true);
  });

  test("flags tags that sit next to an underscore (word-boundary gap)", () => {
    // These four tags contain underscores, so `\b` only asserts between the
    // full tag name and `>` (not between two word characters like the `e_` in
    // `workspace_top_level`). Each tag must be detected as a memory echo when
    // leaked into a summary.
    const cases = [
      "<workspace_top_level>\nlisting",
      "<active_subagents>\nstuff",
      "<active_workspace>\nstuff",
      "<active_dynamic_page>\nstuff",
    ];
    for (const leaked of cases) {
      expect(computeSummaryQualitySignals(leaked).hadMemoryEcho).toBe(true);
    }
  });

  test("does not flag ordinary mentions of the word 'memory'", () => {
    const clean =
      "## Facts\nThe user asked about their memory and remembered their dad's recipe.";
    expect(computeSummaryQualitySignals(clean).hadMemoryEcho).toBe(false);
  });
});

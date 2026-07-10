/**
 * Tests for Conversation.summarizeUpToMessage ("summarize up to here").
 *
 * Verifies the row→history boundary mapping (including the leading
 * context-summary message and the already-compacted row prefix), the guardian
 * trust swap around the fresh history load, the fail-safe mapping
 * verification, and that boundary-resolver UserErrors propagate untouched.
 * The compaction plugin entry (`defaultCompact`) is mocked so no summary LLM
 * runs — the assertions target the CompactionContext it receives.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent } from "../agent/loop.js";
import type { CompactionContext } from "../plugins/defaults/compaction/compact.js";
import type { ContextWindowResult } from "../plugins/defaults/compaction/window-manager.js";
import type { Message, ProviderResponse } from "../providers/types.js";
import { UserError } from "../util/errors.js";

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
      profiles: {},
      callSites: {},
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    memory: { v2: { enabled: false } },
    conversations: { skipAutoRetitling: false },
    timeouts: { permissionTimeoutSec: 1 },
    skills: { entries: {}, allowBundled: true },
    permissions: { mode: "workspace" },
    slack: { botUserId: "" },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => false,
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

// Mutable persisted state — each test seeds its own rows/conversation.
interface MockRow {
  id: string;
  conversationId: string;
  role: string;
  content: unknown;
  createdAt: number;
  metadata: string | null;
  clientMessageId: string | null;
}
let mockDbMessages: MockRow[] = [];
let mockConversation: Record<string, unknown> = {};
// Captured Slack watermark persists (conversationId, watermarkTs, compactedAt).
let slackWatermarkCalls: unknown[][] = [];

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  // Persist the compaction outcome back into the mock conversation row so a
  // second summarize sees the advanced compacted count (the repeat test).
  updateConversationContextWindow: (
    _conversationId: string,
    contextSummary: string,
    contextCompactedMessageCount: number,
  ) => {
    mockConversation.contextSummary = contextSummary;
    mockConversation.contextCompactedMessageCount =
      contextCompactedMessageCount;
  },
  updateConversationSlackContextWatermark: (...args: unknown[]) => {
    slackWatermarkCalls.push(args);
  },
  setConversationHistoryStrippedAt: () => {},
  deleteMessageById: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => mockDbMessages,
  getConversation: () => mockConversation,
  createConversation: () => ({ id: "conv-1" }),
  addMessage: () => ({ id: `msg-${Date.now()}` }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  resolveOverrideProfile: () => null,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

// Captured defaultCompact invocations + per-test canned result.
let compactCalls: CompactionContext[] = [];
let mockCompactResult: ContextWindowResult = makeNoopResult();

function makeNoopResult(): ContextWindowResult {
  return {
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
}

mock.module("../plugins/defaults/compaction/compact.js", () => ({
  DEFAULT_COMPACTION_PLUGIN_NAME: "default-compaction",
  defaultCompact: async (
    context: CompactionContext,
  ): Promise<ContextWindowResult> => {
    compactCalls.push(context);
    return mockCompactResult;
  },
  defaultEmergencyCompact: async (): Promise<ContextWindowResult> =>
    mockCompactResult,
}));

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
    updateConfig() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact(): Promise<ContextWindowResult> {
      return mockCompactResult;
    }
    resetOverflowRecovery() {}
  },
  createContextSummaryMessage: (summary: string) => ({
    role: "user",
    content: [{ type: "text", text: summary }],
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
import { formatSummarizeUpToResult } from "../daemon/conversation-process.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";

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

function makeConversation(): Conversation {
  const conversation = new Conversation(
    "conv-1",
    makeProvider(),
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  conversation.setTrustContext({
    trustClass: "guardian",
    sourceChannel: "vellum",
  });
  return conversation;
}

let nextCreatedAt = 1;
function row(id: string, role: string, text: string): MockRow {
  return {
    id,
    conversationId: "conv-1",
    role,
    content: [{ type: "text", text }],
    createdAt: nextCreatedAt++,
    metadata: null,
    clientMessageId: null,
  };
}

/** u1,a1,u2,a2,u3,a3 — three plain turns, ids m0..m5. */
function threeTurnRows(): MockRow[] {
  return [
    row("m0", "user", "u1"),
    row("m1", "assistant", "a1"),
    row("m2", "user", "u2"),
    row("m3", "assistant", "a2"),
    row("m4", "user", "u3"),
    row("m5", "assistant", "a3"),
  ];
}

/** A Slack-tagged row whose metadata carries a real `slackMeta.channelTs`. */
function slackRow(
  id: string,
  role: string,
  text: string,
  channelTs: string,
): MockRow {
  return {
    ...row(id, role, text),
    metadata: JSON.stringify({
      slackMeta: JSON.stringify({
        source: "slack",
        channelId: "C123",
        channelTs,
        eventKind: "message",
      }),
    }),
  };
}

/** The three-turn history as Slack-tagged rows with increasing channelTs. */
function slackThreeTurnRows(): MockRow[] {
  return [
    slackRow("m0", "user", "u1", "1000.000100"),
    slackRow("m1", "assistant", "a1", "1000.000200"),
    slackRow("m2", "user", "u2", "1000.000300"),
    slackRow("m3", "assistant", "a2", "1000.000400"),
    slackRow("m4", "user", "u3", "1000.000500"),
    slackRow("m5", "assistant", "a3", "1000.000600"),
  ];
}

const slackCapabilities = {
  channel: "slack",
  dashboardCapable: false,
  supportsDynamicUi: false,
  supportsVoiceInput: false,
};

function baseConversationRow(): Record<string, unknown> {
  return {
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation.summarizeUpToMessage", () => {
  beforeEach(() => {
    compactCalls = [];
    slackWatermarkCalls = [];
    mockCompactResult = makeNoopResult();
    mockDbMessages = threeTurnRows();
    mockConversation = baseConversationRow();
  });

  test("maps the boundary row straight through when there is no context summary", async () => {
    const conversation = makeConversation();

    const result = await conversation.summarizeUpToMessage("m4");

    expect(result).toBe(mockCompactResult);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0].force).toBe(true);
    // Row index 4 with no compacted prefix and no summary message → 4.
    expect(compactCalls[0].fixedTailStartIndex).toBe(4);
    expect(compactCalls[0].conversationId).toBe("conv-1");
    // The full guardian-scoped history is what gets compacted.
    expect(compactCalls[0].messages).toHaveLength(6);
  });

  test("offsets by the summary message and the compacted row prefix", async () => {
    mockConversation.contextSummary = "earlier summary";
    mockConversation.contextCompactedMessageCount = 2;
    const conversation = makeConversation();

    await conversation.summarizeUpToMessage("m4");

    // History is [summary, u2, a2, u3, a3]; row 4 (u3) maps to
    // 1 + (4 - 2) = 3.
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0].fixedTailStartIndex).toBe(3);
    expect(compactCalls[0].messages).toHaveLength(5);
  });

  test("snaps a mid-turn message id back to the start of its turn", async () => {
    const conversation = makeConversation();

    // m5 (assistant a3) is inside the turn started by m4 (u3).
    await conversation.summarizeUpToMessage("m5");

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0].fixedTailStartIndex).toBe(4);
  });

  test("a second summarize maps indices against the advanced compacted prefix", async () => {
    mockDbMessages = [
      ...threeTurnRows(),
      row("m6", "user", "u4"),
      row("m7", "assistant", "a4"),
    ];
    const conversation = makeConversation();

    // First summarize (up to u3): the mocked write-back path persists the
    // summary and compacted count exactly like the real
    // updateConversationContextWindow.
    mockCompactResult = {
      ...makeNoopResult(),
      compacted: true,
      compactedMessages: 4,
      compactedPersistedMessages: 4,
      summaryText: "first summary",
    };
    await conversation.summarizeUpToMessage("m4");
    expect(compactCalls[0].fixedTailStartIndex).toBe(4);
    expect(mockConversation.contextCompactedMessageCount).toBe(4);
    expect(mockConversation.contextSummary).toBe("first summary");

    // Second summarize (up to u4): history reloads as
    // [summary, u3, a3, u4, a4]; row 6 maps to 1 + (6 - 4) = 3.
    mockCompactResult = makeNoopResult();
    await conversation.summarizeUpToMessage("m6");

    expect(compactCalls).toHaveLength(2);
    expect(compactCalls[1].fixedTailStartIndex).toBe(3);
    expect(compactCalls[1].messages).toHaveLength(5);
  });

  test("swaps in the guardian trust context for the load and restores the prior context", async () => {
    const conversation = makeConversation();
    // Metadata-less rows have no untrusted provenance, so a non-guardian load
    // would filter the history to empty.
    const priorTrust = {
      trustClass: "unknown" as const,
      sourceChannel: "telegram" as const,
    };
    conversation.setTrustContext(priorTrust);

    await conversation.summarizeUpToMessage("m4");

    // Guardian-scoped load saw the full history…
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0].messages).toHaveLength(6);
    expect(compactCalls[0].fixedTailStartIndex).toBe(4);
    // …and the exact prior context is back afterward.
    expect(conversation.trustContext).toBe(priorTrust);
  });

  test("restores the prior trust context when the boundary resolver throws", async () => {
    const conversation = makeConversation();
    const priorTrust = {
      trustClass: "unknown" as const,
      sourceChannel: "telegram" as const,
    };
    conversation.setTrustContext(priorTrust);

    await expect(
      conversation.summarizeUpToMessage("missing-id"),
    ).rejects.toThrow(
      "Message missing-id does not belong to this conversation",
    );

    expect(conversation.trustContext).toBe(priorTrust);
    expect(conversation.trustContext).not.toBe(INTERNAL_GUARDIAN_TRUST_CONTEXT);
    expect(compactCalls).toHaveLength(0);
  });

  test("boundary-resolver UserErrors propagate untouched", async () => {
    const conversation = makeConversation();

    let thrown: unknown;
    try {
      // m1 is inside the very first turn — nothing before it to summarize.
      await conversation.summarizeUpToMessage("m1");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserError);
    expect((thrown as UserError).message).toBe(
      "Nothing to summarize before this message",
    );
    expect(compactCalls).toHaveLength(0);
  });

  test("Slack: a fixed boundary compacts this.messages, never the Slack chronological projection", async () => {
    mockDbMessages = slackThreeTurnRows();
    const conversation = makeConversation();
    conversation.setChannelCapabilities(slackCapabilities);

    await conversation.summarizeUpToMessage("m4");

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0].fixedTailStartIndex).toBe(4);
    // The boundary index was computed and verified against `this.messages`,
    // so that exact array must reach the compactor — the re-rendered Slack
    // chronological projection is a different array whose indices don't
    // correspond.
    expect(compactCalls[0].messages).toBe(conversation.messages);
    expect(compactCalls[0].messages).toHaveLength(6);
  });

  test("Slack: a fixed-boundary run persists the watermark derived from the summarized rows; forced compaction still derives its own", async () => {
    mockDbMessages = slackThreeTurnRows();
    const conversation = makeConversation();
    conversation.setChannelCapabilities(slackCapabilities);
    mockCompactResult = {
      ...makeNoopResult(),
      compacted: true,
      compactedMessages: 4,
      compactedPersistedMessages: 4,
      summaryText: "slack summary",
    };

    await conversation.summarizeUpToMessage("m4");

    // The watermark is the highest channelTs among the summarized rows
    // rows[0..4) (m0..m3) — the next turn's Slack projection must exclude
    // exactly the rows the new summary covers.
    expect(slackWatermarkCalls).toHaveLength(1);
    expect(slackWatermarkCalls[0][0]).toBe("conv-1");
    expect(slackWatermarkCalls[0][1]).toBe("1000.000400");

    // The forced/auto path keeps its Slack behavior — it compacts the
    // projection and persists a watermark derived from the compacted
    // prefix's channelTs values.
    await conversation.forceCompact();

    expect(slackWatermarkCalls).toHaveLength(2);
    expect(slackWatermarkCalls[1][0]).toBe("conv-1");
    expect(typeof slackWatermarkCalls[1][1]).toBe("string");
  });

  test("Slack: a fixed boundary advances an existing older watermark", async () => {
    mockDbMessages = slackThreeTurnRows();
    // A prior Slack auto-compaction left a watermark at m1's channelTs.
    // Without an advance, rows m2/m3 would be injected twice on the next
    // turn: once in the new summary and once verbatim in the projection.
    mockConversation.slackContextCompactionWatermarkTs = "1000.000200";
    const conversation = makeConversation();
    conversation.setChannelCapabilities(slackCapabilities);
    mockCompactResult = {
      ...makeNoopResult(),
      compacted: true,
      compactedMessages: 4,
      compactedPersistedMessages: 4,
      summaryText: "slack summary",
    };

    await conversation.summarizeUpToMessage("m4");

    expect(slackWatermarkCalls).toHaveLength(1);
    expect(slackWatermarkCalls[0][1]).toBe("1000.000400");
    expect(conversation.slackContextCompactionWatermarkTs).toBe("1000.000400");
  });

  test("Slack: a boundary at or before the existing watermark leaves it untouched", async () => {
    mockDbMessages = slackThreeTurnRows();
    // The existing watermark already covers every row in the summarize range
    // (rows[0..4) top out at m3's 1000.000400), so those rows are already
    // excluded from the projection — the watermark must never move backwards.
    mockConversation.slackContextCompactionWatermarkTs = "1000.000400";
    const conversation = makeConversation();
    conversation.setChannelCapabilities(slackCapabilities);
    mockCompactResult = {
      ...makeNoopResult(),
      compacted: true,
      compactedMessages: 4,
      compactedPersistedMessages: 4,
      summaryText: "slack summary",
    };

    await conversation.summarizeUpToMessage("m4");

    expect(slackWatermarkCalls).toHaveLength(0);
    expect(conversation.slackContextCompactionWatermarkTs).toBe("1000.000400");
  });

  test("Slack: no watermark advance when a kept-tail row's channelTs falls behind the prefix max", async () => {
    // Row order ≠ Slack channel order: the kept row m4 was delivered late,
    // carrying an older channelTs (1000.000350) than the summarized prefix's
    // max (m3's 1000.000400). Advancing the watermark to the prefix max
    // would exclude m4 from every future projection while the summary does
    // not cover it either — skip the advance and accept bounded duplication.
    mockDbMessages = [
      slackRow("m0", "user", "u1", "1000.000100"),
      slackRow("m1", "assistant", "a1", "1000.000200"),
      slackRow("m2", "user", "u2", "1000.000300"),
      slackRow("m3", "assistant", "a2", "1000.000400"),
      slackRow("m4", "user", "u3", "1000.000350"),
      slackRow("m5", "assistant", "a3", "1000.000600"),
    ];
    const conversation = makeConversation();
    conversation.setChannelCapabilities(slackCapabilities);
    mockCompactResult = {
      ...makeNoopResult(),
      compacted: true,
      compactedMessages: 4,
      compactedPersistedMessages: 4,
      summaryText: "slack summary",
    };

    await conversation.summarizeUpToMessage("m4");

    expect(slackWatermarkCalls).toHaveLength(0);
    expect(conversation.slackContextCompactionWatermarkTs).toBeNull();
  });

  test("non-Slack conversations persist no watermark on a fixed-boundary run", async () => {
    mockCompactResult = {
      ...makeNoopResult(),
      compacted: true,
      compactedMessages: 4,
      compactedPersistedMessages: 4,
      summaryText: "plain summary",
    };
    const conversation = makeConversation();

    await conversation.summarizeUpToMessage("m4");

    expect(slackWatermarkCalls).toHaveLength(0);
  });

  test("throws the retryable UserError and skips compaction when the mapping cannot be verified", async () => {
    // History repair inserts a synthetic tool_result user message after the
    // dangling tool_use, so in-memory indices run ahead of row indices and
    // the mapped index lands on the wrong message.
    mockDbMessages = [
      row("m0", "user", "u1"),
      {
        ...row("m1", "assistant", ""),
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      row("m2", "assistant", "continued"),
      row("m3", "user", "u2"),
      row("m4", "assistant", "a2"),
    ];
    const conversation = makeConversation();

    let thrown: unknown;
    try {
      await conversation.summarizeUpToMessage("m3");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UserError);
    expect((thrown as UserError).message).toBe(
      "Conversation history is being reorganized — try again in a moment",
    );
    expect(compactCalls).toHaveLength(0);
  });
});

describe("formatSummarizeUpToResult", () => {
  test("renders row-space counts — the synthetic summary head is not a user-visible message", () => {
    // A repeat summarize compacts the prior synthetic summary head along
    // with 12 persisted rows, so the history-space count runs one ahead.
    const card = formatSummarizeUpToResult({
      ...makeNoopResult(),
      compacted: true,
      compactedMessages: 13,
      compactedPersistedMessages: 12,
      preservedTailMessages: 4,
      previousEstimatedInputTokens: 12_000,
      estimatedInputTokens: 4_000,
    });

    expect(card).toContain("Summarized 12 earlier messages.");
    expect(card).toContain("4 recent messages kept in full.");
  });
});

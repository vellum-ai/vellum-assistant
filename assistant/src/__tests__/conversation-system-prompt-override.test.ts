/**
 * Tests for the Conversation constructor's `hasSystemPromptOverride` decision.
 *
 * When `hasSystemPromptOverride` is true the conversation freezes its
 * construction-time `systemPrompt` and reuses it verbatim every turn; when
 * false it rebuilds the prompt per turn so live trust/persona/workspace state
 * is picked up. The store-derived user-chat path passes this flag explicitly
 * because `buildSystemPrompt()` is non-deterministic (its persona slot resolves
 * through the volatile guardian-delivery cache): inferring override-ness by
 * comparing two of its outputs can spuriously freeze a normal chat onto a stale
 * persona (e.g. users/default.md) for the life of the in-memory conversation.
 *
 * Regression: the explicit flag must win over the string comparison, so a
 * normal chat (hasSystemPromptOverride: false) is never frozen even when its
 * construction-time `systemPrompt` happens to differ from a fresh build.
 */
import { describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent, AgentLoopConfig } from "../agent/loop.js";
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
  isAssistantFeatureFlagEnabled: () => false,
}));

// The value a fresh `buildSystemPrompt()` returns. The constructor's fallback
// comparison is `systemPrompt !== buildSystemPrompt()`, so a constructor arg
// equal to this is treated as a default base and one that differs is treated as
// an override (when no explicit flag is supplied).
const DEFAULT_BUILD = "default base system prompt";

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => DEFAULT_BUILD,
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

mock.module("../plugins/defaults/compaction/window-manager.js", () => ({
  ContextWindowManager: class {
    estimateInputTokens() {
      return 0;
    }
    get tokenCountInputs() {
      return { systemPrompt: "", tools: undefined };
    }
    constructor() {}
    updateConfig() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact() {
      return { compacted: false };
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
    constructor(_options?: {
      provider?: unknown;
      systemPrompt?: string;
      config?: Partial<AgentLoopConfig>;
    }) {}
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
    name: "mock",
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

function makeSendToClient(): (msg: ServerMessage) => void {
  return () => {};
}

function makeConversation(
  id: string,
  systemPrompt: string,
  options?: { hasSystemPromptOverride?: boolean },
): Conversation {
  return new Conversation(
    id,
    makeProvider(),
    systemPrompt,
    makeSendToClient(),
    "/tmp",
    { maxTokens: 4096, ...options },
  );
}

// A construction-time prompt that differs from a fresh `buildSystemPrompt()`.
// This mirrors the real bug: `buildSystemPrompt()` is non-deterministic, so the
// store-derived base build can differ from a fresh comparison build even though
// no real override was supplied.
const DIFFERS_FROM_BUILD = "stale base built when the guardian cache was cold";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation hasSystemPromptOverride resolution", () => {
  test("explicit false is honored even when systemPrompt differs from buildSystemPrompt()", () => {
    // Regression: a normal chat passes hasSystemPromptOverride=false. The prompt
    // must NOT be frozen even though the construction-time string differs from a
    // fresh build — otherwise the persona stays pinned to a stale default.
    const conversation = makeConversation(
      "conv-explicit-false",
      DIFFERS_FROM_BUILD,
      { hasSystemPromptOverride: false },
    );
    expect(conversation.hasSystemPromptOverride).toBe(false);
  });

  test("explicit true freezes the prompt", () => {
    const conversation = makeConversation(
      "conv-explicit-true",
      DEFAULT_BUILD, // even when it equals the fresh build, explicit true wins
      { hasSystemPromptOverride: true },
    );
    expect(conversation.hasSystemPromptOverride).toBe(true);
  });

  test("no flag falls back to the comparison: true when systemPrompt differs", () => {
    // The subagent manager relies on this path — its prompt is genuinely
    // non-default, so the comparison reliably yields true (freeze).
    const conversation = makeConversation(
      "conv-fallback-true",
      DIFFERS_FROM_BUILD,
    );
    expect(conversation.hasSystemPromptOverride).toBe(true);
  });

  test("no flag falls back to the comparison: false when systemPrompt equals the build", () => {
    const conversation = makeConversation("conv-fallback-false", DEFAULT_BUILD);
    expect(conversation.hasSystemPromptOverride).toBe(false);
  });
});

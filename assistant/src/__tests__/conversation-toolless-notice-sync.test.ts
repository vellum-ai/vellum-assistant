/**
 * Regression tests for tool-less-notice composition across turns.
 *
 * `syncLoopSystemPrompt` runs before every agent turn. The notice must be
 * applied fresh over the notice-free base each time — never persisted into
 * `Conversation.systemPrompt` — or an override-prompt tool-less conversation
 * (a subagent fork with `allowedTools: []`) re-appends it every turn:
 * `buildCurrentSystemPrompt` reads `this.systemPrompt` as the base when
 * `hasSystemPromptOverride` is true, so a notice written back there compounds
 * unboundedly (~300 tokens/turn) and leaks into child forks via
 * `getCurrentSystemPrompt`.
 *
 * Covers:
 * - Override-prompt tool-less conversation: multiple syncs → notice exactly
 *   once, and only one loop push (later syncs are byte-identical no-ops).
 * - Non-override tool-less conversation: same invariant.
 * - `getCurrentSystemPrompt()` (fork base) never contains the notice.
 * - Advisor-style conversation (empty allowlist + provider-native web search):
 *   no notice — the loop appends a server-side web_search tool, so the model
 *   has a real search capability the notice would falsely deny.
 * - Normal tool-bearing conversation: no notice.
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
    tools: { exclude: [] },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => false,
}));

// The mocked persona-free prompt build: any constructor arg differing from
// this string marks the conversation as having a system-prompt override.
const BUILT_PROMPT = "built system prompt";

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => BUILT_PROMPT,
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

// Capture the system prompts pushed to the agent loop.
let pushedLoopPrompts: string[] = [];

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    compactionCircuit = new CompactionCircuit("test-conv");
    constructor(_options?: {
      provider?: unknown;
      systemPrompt?: string;
      config?: Partial<AgentLoopConfig>;
    }) {}
    setSystemPrompt(systemPrompt: string) {
      pushedLoopPrompts.push(systemPrompt);
    }
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
import { TOOLLESS_CONVERSATION_NOTICE } from "../daemon/conversation-tool-setup.js";

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
  options?: { enableNativeWebSearch?: boolean },
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

function countNoticeOccurrences(prompt: string): number {
  return prompt.split(TOOLLESS_CONVERSATION_NOTICE).length - 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncLoopSystemPrompt — tool-less notice stability across turns", () => {
  test("override-prompt tool-less conversation gets the notice exactly once over multiple turns", () => {
    pushedLoopPrompts = [];
    const OVERRIDE = "FORK OVERRIDE PROMPT";
    const conversation = makeConversation("conv-override-toolless", OVERRIDE);
    expect(conversation.hasSystemPromptOverride).toBe(true);

    // Subagent fork with an empty role allowlist (e.g. `allowedTools: []`).
    conversation.setSubagentAllowedTools(new Set<string>());

    // Three turns' worth of pre-run prompt syncs.
    conversation.syncLoopSystemPrompt();
    conversation.syncLoopSystemPrompt();
    conversation.syncLoopSystemPrompt();

    // The loop received the notice exactly once, on the first sync; later
    // syncs rebuilt byte-identical prompts and pushed nothing.
    expect(pushedLoopPrompts.length).toBe(1);
    expect(pushedLoopPrompts[0]!.startsWith(OVERRIDE)).toBe(true);
    expect(countNoticeOccurrences(pushedLoopPrompts[0]!)).toBe(1);

    // The current build also carries it exactly once — no compounding.
    expect(
      countNoticeOccurrences(conversation.buildCurrentSystemPrompt()),
    ).toBe(1);
  });

  test("non-override tool-less conversation gets the notice exactly once over multiple turns", () => {
    pushedLoopPrompts = [];
    const conversation = makeConversation(
      "conv-rebuilt-toolless",
      BUILT_PROMPT,
    );
    expect(conversation.hasSystemPromptOverride).toBe(false);

    conversation.setSubagentAllowedTools(new Set<string>());

    conversation.syncLoopSystemPrompt();
    conversation.syncLoopSystemPrompt();

    expect(pushedLoopPrompts.length).toBe(1);
    expect(countNoticeOccurrences(pushedLoopPrompts[0]!)).toBe(1);
    expect(
      countNoticeOccurrences(conversation.buildCurrentSystemPrompt()),
    ).toBe(1);
  });

  test("getCurrentSystemPrompt (fork base) never contains the notice", () => {
    pushedLoopPrompts = [];
    const OVERRIDE = "FORK OVERRIDE PROMPT";
    const conversation = makeConversation("conv-fork-base", OVERRIDE);
    conversation.setSubagentAllowedTools(new Set<string>());

    conversation.syncLoopSystemPrompt();
    conversation.syncLoopSystemPrompt();

    expect(conversation.getCurrentSystemPrompt()).toBe(OVERRIDE);
  });

  test("advisor-style conversation (empty allowlist + native web search) gets no notice", () => {
    pushedLoopPrompts = [];
    const conversation = makeConversation(
      "conv-advisor",
      "ADVISOR OVERRIDE PROMPT",
      { enableNativeWebSearch: true },
    );
    conversation.setSubagentAllowedTools(new Set<string>());

    conversation.syncLoopSystemPrompt();

    // The rebuilt prompt is byte-identical to the construction prompt, so no
    // push happens and no notice is ever composed.
    expect(pushedLoopPrompts.length).toBe(0);
    expect(
      countNoticeOccurrences(conversation.buildCurrentSystemPrompt()),
    ).toBe(0);
  });

  test("normal tool-bearing conversation gets no notice", () => {
    pushedLoopPrompts = [];
    const conversation = makeConversation("conv-normal", BUILT_PROMPT);

    conversation.syncLoopSystemPrompt();

    expect(pushedLoopPrompts.length).toBe(0);
    expect(
      countNoticeOccurrences(conversation.buildCurrentSystemPrompt()),
    ).toBe(0);
  });
});

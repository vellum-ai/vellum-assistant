import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent, AgentLoopRunResult } from "../agent/loop.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type { Message, ProviderResponse } from "../providers/types.js";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../memory/guardian-action-store.js", () => ({
  getGuardianActionRequest: () => null,
  resolveGuardianActionRequest: () => {},
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    daemon: {
      titleGenerationMaxTokens: 30,
    },

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
      profiles: {},
      callSites: {},
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    memory: {
      v2: { enabled: false },
      retrieval: { scratchpadInjection: { enabled: true } },
    },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
    compaction: { enabled: true, autoThreshold: 0.7 },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// Token estimator: return a small value (well within budget) so the agent
// loop's budget gate does not trip in these tests, which exercise the
// Conversation-level ordering-error retry rather than compaction.
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () => 1000,
  estimatePromptTokensRaw: () => 1000,
  estimatePromptTokensWithTools: () => 1000,
  estimateToolsTokens: () => 0,
}));

mock.module("../daemon/context-overflow-policy.js", () => ({
  resolveOverflowAction: () => "fail_gracefully",
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  deleteMessageById: () => {},
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
  addMessage: () => ({ id: "new-msg" }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  updateConversationContextWindow: () => {},
  setConversationHistoryStrippedAt: () => {},
  getConversationOriginChannel: () => null,
  getConversationOriginInterface: () => null,
  provenanceFromTrustContext: () => ({}),
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  updateMessageContent: mock(() => {}),
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../memory/archive-store.js", () => ({
  insertCompactionEpisode: () => {},
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
    constructor() {}
    updateConfig() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact() {
      return { compacted: false };
    }
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

// Track how many times agentLoop.run was called
let agentLoopRunCount = 0;
let firstRunErrorMode: "none" | "ordering" = "ordering";

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
    async run(options: {
      messages: Message[];
      onEvent: (event: AgentEvent) => void;
    }): Promise<AgentLoopRunResult> {
      const { messages, onEvent } = options;
      // Prime the assistant row anchor — production code emits this from
      // `AgentLoop.run` just before `provider.sendMessage`.
      await onEvent({ type: "llm_call_started" });
      agentLoopRunCount++;

      const shouldError =
        firstRunErrorMode === "ordering" && agentLoopRunCount === 1;

      if (shouldError) {
        onEvent({
          type: "usage",
          inputTokens: 0,
          outputTokens: 0,
          model: "mock",
          providerDurationMs: 0,
        });
        const error = new Error(
          "tool_result blocks that are not immediately after a tool_use block",
        );
        onEvent({ type: "error", error });
        // Return unchanged — no progress
        return {
          history: [...messages],
          exitReason: null,
          appendedNewMessages: false,
          newMessages: [],
        };
      }

      // Second call (retry) or non-error: succeed normally
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 20,
        model: "mock",
        providerDurationMs: 50,
      });
      const history = [...messages];
      const assistantMsg: Message = {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
      };
      history.push(assistantMsg);
      onEvent({ type: "message_complete", message: assistantMsg });
      return {
        history,
        exitReason: null,
        appendedNewMessages: true,
        newMessages: history.slice(messages.length),
      };
    }
  },
}));

mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
  }),
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

import { Conversation } from "../daemon/conversation.js";

function makeConversation(): Conversation {
  const provider = {
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
  return new Conversation(
    "conv-1",
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
}

describe("provider ordering error retry", () => {
  beforeEach(() => {
    agentLoopRunCount = 0;
    firstRunErrorMode = "ordering";
    // The compaction pipeline runs through the plugin registry; re-register
    // every default so it has a middleware to dispatch to. Collaborators are
    // mocked above, so the default plugins' delegates go through the mocked
    // implementations.
    resetPluginRegistryAndRegisterDefaults();
  });

  test("simulated strict provider error triggers exactly one retry", async () => {
    firstRunErrorMode = "ordering";

    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await conversation.processMessage({
      content: "Hello",
      attachments: [],
      onEvent: (msg) => events.push(msg as unknown as Record<string, unknown>),
    });

    // Should have been called exactly 2 times: original + one retry
    expect(agentLoopRunCount).toBe(2);
  });

  test("[experimental] retry succeeds with repaired history and no spurious error event", async () => {
    firstRunErrorMode = "ordering";

    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await conversation.processMessage({
      content: "Hello",
      attachments: [],
      onEvent: (msg) => events.push(msg as unknown as Record<string, unknown>),
    });

    // Should have a message_complete event (from successful retry)
    const messageComplete = events.find((e) => e.type === "message_complete");
    expect(messageComplete).toBeDefined();

    // Ordering error should be suppressed when retry succeeds — no error events
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(0);

    // Should also have the assistant response in memory
    const messages = conversation.getMessages();
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
  });

  test("non-ordering errors do not trigger retry", async () => {
    firstRunErrorMode = "none";

    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await conversation.processMessage({
      content: "Hello",
      attachments: [],
      onEvent: (msg) => events.push(msg as unknown as Record<string, unknown>),
    });

    // Should have been called exactly 1 time (no retry for non-ordering errors)
    expect(agentLoopRunCount).toBe(1);
  });
});

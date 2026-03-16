import { describe, expect, mock, test } from "bun:test";

import type { Message, ProviderResponse } from "../providers/types.js";

// Capture messages passed to agentLoop.run
let capturedRunMessages: Message[] = [];

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp",
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
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    daemon: {
      startupSocketWaitMs: 5000,
      stopTimeoutMs: 5000,
      sigkillGracePeriodMs: 2000,
      titleGenerationMaxTokens: 30,
      standaloneRecording: true,
    },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
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

// Mock conversation store
let mockDbMessages: Array<{ id: string; role: string; content: string }> = [];
let mockConversation: Record<string, unknown> | null = null;

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
  getMessages: () => mockDbMessages,
  getConversation: () => mockConversation,
  createConversation: () => ({ id: "conv-1" }),
  addMessage: () => ({ id: "new-msg" }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

// Mock memory retriever to be no-op
mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",

    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
}));

// Mock AgentLoop to capture the messages it receives
mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    async run(
      messages: Message[],
      onEvent: (event: Record<string, unknown>) => void,
    ): Promise<Message[]> {
      capturedRunMessages = messages;
      // Emit usage event so processMessage doesn't error
      onEvent({
        type: "usage",
        inputTokens: 0,
        outputTokens: 0,
        model: "mock",
        providerDurationMs: 0,
      });
      // Return messages with an assistant response appended
      return [
        ...messages,
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
    }
  },
}));

// Mock context window manager
mock.module("../context/window-manager.js", () => ({
  ContextWindowManager: class {
    constructor() {}
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

function makeSession(): Conversation {
  const provider = {
    name: "mock",
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [{ type: "text", text: "hi" }],
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
    4096,
    () => {},
    "/tmp",
  );
}

describe("pre-run history repair", () => {
  test("broken runtime history gets fixed before provider call", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };

    // Simulate a corrupt in-memory state: assistant with tool_use but no tool_result follows
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ]),
      },
      // Missing tool_result user message — repaired during loadFromDb
      // but we want to verify pre-run repair also works independently
    ];

    const session = makeSession();
    await session.loadFromDb();

    // loadFromDb already repaired, but let's corrupt the in-memory state
    // by removing the synthetic user message to simulate a runtime drift
    const messages = session.getMessages();
    // After load repair: [user, assistant(tool_use), user(synthetic_tool_result)]
    // Remove the synthetic user to simulate runtime corruption
    messages.pop();

    capturedRunMessages = [];
    const events: Array<Record<string, unknown>> = [];
    await session.processMessage("Next question", [], (msg) =>
      events.push(msg as unknown as Record<string, unknown>),
    );

    // The messages passed to agentLoop.run should have been repaired
    // Find all tool_use blocks without matching tool_result
    const assistantMsgs = capturedRunMessages.filter(
      (m) => m.role === "assistant",
    );
    for (const aMsg of assistantMsgs) {
      const toolUseBlocks = aMsg.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) continue;

      // Find the next user message
      const aIdx = capturedRunMessages.indexOf(aMsg);
      const nextMsg = capturedRunMessages[aIdx + 1];
      expect(nextMsg).toBeDefined();
      expect(nextMsg.role).toBe("user");

      for (const tu of toolUseBlocks) {
        if (tu.type !== "tool_use") continue;
        const hasResult = nextMsg.content.some(
          (b) => b.type === "tool_result" && b.tool_use_id === tu.id,
        );
        expect(hasResult).toBe(true);
      }
    }
  });

  test("existing memory-recall injection still works", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [];

    const session = makeSession();
    await session.loadFromDb();

    capturedRunMessages = [];
    await session.processMessage("Hello", [], () => {});

    // Should have a user message in the captured run messages
    expect(capturedRunMessages.length).toBeGreaterThanOrEqual(1);
    const userMsg = capturedRunMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
  });
});

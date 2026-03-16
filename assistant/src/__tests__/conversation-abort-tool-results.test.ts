import { describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
} from "../providers/types.js";

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

// Track all messages persisted to DB
let persistedMessages: Array<{ role: string; content: string }> = [];

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
  addMessage: (_convId: string, role: string, content: string) => {
    persistedMessages.push({ role, content });
    return { id: `msg-${persistedMessages.length}` };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

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

// Mock AgentLoop that simulates abort after first of multiple tool calls
mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
    ): Promise<Message[]> {
      const history = [...messages];

      // Simulate provider response with 2 tool_use blocks
      const assistantMessage: Message = {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { type: "tool_use", id: "tu_2", name: "read", input: { path: "/a" } },
        ],
      };
      history.push(assistantMessage);
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 20,
        model: "mock",
        providerDurationMs: 50,
      });
      onEvent({ type: "message_complete", message: assistantMessage });

      // First tool completes — fires tool_result event
      onEvent({
        type: "tool_result",
        toolUseId: "tu_1",
        content: "file list",
        isError: false,
      });

      // Abort happens before second tool
      // Synthesize cancelled result for tu_2 (what the real AgentLoop does)
      const resultBlocks: ContentBlock[] = [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: "file list",
          is_error: false,
        },
        {
          type: "tool_result",
          tool_use_id: "tu_2",
          content: "Cancelled by user",
          is_error: true,
        },
      ];
      history.push({ role: "user", content: resultBlocks });

      return history;
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

import { Session } from "../daemon/conversation.js";

function makeSession(): Session {
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
  return new Session(
    "conv-1",
    provider,
    "system prompt",
    4096,
    () => {},
    "/tmp",
  );
}

describe("abort tool result persistence", () => {
  test("abort after first of multiple tool calls still persists all required tool_result blocks", async () => {
    persistedMessages = [];
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage("Run tools", [], () => {});

    // Find user messages in persisted data that contain tool_result
    const toolResultUserMessages = persistedMessages.filter((m) => {
      if (m.role !== "user") return false;
      try {
        const content = JSON.parse(m.content);
        return (
          Array.isArray(content) &&
          content.some((b: Record<string, unknown>) => b.type === "tool_result")
        );
      } catch {
        return false;
      }
    });

    // There should be at least one persisted user message with tool_results
    expect(toolResultUserMessages.length).toBeGreaterThanOrEqual(1);

    // Collect all persisted tool_result tool_use_ids
    const persistedToolUseIds = new Set<string>();
    for (const msg of toolResultUserMessages) {
      const content = JSON.parse(msg.content) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          persistedToolUseIds.add(block.tool_use_id);
        }
      }
    }

    // Both tu_1 and tu_2 must be persisted
    expect(persistedToolUseIds.has("tu_1")).toBe(true);
    expect(persistedToolUseIds.has("tu_2")).toBe(true);

    // No tool_use_id should appear more than once (no duplicates)
    const allToolUseIds: string[] = [];
    for (const msg of toolResultUserMessages) {
      const content = JSON.parse(msg.content) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          allToolUseIds.push(block.tool_use_id);
        }
      }
    }
    const uniqueIds = new Set(allToolUseIds);
    expect(allToolUseIds.length).toBe(uniqueIds.size);
  });

  test("restart/reload after abort does not reproduce provider ordering errors", async () => {
    persistedMessages = [];
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage("Run tools", [], () => {});

    // Simulate reload: the in-memory messages should be valid after repair
    const messages = session.getMessages();

    // Every assistant message with tool_use should be immediately followed
    // by a user message with matching tool_result
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;

      const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) continue;

      const nextMsg = messages[i + 1];
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
});

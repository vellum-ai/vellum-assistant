import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
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

let mockDbMessages: Array<{
  id: string;
  role: string;
  content: string;
  createdAt: number;
  metadata?: string | null;
}> = [];
let mockConversation: Record<string, unknown> | null = null;

mock.module("../memory/conversation-crud.js", () => ({
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => mockDbMessages,
  getConversation: () => mockConversation,
  createConversation: () => ({ id: "conv-1" }),
  addMessage: async () => ({ id: "persisted" }),
  setConversationHistoryStrippedAt: () => {},
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

import { Conversation } from "../daemon/conversation.js";

function makeConversation(): Conversation {
  const provider = {
    name: "mock",
    sendMessage: async () => ({
      content: [],
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }),
  };
  const conv = new Conversation(
    "conv-1",
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  conv.setTrustContext({ trustClass: "guardian", sourceChannel: "vellum" });
  return conv;
}

function textBlocks(content: ReadonlyArray<{ type: string; text?: string }>) {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text);
}

describe("loadFromDb with historyStrippedAt", () => {
  beforeEach(() => {
    mockDbMessages = [];
    mockConversation = null;
  });

  test("strips injection prefixes from pre-strip user content", async () => {
    const historyStrippedAt = 1000;
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      historyStrippedAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "<channel_capabilities>old</channel_capabilities>",
          },
          { type: "text", text: "Hello" },
        ]),
        createdAt: 500,
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hi back" }]),
        createdAt: 600,
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "<channel_capabilities>fresh</channel_capabilities>",
          },
          { type: "text", text: "Second turn" },
        ]),
        createdAt: 1500,
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(textBlocks(messages[0].content)).toEqual(["Hello"]);
    expect(textBlocks(messages[1].content)).toEqual(["Hi back"]);
    expect(textBlocks(messages[2].content)).toEqual([
      "<channel_capabilities>fresh</channel_capabilities>",
      "Second turn",
    ]);
  });

  test("skips metadata rehydration for pre-strip messages", async () => {
    const historyStrippedAt = 1000;
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      historyStrippedAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Pre-strip turn" }]),
        createdAt: 500,
        metadata: JSON.stringify({
          pkbContextBlock: "<knowledge_base>stale</knowledge_base>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
        createdAt: 600,
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Mid post-strip turn" },
        ]),
        createdAt: 1500,
        metadata: JSON.stringify({
          pkbContextBlock: "<knowledge_base>kept</knowledge_base>",
        }),
      },
      {
        id: "m4",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Tail reply" }]),
        createdAt: 1600,
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(textBlocks(messages[0].content)).toEqual(["Pre-strip turn"]);
    expect(textBlocks(messages[2].content).join("\n")).toContain(
      "<knowledge_base>kept</knowledge_base>",
    );
  });

  test("leaves messages untouched when historyStrippedAt is null", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      historyStrippedAt: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "<channel_capabilities>kept</channel_capabilities>",
          },
          { type: "text", text: "Hi" },
        ]),
        createdAt: 500,
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(textBlocks(messages[0].content)).toEqual([
      "<channel_capabilities>kept</channel_capabilities>",
      "Hi",
    ]);
  });
});

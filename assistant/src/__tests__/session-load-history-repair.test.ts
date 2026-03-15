import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

// Stub out heavy dependencies before importing Session
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp",
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
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
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

// Mutable store so each test can configure its own messages
let mockDbMessages: Array<{
  id: string;
  role: string;
  content: string;
  metadata?: string | null;
}> = [];
let mockConversation: Record<string, unknown> | null = null;
let nextMockMessageId = 1;

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
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
  addMessage: async (
    _conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => {
    const id = `persisted-${nextMockMessageId++}`;
    mockDbMessages.push({
      id,
      role,
      content,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
    return { id };
  },
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

import { Session } from "../daemon/session.js";

function makeSession(): Session {
  const provider = {
    name: "mock",
    sendMessage: async () => ({
      content: [],
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }),
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

describe("loadFromDb history repair", () => {
  beforeEach(() => {
    nextMockMessageId = 1;
  });

  test("repairs corrupt persisted history: missing tool_result inserted", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Hello" }]),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ]),
      },
      // Missing user message with tool_result for tu_1
      {
        id: "m3",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Done" }]),
      },
    ];

    const session = makeSession();
    await session.loadFromDb();
    const messages = session.getMessages();

    // Repair should have inserted a synthetic user message with tool_result
    expect(messages).toHaveLength(4);
    expect(messages[2].role).toBe("user");
    const trBlocks = messages[2].content.filter(
      (b) => b.type === "tool_result",
    );
    expect(trBlocks).toHaveLength(1);
    expect(trBlocks[0].type === "tool_result" && trBlocks[0].tool_use_id).toBe(
      "tu_1",
    );
  });

  test("valid history remains unchanged", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    const validMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "read", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Got it" }] },
    ];

    mockDbMessages = validMessages.map((m, i) => ({
      id: `m${i}`,
      role: m.role,
      content: JSON.stringify(m.content),
    }));

    const session = makeSession();
    await session.loadFromDb();
    const messages = session.getMessages();

    expect(messages).toEqual(validMessages);
  });

  test("invalid JSON content does not crash load path", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      { id: "m1", role: "user", content: "this is not valid json {{{" },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hi" }]),
      },
    ];

    const session = makeSession();
    // Should not throw
    await session.loadFromDb();
    const messages = session.getMessages();

    expect(messages).toHaveLength(2);
    // The broken message should have been replaced with a text block
    expect(messages[0].content[0].type).toBe("text");
    expect(
      messages[0].content[0].type === "text" && messages[0].content[0].text,
    ).toBe("this is not valid json {{{");
  });

  test("non-array JSON content is wrapped in a text block", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      { id: "m1", role: "user", content: '"hello"' },
      { id: "m2", role: "assistant", content: "42" },
      { id: "m3", role: "user", content: "{}" },
      {
        id: "m4",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Done" }]),
      },
    ];

    const session = makeSession();
    await session.loadFromDb();
    const messages = session.getMessages();

    expect(messages).toHaveLength(4);
    // String JSON should be wrapped
    expect(messages[0].content).toEqual([{ type: "text", text: '"hello"' }]);
    // Number JSON should be wrapped
    expect(messages[1].content).toEqual([{ type: "text", text: "42" }]);
    // Object JSON should be wrapped
    expect(messages[2].content).toEqual([{ type: "text", text: "{}" }]);
    // Valid array content should pass through
    expect(messages[3].content).toEqual([{ type: "text", text: "Done" }]);
  });

  test("assistant-role tool_result blocks are stripped during load", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Hello" }]),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Sure" },
          { type: "tool_result", tool_use_id: "tu_x", content: "stale" },
        ]),
      },
    ];

    const session = makeSession();
    await session.loadFromDb();
    const messages = session.getMessages();

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toEqual([{ type: "text", text: "Sure" }]);
  });

  test("untrusted actor load hides guardian-provenance history and context summary", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: "Sensitive guardian summary",
      contextCompactedMessageCount: 3,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Guardian secret question" },
        ]),
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Guardian-only answer" },
        ]),
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Untrusted follow-up" },
        ]),
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m4",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Untrusted-safe reply" },
        ]),
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
    ];

    const session = makeSession();
    session.setTrustContext({
      trustClass: "unknown",
      sourceChannel: "telegram",
    });
    await session.loadFromDb();
    const messages = session.getMessages();

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      { type: "text", text: "Untrusted follow-up" },
    ]);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toEqual([
      { type: "text", text: "Untrusted-safe reply" },
    ]);
  });

  test("ensureActorScopedHistory reloads when actor role changes", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Guardian question" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Guardian answer" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Unverified ping" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m4",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Unverified reply" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
    ];

    const session = makeSession();

    session.setTrustContext({
      trustClass: "guardian",
      sourceChannel: "telegram",
    });
    await session.ensureActorScopedHistory();
    expect(session.getMessages()).toHaveLength(4);

    session.setTrustContext({
      trustClass: "unknown",
      sourceChannel: "telegram",
    });
    await session.ensureActorScopedHistory();
    const downgradedMessages = session.getMessages();
    expect(downgradedMessages).toHaveLength(2);
    expect(downgradedMessages[0].content).toEqual([
      { type: "text", text: "Unverified ping" },
    ]);
    expect(downgradedMessages[1].content).toEqual([
      { type: "text", text: "Unverified reply" },
    ]);
  });

  test("persistUserMessage reloads actor-scoped history before persisting on role switch", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Guardian-only question" },
        ]),
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Guardian-only answer" },
        ]),
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Unverified ping" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m4",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Unverified reply" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
    ];

    const session = makeSession();

    session.setTrustContext({
      trustClass: "unknown",
      sourceChannel: "telegram",
    });
    await session.ensureActorScopedHistory();
    expect(session.getMessages()).toHaveLength(2);

    session.setTrustContext({
      trustClass: "guardian",
      sourceChannel: "telegram",
    });
    await session.persistUserMessage("Guardian follow-up", []);
    const messagesAfterPersist = session.getMessages();

    expect(messagesAfterPersist).toHaveLength(5);
    expect(messagesAfterPersist[0].content).toEqual([
      { type: "text", text: "Guardian-only question" },
    ]);
    expect(messagesAfterPersist[1].content).toEqual([
      { type: "text", text: "Guardian-only answer" },
    ]);
    expect(messagesAfterPersist[4].content).toEqual([
      { type: "text", text: "Guardian follow-up" },
    ]);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub out heavy dependencies before importing Conversation
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
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
    4096,
    () => {},
    "/tmp",
  );
  // Default to guardian trust so tests load all messages.
  conv.setTrustContext({ trustClass: "guardian", sourceChannel: "vellum" });
  return conv;
}

function defaultConv() {
  return {
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  };
}

describe("loadFromDb metadata injection rehydration", () => {
  beforeEach(() => {
    nextMockMessageId = 1;
  });

  test("memory-only rehydration still works (regression guard)", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Hi" }]),
        metadata: JSON.stringify({ memoryInjectedBlock: "remember: alice" }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello" }]),
      },
      // Ensure m1 is historical (not the tail) so memory rehydration triggers
      // on a non-tail user row. Memory applies to all rows either way, but a
      // trailing assistant message keeps things concrete.
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "<memory>\nremember: alice\n</memory>",
      },
      { type: "text", text: "Hi" },
    ]);
  });

  test("historical user row rehydrates all three injection fields", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "mem payload",
          turnContextBlock: "<turn_context>\nctx payload\n</turn_context>",
          pkbSystemReminderBlock:
            "<system_reminder>\npkb payload\n</system_reminder>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Second turn (tail)" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    // m1 is historical (not tail) — all three blocks should rehydrate in the
    // documented shape: [<turn_context>, <memory>, <system_reminder>, ...original]
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "<turn_context>\nctx payload\n</turn_context>",
      },
      {
        type: "text",
        text: "<memory>\nmem payload\n</memory>",
      },
      {
        type: "text",
        text: "<system_reminder>\npkb payload\n</system_reminder>",
      },
      { type: "text", text: "First turn" },
    ]);
  });

  test("tail user row skips turn_context and system_reminder", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail turn" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "mem payload",
          turnContextBlock: "<turn_context>\nctx\n</turn_context>",
          pkbSystemReminderBlock: "<system_reminder>\npkb\n</system_reminder>",
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    // Tail row: memory still rehydrates (existing behavior), but turn_context
    // and system_reminder are skipped — the next turn's applyRuntimeInjections
    // will supply fresh blocks for the tail.
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toEqual([
      {
        type: "text",
        text: "<memory>\nmem payload\n</memory>",
      },
      { type: "text", text: "Tail turn" },
    ]);
  });

  test("missing fields are no-op: empty metadata leaves content unchanged", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: JSON.stringify({}),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Second" }]),
        metadata: JSON.stringify({ userMessageChannel: "desktop" }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([{ type: "text", text: "First" }]);
    expect(messages[2].content).toEqual([{ type: "text", text: "Second" }]);
  });

  test("historical wrapped memoryInjectedBlock rehydrates singly-wrapped", async () => {
    // Historical v2 rows persisted `injectedBlockText` already wrapped in
    // `<memory>...</memory>`. After unifying v2's storage with v1's
    // unwrapped contract, the rehydrate path must defensively strip any
    // pre-existing wrapper so old rows don't render double-wrapped.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Hi" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "<memory>\nremember: alice\n</memory>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(2);
    const firstBlock = messages[0].content[0];
    expect(firstBlock).toEqual({
      type: "text",
      text: "<memory>\nremember: alice\n</memory>",
    });
    if (firstBlock.type !== "text") throw new Error("unexpected block type");
    expect(firstBlock.text.match(/<memory>/g)?.length).toBe(1);
  });

  test("malformed metadata is tolerated: load does not throw, content unchanged", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: "not-json",
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
    ];

    const conversation = makeConversation();
    // Should not throw
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual([{ type: "text", text: "First" }]);
  });

  test("historical user row rehydrates memoryV2StaticBlock between memory and system_reminder", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "mem payload",
          memoryV2StaticBlock:
            "<memory>\n## Essentials\n\nAlice prefers VS Code.\n</memory>",
          pkbSystemReminderBlock:
            "<system_reminder>\npkb payload\n</system_reminder>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail turn" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      { type: "text", text: "<memory>\nmem payload\n</memory>" },
      {
        type: "text",
        text: "<memory>\n## Essentials\n\nAlice prefers VS Code.\n</memory>",
      },
      {
        type: "text",
        text: "<system_reminder>\npkb payload\n</system_reminder>",
      },
      { type: "text", text: "First turn" },
    ]);
  });

  test("tail user row skips memoryV2StaticBlock", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
        metadata: JSON.stringify({
          memoryV2StaticBlock: "<memory>\n## Essentials\n\nleak\n</memory>",
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe("user");
    // Tail row receives fresh injection on the next turn — the persisted
    // static block must not rehydrate here.
    expect(messages[2].content).toEqual([{ type: "text", text: "Tail" }]);
  });

  test("untrusted-actor view does not rehydrate memoryV2StaticBlock", async () => {
    mockConversation = defaultConv();
    // Rows with `trusted_contact` / `unknown` provenance survive the
    // untrusted-actor row filter, so this isolates the rehydrate gate.
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "trusted_contact",
          memoryV2StaticBlock:
            "<memory>\n## Essentials\n\nprivate memory\n</memory>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "unknown" }),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
      },
    ];

    const conversation = makeConversation();
    conversation.setTrustContext({
      trustClass: "trusted_contact",
      sourceChannel: "telegram",
    });
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    // The historical row survives row-level filtering but the rehydrate gate
    // suppresses the personal-memory block.
    expect(messages[0].content).toEqual([{ type: "text", text: "First" }]);
  });
});

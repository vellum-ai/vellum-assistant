import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  THRESHOLD_CHARS,
  TRUNCATION_MARKER,
} from "../context/post-turn-tool-result-truncation.js";
import { resolveMessageContentBlocks } from "../persistence/message-content-file.js";
import type { Message } from "../providers/types.js";

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
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
  content: unknown;
  metadata?: string | null;
}> = [];
let mockConversation: Record<string, unknown> | null = null;
let nextMockMessageId = 1;

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
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
  getMessages: () =>
    mockDbMessages.map((m) => ({
      ...m,
      content:
        typeof m.content === "string"
          ? resolveMessageContentBlocks(m.content)
          : m.content,
    })),
  getConversation: () => mockConversation,
  createConversation: () => ({ id: "conv-1" }),
  addMessage: async (
    _conversationId: string,
    role: string,
    content: unknown,
    options?: { metadata?: Record<string, unknown> },
  ) => {
    const metadata = options?.metadata;
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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
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
  // Default to guardian trust so history repair tests load all messages.
  // Tests that exercise untrusted-actor filtering override this explicitly.
  conv.setTrustContext({ trustClass: "guardian", sourceChannel: "vellum" });
  return conv;
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
        content: [{ type: "text", text: "Hello" }],
      },
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      // Missing user message with tool_result for tu_1
      {
        id: "m3",
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

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

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

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
        content: [{ type: "text", text: "Hi" }],
      },
    ];

    const conversation = makeConversation();
    // Should not throw
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

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
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(4);
    // String JSON unwraps to its parsed value (uniform resolver semantics)
    expect(messages[0].content).toEqual([{ type: "text", text: "hello" }]);
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
        content: [{ type: "text", text: "Hello" }],
      },
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "text", text: "Sure" },
          { type: "tool_result", tool_use_id: "tu_x", content: "stale" },
        ],
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

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
        content: [{ type: "text", text: "Guardian secret question" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "Guardian-only answer" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m3",
        role: "user",
        content: [{ type: "text", text: "Untrusted follow-up" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m4",
        role: "assistant",
        content: [{ type: "text", text: "Untrusted-safe reply" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
    ];

    const conversation = makeConversation();
    conversation.setTrustContext({
      trustClass: "unknown",
      sourceChannel: "telegram",
    });
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

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
        content: [{ type: "text", text: "Guardian question" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "Guardian answer" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m3",
        role: "user",
        content: [{ type: "text", text: "Unverified ping" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m4",
        role: "assistant",
        content: [{ type: "text", text: "Unverified reply" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
    ];

    const conversation = makeConversation();

    conversation.setTrustContext({
      trustClass: "guardian",
      sourceChannel: "telegram",
    });
    await conversation.ensureActorScopedHistory();
    expect(conversation.getMessages()).toHaveLength(4);

    conversation.setTrustContext({
      trustClass: "unknown",
      sourceChannel: "telegram",
    });
    await conversation.ensureActorScopedHistory();
    const downgradedMessages = conversation.getMessages();
    expect(downgradedMessages).toHaveLength(2);
    expect(downgradedMessages[0].content).toEqual([
      { type: "text", text: "Unverified ping" },
    ]);
    expect(downgradedMessages[1].content).toEqual([
      { type: "text", text: "Unverified reply" },
    ]);
  });

  test("a stored reaction row loads as rendered text, not the sentinel", async () => {
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
        content: [{ type: "text", text: "Deploy is done" }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            messageId: "555.1",
            eventKind: "message",
          }),
        }),
      },
      {
        id: "m2",
        role: "user",
        content: [{ type: "text", text: "[reaction]" }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            eventKind: "reaction",
            reaction: {
              targetMessageId: "555.1",
              emoji: "thumbsup",
              op: "added",
              actorDisplayName: "Alice",
            },
          }),
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    // History repair merges the two adjacent user rows into one message;
    // what matters is that the model reads the rendered fact, never the
    // sentinel.
    const allText = messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(allText).not.toContain("[reaction]");
    expect(allText).toContain(
      'Alice reacted with :thumbsup: to the message "Deploy is done"',
    );
    expect(allText).toContain("<external_content");
  });

  test("markHistoryStale makes the next ensureActorScopedHistory reload", async () => {
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
        content: [{ type: "text", text: "Hello" }],
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
    ];

    const conversation = makeConversation();
    conversation.setTrustContext({
      trustClass: "guardian",
      sourceChannel: "telegram",
    });
    await conversation.loadFromDb();
    expect(conversation.getMessages()).toHaveLength(2);

    // A channel event lands straight in the store while the conversation
    // stays resident.
    mockDbMessages.push({
      id: "m3",
      role: "user",
      content: [{ type: "text", text: "[reaction]" }],
    });

    // Same actor, no stale mark: the resident history is reused.
    await conversation.ensureActorScopedHistory();
    expect(conversation.getMessages()).toHaveLength(2);

    conversation.markHistoryStale();
    await conversation.ensureActorScopedHistory();
    expect(conversation.getMessages()).toHaveLength(3);
  });

  test("a deleted row loads as the deletion marker, not its original text", async () => {
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
        content: [
          { type: "text", text: "Please forget this password: hunter2" },
        ],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            messageId: "555.1",
            eventKind: "message",
            deletedAt: 1700000001000,
          }),
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "Understood" }],
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const allText = conversation
      .getMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(allText).toContain("[This message was deleted]");
    expect(allText).not.toContain("hunter2");
  });

  test("the assistant's own deleted post keeps its content plus a visibility marker", async () => {
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
        content: [{ type: "text", text: "What time is the meeting?" }],
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "The meeting is at 3pm." }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            messageId: "555.2",
            eventKind: "message",
            deletedAt: 1700000001000,
          }),
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const assistantRow = conversation
      .getMessages()
      .find((m) => m.role === "assistant");
    const texts = (assistantRow?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""));
    // Erasure is for a retracted user message; the assistant's own words
    // stay (it did say them), and the rendered fact is lost visibility.
    expect(texts.join("\n")).toContain("The meeting is at 3pm.");
    expect(texts.join("\n")).toContain(
      "[This message was deleted from the channel and is no longer visible to participants]",
    );
  });

  test("a reaction never quotes a target that was later deleted", async () => {
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
        content: [{ type: "text", text: "secret text" }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            messageId: "555.1",
            eventKind: "message",
            deletedAt: 1700000001000,
          }),
        }),
      },
      {
        id: "m2",
        role: "user",
        content: [{ type: "text", text: "[reaction]" }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            eventKind: "reaction",
            reaction: {
              targetMessageId: "555.1",
              emoji: "thumbsup",
              op: "added",
              actorDisplayName: "Alice",
            },
          }),
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const allText = conversation
      .getMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(allText).toContain("reacted with :thumbsup: to an earlier message");
    expect(allText).not.toContain("secret text");
  });

  test("a reaction naming a later post of a split reply still quotes it", async () => {
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
        role: "assistant",
        content: [{ type: "text", text: "Deploy finished cleanly." }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            messageId: "555.1",
            additionalMessageIds: ["555.2"],
            eventKind: "message",
          }),
        }),
      },
      {
        id: "m2",
        role: "user",
        content: [{ type: "text", text: "[reaction]" }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            eventKind: "reaction",
            reaction: {
              targetMessageId: "555.2",
              emoji: "tada",
              op: "added",
              actorDisplayName: "Alice",
            },
          }),
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const allText = conversation
      .getMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(allText).toContain(":tada:");
    // The quote resolves through the split reply's later post id: the line
    // never degrades to the unresolved "an earlier message" form.
    expect(allText).not.toContain("an earlier message");
  });

  test("a partially deleted split reply quotes only its surviving posts", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    const reactionRow = (target: string, emoji: string, id: string) => ({
      id,
      role: "user",
      content: [{ type: "text", text: "[reaction]" }],
      metadata: JSON.stringify({
        providerMeta: JSON.stringify({
          source: "discord",
          conversationExternalId: "chan-1",
          eventKind: "reaction",
          reaction: {
            targetMessageId: target,
            emoji,
            op: "added",
            actorDisplayName: "Alice",
          },
        }),
      }),
    });
    mockDbMessages = [
      {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "Deploy finished cleanly." }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            messageId: "555.1",
            additionalMessageIds: ["555.2"],
            deletedMessageIds: ["555.2"],
            eventKind: "message",
          }),
        }),
      },
      // Reaction on the surviving post: still quotable.
      reactionRow("555.1", "tada", "m2"),
      // Reaction on the deleted post: degrades to the unresolved form
      // rather than quoting content no longer on the channel.
      reactionRow("555.2", "eyes", "m3"),
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const allText = conversation
      .getMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    // The row itself is NOT fully deleted: its content stays.
    expect(allText).toContain("Deploy finished cleanly.");
    // :tada: (surviving target) quotes; :eyes: (deleted target) does not.
    const tadaLine = allText
      .split("\n")
      .find((line) => line.includes(":tada:"));
    const eyesLine = allText
      .split("\n")
      .find((line) => line.includes(":eyes:"));
    expect(tadaLine).toContain("Deploy finished cleanly.");
    expect(eyesLine).toContain("an earlier message");
  });

  test("the assistant's own reaction row renders second-person", async () => {
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
        content: [{ type: "text", text: "great work" }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            messageId: "555.9",
            eventKind: "message",
          }),
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "[reaction]" }],
        metadata: JSON.stringify({
          messageKind: "reaction",
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            eventKind: "reaction",
            reaction: {
              targetMessageId: "555.9",
              emoji: "🎉",
              op: "added",
            },
          }),
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const allText = conversation
      .getMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(allText).not.toContain("[reaction]");
    expect(allText).toContain("You reacted with 🎉 to this message:");
    // The quoted target is sender text and stays fenced even in the
    // assistant's own row.
    expect(allText).toContain("great work");
    expect(allText).toContain("<external_content");
  });

  test("a reaction row does not count as a turn on rehydration", async () => {
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
        content: [{ type: "text", text: "Hello" }],
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
      {
        id: "m3",
        role: "user",
        content: [{ type: "text", text: "[reaction]" }],
        metadata: JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            eventKind: "reaction",
            reaction: {
              targetMessageId: "555.1",
              emoji: "thumbsup",
              op: "added",
            },
          }),
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    // One real user message; the reaction row never dispatched a turn, so
    // the rehydrated counter must match the live counter's one increment.
    expect(conversation.turnCount).toBe(1);
  });

  test("a slackMeta-shaped reaction row renders with its actor id as origin", async () => {
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
        content: [{ type: "text", text: "[reaction]" }],
        metadata: JSON.stringify({
          slackMeta: JSON.stringify({
            source: "slack",
            channelId: "C123",
            channelTs: "1700000000.111111",
            eventKind: "reaction",
            actorExternalUserId: "U_REACTOR",
            displayName: "Alice",
            reaction: {
              emoji: "tada",
              targetChannelTs: "1700000000.111111",
              op: "added",
              actorDisplayName: "Alice",
            },
          }),
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const allText = conversation
      .getMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(allText).toContain("Alice reacted with :tada:");
    expect(allText).toContain('origin="U_REACTOR"');
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
        content: [{ type: "text", text: "Guardian-only question" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "Guardian-only answer" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m3",
        role: "user",
        content: [{ type: "text", text: "Unverified ping" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
      {
        id: "m4",
        role: "assistant",
        content: [{ type: "text", text: "Unverified reply" }],
        metadata: JSON.stringify({
          provenanceTrustClass: "unknown",
          provenanceSourceChannel: "telegram",
        }),
      },
    ];

    const conversation = makeConversation();

    conversation.setTrustContext({
      trustClass: "unknown",
      sourceChannel: "telegram",
    });
    await conversation.ensureActorScopedHistory();
    expect(conversation.getMessages()).toHaveLength(2);

    conversation.setTrustContext({
      trustClass: "guardian",
      sourceChannel: "telegram",
    });
    await conversation.persistUserMessage({ content: "Guardian follow-up" });
    const messagesAfterPersist = conversation.getMessages();

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

describe("loadFromDb turn-count rehydration", () => {
  beforeEach(() => {
    nextMockMessageId = 1;
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
  });

  const userText = (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  });
  const assistantText = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });
  const assistantToolUse = (id: string) => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "bash", input: { cmd: "ls" } }],
  });
  const toolResult = (id: string) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  });
  const withIds = (msgs: Array<{ role: string; content: unknown }>) =>
    msgs.map((m, i) => ({ id: `m${i}`, ...m }));

  test("restores turnCount from persisted history rather than resetting to 0", async () => {
    // Three completed human turns persisted before this conversation object
    // was (re)created — e.g. after an idle eviction or daemon restart.
    mockDbMessages = withIds([
      userText("Hello"),
      assistantText("Hi"),
      userText("How are you?"),
      assistantText("Good"),
      userText("Bye"),
      assistantText("Later"),
    ]);

    const conversation = makeConversation();
    // Fresh object starts at 0 (the bug: it would stay 0 after reload).
    expect(conversation.turnCount).toBe(0);

    await conversation.loadFromDb();

    expect(conversation.turnCount).toBe(3);
  });

  test("counts a multi-iteration tool-use turn as a single turn", async () => {
    // One real user message; the tool_result user messages are continuations
    // within the same turn, not new turns.
    mockDbMessages = withIds([
      userText("convert the voice memo"),
      assistantToolUse("tu_1"),
      toolResult("tu_1"),
      assistantToolUse("tu_2"),
      toolResult("tu_2"),
      assistantText("done"),
    ]);

    const conversation = makeConversation();
    await conversation.loadFromDb();

    expect(conversation.turnCount).toBe(1);
  });

  test("counts only real user turns when tool iterations are interleaved", async () => {
    mockDbMessages = withIds([
      userText("q1"),
      assistantToolUse("tu_1"),
      toolResult("tu_1"),
      assistantText("a1"),
      userText("q2"),
      assistantText("a2"),
    ]);

    const conversation = makeConversation();
    await conversation.loadFromDb();

    expect(conversation.turnCount).toBe(2);
  });

  test("empty history yields turnCount 0", async () => {
    mockDbMessages = [];

    const conversation = makeConversation();
    await conversation.loadFromDb();

    expect(conversation.turnCount).toBe(0);
  });
});

describe("loadFromDb tool-result truncation", () => {
  beforeEach(() => {
    nextMockMessageId = 1;
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      createdAt: 1700000000000,
    };
  });

  test("oversized persisted tool_result is stubbed at load; full content lands on disk", async () => {
    // Result-time-exempt tools (web_fetch, file_read) persist full content;
    // the reload must restore the post-turn stubbed view the provider last saw.
    const fullContent = "F".repeat(THRESHOLD_CHARS + 2_000);
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "fetch it" }],
      },
      {
        id: "m2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_wf",
            name: "web_fetch",
            input: { url: "https://example.com/a" },
          },
        ],
      },
      {
        id: "m3",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_wf", content: fullContent },
        ],
      },
      {
        id: "m4",
        role: "assistant",
        content: [{ type: "text", text: "read it" }],
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    const block = messages[2].content[0];
    if (block.type !== "tool_result" || typeof block.content !== "string") {
      throw new Error("expected a string tool_result block");
    }
    expect(block.content).toContain(TRUNCATION_MARKER);
    expect(block.content.length).toBeLessThan(fullContent.length);

    // The stub names the on-disk file holding the full content.
    const pathMatch = block.content.match(
      /full result: (\S+) — use file_read to view/,
    );
    expect(pathMatch).not.toBeNull();
    expect(readFileSync(pathMatch![1], "utf-8")).toBe(fullContent);
  });

  test("already-stubbed persisted tool_result is left unchanged at load (idempotency)", async () => {
    const preStubbed =
      `head\n\n...(500 tokens omitted ${TRUNCATION_MARKER} /some/old/path.txt)\n\ntail`.padEnd(
        THRESHOLD_CHARS + 100,
        "z",
      );
    mockDbMessages = [
      {
        id: "m1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_old", name: "web_fetch", input: {} },
        ],
      },
      {
        id: "m2",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_old", content: preStubbed },
        ],
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    const block = messages[1].content[0];
    expect(
      block.type === "tool_result" && typeof block.content === "string"
        ? block.content
        : null,
    ).toBe(preStubbed);
  });
});

/**
 * A guardian card is written into the conversation the request came from by
 * the notification pairing layer, straight to the DB, while that
 * conversation's turn is parked awaiting the approval. On the next load it
 * lands between the parked turn's `tool_use` and its `tool_result`.
 *
 * The card is recognized by its own `ui_surface` id rather than a stored
 * marker, so rows written before this rule existed are dropped on the same
 * terms as new ones.
 */
describe("guardian card rows are not replayed as conversation history", () => {
  const baseConversation = {
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  };

  /** The parked turn: an approval-gated `tool_use` and the result it got. */
  const toolUseRow = {
    id: "m-use",
    role: "assistant",
    content: [
      { type: "text", text: "Running that now." },
      { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
    ],
  };
  const toolResultRow = {
    id: "m-result",
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu_1", content: "REAL RESULT" },
    ],
  };

  /** What `buildApprovalCardBlocks` persists: the surface, then its text. */
  function cardRow(surfaceId: string) {
    return {
      id: "m-card",
      role: "assistant",
      content: [
        {
          type: "ui_surface",
          surfaceId,
          surfaceType: "card",
          title: "Tool Approval",
          data: {},
          display: "inline",
        },
        { type: "text", text: "Tool Approval\nbash - requested by Alice" },
      ],
    };
  }

  function allBlocks(messages: Message[]) {
    return messages.flatMap((m) => m.content);
  }

  function toolResultsFor(messages: Message[], toolUseId: string) {
    return allBlocks(messages).filter(
      (b) => b.type === "tool_result" && b.tool_use_id === toolUseId,
    );
  }

  function serialized(value: unknown): string {
    return JSON.stringify(value);
  }

  beforeEach(() => {
    nextMockMessageId = 1;
    mockConversation = { ...baseConversation };
  });

  // Sensitivity check for the drop below: an ordinary assistant turn in the
  // same position still corrupts the pair. If the rule ever widened past
  // guardian cards, this test fails first and says so.
  test("an ordinary assistant turn between a tool_use and its result still corrupts it", async () => {
    mockDbMessages = [
      toolUseRow,
      {
        id: "m-card",
        role: "assistant",
        content: [{ type: "text", text: "Still working on it." }],
      },
      toolResultRow,
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(serialized(messages)).toContain("tool result missing from history");
    expect(serialized(messages)).toContain("[orphaned tool_result for tu_1]");
    expect(serialized(toolResultsFor(messages, "tu_1"))).not.toContain(
      "REAL RESULT",
    );
  });

  test("a guardian card is dropped and the real tool_result survives", async () => {
    mockDbMessages = [
      toolUseRow,
      cardRow("tool-approval-req-1"),
      toolResultRow,
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    // The pair is adjacent and intact: no stub, no downgrade, and exactly one
    // tool_result for tu_1 carrying the tool's own output.
    expect(serialized(messages)).not.toContain(
      "tool result missing from history",
    );
    expect(serialized(messages)).not.toContain("[orphaned tool_result");
    const results = toolResultsFor(messages, "tu_1");
    expect(results).toHaveLength(1);
    expect(results[0].type === "tool_result" && results[0].content).toBe(
      "REAL RESULT",
    );
    expect(serialized(messages)).not.toContain("Tool Approval");
    expect(messages).toHaveLength(2);
  });

  test("an access-request card is dropped on the same terms", async () => {
    mockDbMessages = [
      toolUseRow,
      cardRow("access-request-req-9"),
      toolResultRow,
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(serialized(messages)).not.toContain("[orphaned tool_result");
    expect(messages).toHaveLength(2);
  });

  test("a card as the tail row leaves history ending on a user message", async () => {
    // The prefill shape: the approval was delivered and the turn never
    // resumed, so the card is the last row. Replayed, it makes the history
    // end on an assistant turn, which extended-thinking models reject with
    // "does not support assistant message prefill".
    mockDbMessages = [toolUseRow, cardRow("tool-approval-req-1")];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages[messages.length - 1].role).toBe("user");
    // The tail is repair's fill for the still-unanswered tool_use, which is
    // correct here: the tool genuinely never ran.
    expect(toolResultsFor(messages, "tu_1")).toHaveLength(1);
  });

  test("a dropped card still restores its ui_surface for action routing", async () => {
    // Surface lifecycle and model context are different questions. The card is
    // absent from history, but its Approve/Reject buttons must keep routing
    // after a restart, which `findConversationBySurfaceId` resolves through
    // surfaceState rebuilt at load.
    mockDbMessages = [toolUseRow, cardRow("tool-approval-req-1")];

    const conversation = makeConversation();
    await conversation.loadFromDb();

    expect(serialized(conversation.getMessages())).not.toContain(
      "tool-approval-req-1",
    );
    expect(
      (
        conversation as unknown as { surfaceState: Map<string, unknown> }
      ).surfaceState.has("tool-approval-req-1"),
    ).toBe(true);
  });

  test("an assistant turn carrying a non-approval surface stays in history", async () => {
    // A wake card is unshifted onto a real turn's own content. Its surface id
    // uses a different prefix, and dropping that row would discard speech.
    mockDbMessages = [
      { id: "m-ask", role: "user", content: [{ type: "text", text: "hi" }] },
      {
        id: "m-wake",
        role: "assistant",
        content: [
          {
            type: "ui_surface",
            surfaceId: "wake-conv-1-1700000000",
            surfaceType: "card",
            title: "Conversation Woke",
            data: {},
            display: "inline",
          },
          { type: "text", text: "Picking this back up." },
        ],
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();

    expect(serialized(conversation.getMessages())).toContain(
      "Picking this back up.",
    );
  });
});

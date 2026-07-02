/**
 * Tests for assistant message reactions: the `send_reaction` tool's target
 * resolution and emoji validation, the `appendMessageReaction` persistence
 * primitive, and the `/messages` history projection of `metadata.reactions`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { ConversationMessageSchema } from "../api/responses/conversation-message.js";
import {
  clearCachedOverrides,
  setCachedOverrides,
} from "../config/feature-flag-cache.js";
import {
  addMessage,
  appendMessageReaction,
  createConversation,
  getMessageById,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";
import { ROUTES as MESSAGE_REACTION_ROUTES } from "../runtime/routes/message-reaction-routes.js";
import { executeSendReaction } from "../tools/reactions/send-reaction.js";
import type { ToolContext } from "../tools/types.js";
import { isSingleEmoji } from "../util/emoji.js";

await initializeDb();

// The `message-reactions` flag defaults off; these tests exercise the
// enabled paths, so force it on via the override cache. The flag-off
// behavior has its own describe block below.
setCachedOverrides({ "message-reactions": true }, { fromGateway: false });

// Observe published events through a real hub subscription (the tool
// broadcasts `message_reaction_updated` via `broadcastMessage`).
interface PublishedReactionUpdate {
  conversationId: string;
  messageId: string;
  reactions: Array<{ emoji: string; actor: string; createdAt: number }>;
}
const publishedReactionUpdates: PublishedReactionUpdate[] = [];
assistantEventHub.subscribe({
  type: "process",
  callback: (event) => {
    const message = (event as { message?: { type?: string } }).message;
    if (message?.type === "message_reaction_updated") {
      publishedReactionUpdates.push(message as unknown as PublishedReactionUpdate);
    }
  },
});

/** Hub delivery is serialized on an internal promise chain; let it drain. */
async function flushHub(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function resetState() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  publishedReactionUpdates.length = 0;
}

function toolContext(conversationId: string): ToolContext {
  return { conversationId, workingDir: "/tmp" } as ToolContext;
}

describe("isSingleEmoji", () => {
  test("accepts plain, variation-selector, ZWJ, skin-tone, keycap, and flag emoji", () => {
    for (const emoji of ["👍", "❤️", "👩‍💻", "👍🏽", "1️⃣", "🇨🇦", "🎉"]) {
      expect(isSingleEmoji(emoji)).toBe(true);
    }
  });

  test("rejects text, multi-emoji strings, and empty input", () => {
    for (const value of ["", "hi", "a", "👍👍", "👍 ", ":thumbsup:", "👍!"]) {
      expect(isSingleEmoji(value)).toBe(false);
    }
  });
});

describe("appendMessageReaction", () => {
  beforeEach(resetState);

  test("appends to metadata, dedupes on (emoji, actor), preserves other keys", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "great news!" }]),
      { metadata: { sentAt: 1234 } },
    );

    const first = appendMessageReaction(msg.id, {
      emoji: "🎉",
      actor: "assistant",
      createdAt: 1000,
    });
    expect(first).toEqual([
      { emoji: "🎉", actor: "assistant", createdAt: 1000 },
    ]);

    // Same (emoji, actor) is a no-op returning the existing set.
    const duped = appendMessageReaction(msg.id, {
      emoji: "🎉",
      actor: "assistant",
      createdAt: 2000,
    });
    expect(duped).toEqual(first);

    const second = appendMessageReaction(msg.id, {
      emoji: "👍",
      actor: "assistant",
      createdAt: 3000,
    });
    expect(second).toHaveLength(2);

    const row = getMessageById(msg.id);
    const metadata = JSON.parse(row?.metadata ?? "{}");
    expect(metadata.sentAt).toBe(1234);
    expect(metadata.reactions).toHaveLength(2);
  });

  test("returns null for a nonexistent message", () => {
    expect(
      appendMessageReaction("missing-id", {
        emoji: "🎉",
        actor: "assistant",
        createdAt: 1,
      }),
    ).toBeNull();
  });
});

describe("executeSendReaction", () => {
  beforeEach(resetState);

  test("reacts to the latest real user message and publishes the update", async () => {
    const conv = createConversation();
    const target = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "I got the job!" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu-1", name: "web_search", input: {} },
      ]),
    );
    // A tool_result carrier row is role=user but not user-authored — the
    // reaction must land on the text row above it.
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu-1", content: "results" },
      ]),
    );

    const result = await executeSendReaction(
      { emoji: "🎉" },
      toolContext(conv.id),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      reacted: true,
      emoji: "🎉",
      messageId: target.id,
    });

    const row = getMessageById(target.id);
    const metadata = JSON.parse(row?.metadata ?? "{}");
    expect(metadata.reactions).toHaveLength(1);
    expect(metadata.reactions[0]).toMatchObject({
      emoji: "🎉",
      actor: "assistant",
    });

    await flushHub();
    expect(publishedReactionUpdates).toHaveLength(1);
    expect(publishedReactionUpdates[0]).toMatchObject({
      conversationId: conv.id,
      messageId: target.id,
    });
  });

  test("treats an attachment-only (file block) user message as reactable", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "older message" }]),
    );
    const target = await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "file", fileId: "file-1", filename: "report.pdf" },
      ]),
    );

    const result = await executeSendReaction(
      { emoji: "📄" },
      toolContext(conv.id),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).messageId).toBe(target.id);
  });

  test("skips hidden and daemon-injected user rows when resolving the target", async () => {
    const conv = createConversation();
    const target = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "real user message" }]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "internal scaffolding" }]),
      { metadata: { hidden: true } },
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: '<background_event source="background-tool"/>' },
      ]),
      { metadata: { backgroundEventSource: "background-tool" } },
    );

    const result = await executeSendReaction(
      { emoji: "👍" },
      toolContext(conv.id),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).messageId).toBe(target.id);
  });

  test("rejects non-emoji input", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
    );

    const result = await executeSendReaction(
      { emoji: "thumbs up" },
      toolContext(conv.id),
    );
    expect(result.isError).toBe(true);
    await flushHub();
    expect(publishedReactionUpdates).toHaveLength(0);
  });

  test("errors when the conversation has no user message", async () => {
    const conv = createConversation();
    const result = await executeSendReaction(
      { emoji: "👍" },
      toolContext(conv.id),
    );
    expect(result.isError).toBe(true);
  });
});

const setReactionRoute = MESSAGE_REACTION_ROUTES.find(
  (r) => r.operationId === "message_reactions_set",
);
if (!setReactionRoute) {
  throw new Error("message_reactions_set route not registered");
}
const setReaction = (body: Record<string, unknown>) =>
  setReactionRoute.handler({ body }) as Promise<{
    messageId: string;
    reactions: Array<{ emoji: string; actor: string; createdAt: number }>;
  }>;

describe("message_reactions_set route", () => {
  beforeEach(resetState);

  async function seedAssistantMessage() {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "how did the launch go?" }]),
    );
    const target = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "text", text: "It went great — all systems nominal." },
      ]),
    );
    return { conv, target };
  }

  test("add persists a user reaction, publishes, and writes a hidden context row", async () => {
    const { conv, target } = await seedAssistantMessage();

    const result = await setReaction({
      conversationId: conv.id,
      messageId: target.id,
      emoji: "🎉",
    });
    expect(result.reactions).toEqual([
      expect.objectContaining({ emoji: "🎉", actor: "user" }),
    ]);

    const row = getMessageById(target.id);
    expect(JSON.parse(row?.metadata ?? "{}").reactions).toHaveLength(1);

    await flushHub();
    expect(publishedReactionUpdates).toHaveLength(1);
    expect(publishedReactionUpdates[0]).toMatchObject({
      conversationId: conv.id,
      messageId: target.id,
    });

    // The hidden signal row reaches the LLM history but not the UI list.
    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    }) as { messages: Array<{ id: string; content?: string }> };
    expect(response.messages).toHaveLength(2);

    const rows = getMessages(conv.id);
    const signalRow = rows.find((r) => r.content.includes("<user_reaction"));
    expect(signalRow).toBeDefined();
    expect(signalRow?.content).toContain("🎉");
    expect(signalRow?.content).toContain("It went great");
    expect(JSON.parse(signalRow?.metadata ?? "{}").hidden).toBe(true);
  });

  test("re-adding the same reaction is idempotent — no duplicate event or signal row", async () => {
    const { conv, target } = await seedAssistantMessage();
    await setReaction({
      conversationId: conv.id,
      messageId: target.id,
      emoji: "👍",
    });
    await setReaction({
      conversationId: conv.id,
      messageId: target.id,
      emoji: "👍",
    });

    await flushHub();
    expect(publishedReactionUpdates).toHaveLength(1);

    const rows = getMessages(conv.id);
    expect(
      rows.filter((r) => r.content.includes("<user_reaction")),
    ).toHaveLength(1);
  });

  test("remove deletes the reaction and writes a removal signal row", async () => {
    const { conv, target } = await seedAssistantMessage();
    await setReaction({
      conversationId: conv.id,
      messageId: target.id,
      emoji: "👍",
    });

    const result = await setReaction({
      conversationId: conv.id,
      messageId: target.id,
      emoji: "👍",
      op: "remove",
    });
    expect(result.reactions).toEqual([]);

    const rows = getMessages(conv.id);
    const signalTexts = rows
      .filter((r) => r.content.includes("<user_reaction"))
      .map(
        (r) =>
          (JSON.parse(r.content) as Array<{ text: string }>)[0]?.text ?? "",
      );
    expect(signalTexts.filter((t) => t.includes('removed="true"'))).toHaveLength(
      1,
    );
  });

  test("rejects non-assistant targets and invalid emoji", async () => {
    const conv = createConversation();
    const userMsg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
    );

    expect(
      setReaction({
        conversationId: conv.id,
        messageId: userMsg.id,
        emoji: "👍",
      }),
    ).rejects.toThrow("assistant messages");

    const { target } = await seedAssistantMessage();
    expect(
      setReaction({
        conversationId: target.conversationId,
        messageId: target.id,
        emoji: "not an emoji",
      }),
    ).rejects.toThrow("single Unicode emoji");
  });
});

describe("message-reactions flag off", () => {
  beforeEach(resetState);

  test("route 404s when the flag is off", async () => {
    clearCachedOverrides();
    try {
      const conv = createConversation();
      const target = await addMessage(
        conv.id,
        "assistant",
        JSON.stringify([{ type: "text", text: "hello" }]),
      );
      expect(
        setReaction({
          conversationId: conv.id,
          messageId: target.id,
          emoji: "👍",
        }),
      ).rejects.toThrow("not enabled");
    } finally {
      setCachedOverrides({ "message-reactions": true }, { fromGateway: false });
    }
  });
});

describe("handleListMessages reactions projection", () => {
  beforeEach(resetState);

  test("projects metadata.reactions onto the wire message", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "good morning" }]),
    );
    appendMessageReaction(msg.id, {
      emoji: "☀️",
      actor: "assistant",
      createdAt: 4000,
    });

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    }) as {
      messages: Array<{
        id: string;
        reactions?: Array<{ emoji: string; actor: string; createdAt: number }>;
      }>;
    };

    for (const message of response.messages) {
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }

    const projected = response.messages.find((m) => m.id === msg.id);
    expect(projected?.reactions).toEqual([
      { emoji: "☀️", actor: "assistant", createdAt: 4000 },
    ]);
  });

  test("omits reactions when a row has none", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    }) as { messages: Array<{ reactions?: unknown }> };

    for (const message of response.messages) {
      expect(message.reactions).toBeUndefined();
    }
  });
});

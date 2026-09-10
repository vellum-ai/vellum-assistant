import { beforeAll, describe, expect, test } from "bun:test";

import { getOrCreateConversation } from "../../persistence/conversation-key-store.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  buildScopedConversationKey,
  resolveInboundConversation,
} from "../../persistence/delivery-crud.js";
import { resolveProactiveHomeConversation } from "../conversation-pairing.js";

// A proactive post into a thread must be recorded in the conversation the
// thread's replies resolve to, so the record and the replies meet. These
// cases run the real resolvers against the test workspace's database, so
// the home and the reply's resolution are compared, not restated.

const homeParams = {
  source: "notification",
  conversationType: "background" as const,
  title: "Messages to a chat",
};

beforeAll(async () => {
  await initializeDb();
});

describe("a post into a thread lives where the thread's replies arrive", () => {
  test("telegram topic: the topic's own conversation, minted when absent and found afterwards", async () => {
    const home = await resolveProactiveHomeConversation({
      ...homeParams,
      sourceChannel: "telegram",
      externalChatId: "555000111",
      threadId: "42",
    });
    expect(home.createdNewConversation).toBe(true);

    const reply = resolveInboundConversation("telegram", "555000111", "42");
    expect(reply.conversationId).toBe(home.conversationId);

    const again = await resolveProactiveHomeConversation({
      ...homeParams,
      sourceChannel: "telegram",
      externalChatId: "555000111",
      threadId: "42",
    });
    expect(again).toEqual({
      conversationId: home.conversationId,
      createdNewConversation: false,
    });
  });

  test("slack thread with a conversation of its own: that conversation, never the flat channel's", async () => {
    const flat = getOrCreateConversation(
      buildScopedConversationKey("slack", "C0THREADED"),
    );
    const threaded = getOrCreateConversation(
      buildScopedConversationKey("slack", "C0THREADED", "1700000000.000500"),
    );
    const home = await resolveProactiveHomeConversation({
      ...homeParams,
      sourceChannel: "slack",
      externalChatId: "C0THREADED",
      threadId: "1700000000.000500",
    });
    expect(home.conversationId).toBe(threaded.conversationId);
    expect(home.conversationId).not.toBe(flat.conversationId);
  });

  test("a thread-less delivery keeps the chat-level home", async () => {
    const first = await resolveProactiveHomeConversation({
      ...homeParams,
      sourceChannel: "telegram",
      externalChatId: "555000222",
    });
    const second = await resolveProactiveHomeConversation({
      ...homeParams,
      sourceChannel: "telegram",
      externalChatId: "555000222",
    });
    expect(first.createdNewConversation).toBe(true);
    expect(second).toEqual({
      conversationId: first.conversationId,
      createdNewConversation: false,
    });
    const topic = await resolveProactiveHomeConversation({
      ...homeParams,
      sourceChannel: "telegram",
      externalChatId: "555000222",
      threadId: "7",
    });
    expect(topic.conversationId).not.toBe(first.conversationId);
  });
});

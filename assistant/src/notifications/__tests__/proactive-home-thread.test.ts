import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// A proactive post into a thread must be recorded in the conversation the
// thread's replies resolve to, so the record and the replies meet. These
// cases run the real resolvers against the test workspace's database, so
// the home and the reply's resolution are compared, not restated. The sync
// publisher is observed, since a conversation minted here has to reach the
// conversation list on its own.

const listChanged = mock((_reason: string) => {});
const actualSync = await import("../../runtime/sync/resource-sync-events.js");
mock.module("../../runtime/sync/resource-sync-events.js", () => ({
  ...actualSync,
  publishConversationListChanged: listChanged,
}));

const { getOrCreateConversation } =
  await import("../../persistence/conversation-key-store.js");
const { initializeDb } = await import("../../persistence/db-init.js");
const { buildScopedConversationKey, resolveInboundConversation } =
  await import("../../persistence/delivery-crud.js");
const { resolveProactiveHomeConversation } =
  await import("../conversation-pairing.js");

const homeParams = {
  source: "notification",
  conversationType: "background" as const,
  title: "Messages to a chat",
};

beforeAll(async () => {
  await initializeDb();
});

beforeEach(() => {
  listChanged.mockClear();
});

describe("a post into a thread lives where the thread's replies arrive", () => {
  test("telegram topic: the topic's own conversation, minted and announced when absent, found afterwards", async () => {
    const home = await resolveProactiveHomeConversation({
      ...homeParams,
      sourceChannel: "telegram",
      externalChatId: "555000111",
      threadId: "42",
    });
    expect(home.createdNewConversation).toBe(true);
    expect(listChanged).toHaveBeenCalledTimes(1);
    expect(listChanged).toHaveBeenCalledWith("created");

    const reply = resolveInboundConversation("telegram", "555000111", "42");
    expect(reply.conversationId).toBe(home.conversationId);

    listChanged.mockClear();
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
    expect(listChanged).not.toHaveBeenCalled();
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
    expect(listChanged).not.toHaveBeenCalled();
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
    expect(listChanged).toHaveBeenCalledTimes(1);
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

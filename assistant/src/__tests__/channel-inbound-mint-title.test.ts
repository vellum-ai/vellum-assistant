/**
 * A channel conversation is titled at the moment `recordInbound` mints it, so
 * no lane that returns without a turn can leave it on the "Generating title..."
 * placeholder. These cases drive the handler end to end against the real
 * database and read the title back.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => {},
}));

import { getConversationByKey } from "../persistence/conversation-key-store.js";
import {
  AUTO_TITLE_DETERMINISTIC,
  GENERATING_TITLE,
} from "../persistence/conversation-title-service.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  channelInboundEvents,
  conversations,
} from "../persistence/schema/index.js";
import {
  handleChannelInbound,
  seedContactChannel,
  setAdapterProcessMessage,
} from "./helpers/channel-test-adapter.js";
import { bridgeState } from "./helpers/gateway-guardian-requests-store-bridge.js";
import { setConfig } from "./helpers/set-config.js";

await initializeDb();

const CHAT_KEY = "asst:self:telegram:chat-123";

function resetTables(): void {
  bridgeState.reset();
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": "test-token",
    },
    body: JSON.stringify({
      sourceChannel: "telegram",
      interface: "telegram",
      conversationExternalId: "chat-123",
      externalMessageId: `msg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      content: "hello",
      actorExternalId: "telegram-user-1",
      actorDisplayName: "Alice Example",
      actorUsername: "alice",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      ...overrides,
    }),
  });
}

function readTitle(): { title: string | null; isAutoTitle: number } {
  const mapping = getConversationByKey(CHAT_KEY);
  expect(mapping).not.toBeNull();
  const row = getDb()
    .select({
      title: conversations.title,
      isAutoTitle: conversations.isAutoTitle,
    })
    .from(conversations)
    .where(eq(conversations.id, mapping!.conversationId))
    .get();
  expect(row).toBeDefined();
  return row!;
}

describe("channel inbound mint title", () => {
  beforeEach(() => {
    resetTables();
    seedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "telegram-user-1",
      displayName: "Alice Example",
      status: "active",
      policy: "allow",
    });
    setAdapterProcessMessage(async () => ({ messageId: "msg-1" }));
    setConfig("secretDetection", { enabled: false, blockIngress: false });
  });

  test("a first message mints the conversation with a sender title", async () => {
    const res = await handleChannelInbound(makeInboundRequest());
    expect(res.status).toBe(200);

    expect(readTitle()).toEqual({
      title: "Message from Alice Example",
      isAutoTitle: AUTO_TITLE_DETERMINISTIC,
    });
  });

  test("falls back to the username, then the external id, then the channel", async () => {
    await handleChannelInbound(
      makeInboundRequest({ actorDisplayName: undefined }),
    );
    expect(readTitle().title).toBe("Message from alice");

    resetTables();
    seedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "telegram-user-1",
      displayName: "Alice Example",
      status: "active",
      policy: "allow",
    });
    await handleChannelInbound(
      makeInboundRequest({
        actorDisplayName: undefined,
        actorUsername: undefined,
      }),
    );
    expect(readTitle().title).toBe("Message from telegram-user-1");
  });

  test("a message blocked for containing a secret still leaves a titled conversation", async () => {
    setConfig("secretDetection", { enabled: true, blockIngress: true });
    const processMessage = mock(async () => {
      throw new Error("processMessage should not run");
    });
    setAdapterProcessMessage(processMessage);

    const res = await handleChannelInbound(
      makeInboundRequest({
        content: "My key is GOCSPX-abcdefghijklmnopqrstuvwxyz12",
      }),
    );
    expect(res.status).toBe(200);
    expect(processMessage).not.toHaveBeenCalled();
    const event = getDb().select().from(channelInboundEvents).get();
    expect(event?.processingStatus).toBe("processed");
    expect(event?.rawPayload).toBeNull();

    const row = readTitle();
    expect(row.title).not.toBe(GENERATING_TITLE);
    expect(row).toEqual({
      title: "Message from Alice Example",
      isAutoTitle: AUTO_TITLE_DETERMINISTIC,
    });
  });

  test("a later message in the same chat never retitles the conversation", async () => {
    await handleChannelInbound(makeInboundRequest());
    const mapping = getConversationByKey(CHAT_KEY);
    getDb()
      .update(conversations)
      .set({ title: "Lunch plans", isAutoTitle: 0 })
      .where(eq(conversations.id, mapping!.conversationId))
      .run();

    await handleChannelInbound(
      makeInboundRequest({ actorDisplayName: "Bob Example" }),
    );

    expect(readTitle()).toEqual({ title: "Lunch plans", isAutoTitle: 0 });
  });
});

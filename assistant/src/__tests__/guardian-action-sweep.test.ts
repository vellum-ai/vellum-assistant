import { beforeEach, describe, expect, mock, test } from "bun:test";

const deliveredMessages: Array<{
  url: string;
  body: Record<string, unknown>;
}> = [];

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (url: string, body: Record<string, unknown>) => {
    deliveredMessages.push({ url, body });
  },
}));

import type { ExpiryDeliveryInfo } from "../calls/guardian-action-sweep.js";
import { sendGuardianExpiryNotices } from "../calls/guardian-action-sweep.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations, messages } from "../persistence/schema/index.js";

await initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function makeDelivery(
  overrides: Partial<ExpiryDeliveryInfo> = {},
): ExpiryDeliveryInfo {
  return {
    id: "delivery-1",
    status: "sent",
    destinationChannel: "telegram",
    destinationConversationId: null,
    destinationChatId: "chat-123",
    ...overrides,
  };
}

describe("sendGuardianExpiryNotices", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    deliveredMessages.length = 0;
  });

  test("sends external channel expiry notices for sent deliveries", async () => {
    await sendGuardianExpiryNotices(
      [
        makeDelivery({ status: "sent" }),
        makeDelivery({
          id: "d2",
          status: "pending",
          destinationChatId: "chat-456",
        }),
      ],
      "assistant-1",
    );

    expect(deliveredMessages).toHaveLength(2);
    expect(deliveredMessages[0].url).toBe("/deliver/telegram");
    expect(deliveredMessages[0].body.chatId).toBe("chat-123");
    expect(deliveredMessages[0].body.assistantId).toBe("assistant-1");
    expect(deliveredMessages[1].body.chatId).toBe("chat-456");
  });

  test("skips deliveries that are not sent or pending", async () => {
    await sendGuardianExpiryNotices(
      [
        makeDelivery({ status: "failed" }),
        makeDelivery({ id: "d2", status: "expired" }),
      ],
      "assistant-1",
    );

    expect(deliveredMessages).toHaveLength(0);
  });

  test("adds an expiry message to vellum guardian conversations", async () => {
    ensureConversation("guardian-conv");

    await sendGuardianExpiryNotices(
      [
        makeDelivery({
          destinationChannel: "vellum",
          destinationConversationId: "guardian-conv",
          destinationChatId: null,
        }),
      ],
      "assistant-1",
    );

    expect(deliveredMessages).toHaveLength(0);
    const db = getDb();
    const rows = db.select().from(messages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].conversationId).toBe("guardian-conv");
    expect(rows[0].content).toContain("expired");
  });
});

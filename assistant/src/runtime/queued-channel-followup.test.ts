import { beforeEach, describe, expect, mock, test } from "bun:test";

const markedProcessed: string[] = [];
const markedDelivered: string[] = [];
const linked: Array<{ eventId: string; messageId: string }> = [];
const storedReplies: Array<{ eventId: string; replyMessageId: string }> = [];
const finalized: Array<{ eventId: string; userMessageId?: string }> = [];

mock.module("../persistence/delivery-crud.js", () => ({
  linkMessage: (eventId: string, messageId: string) => {
    linked.push({ eventId, messageId });
  },
  storeReplyMessageId: (eventId: string, replyMessageId: string) => {
    storedReplies.push({ eventId, replyMessageId });
  },
}));

mock.module("../persistence/delivery-status.js", () => ({
  markProcessed: (eventId: string) => {
    markedProcessed.push(eventId);
  },
  markDeliveryDelivered: (eventId: string) => {
    markedDelivered.push(eventId);
  },
}));

mock.module("./finalize-event-delivery.js", () => ({
  finalizeEventDelivery: async (params: {
    eventId: string;
    userMessageId?: string;
  }) => {
    finalized.push({
      eventId: params.eventId,
      userMessageId: params.userMessageId,
    });
  },
}));

mock.module("./gateway-client.js", () => ({
  deliverChannelReply: async () => ({ ok: true }),
}));

import type { QueuedMessage } from "../daemon/conversation-queue-manager.js";
import {
  completeQueuedChannelFollowUps,
  linkQueuedChannelIngress,
} from "./queued-channel-followup.js";

function telegramQueued(eventId: string): QueuedMessage {
  return {
    content: "follow-up",
    attachments: [],
    requestId: `req-${eventId}`,
    onEvent: () => {},
    sentAt: Date.now(),
    channelDelivery: {
      eventId,
      externalChatId: "12345",
      sourceChannel: "telegram",
      replyCallbackUrl: "https://example.test/deliver/telegram",
    },
  };
}

describe("queued Telegram follow-up delivery", () => {
  beforeEach(() => {
    markedProcessed.length = 0;
    markedDelivered.length = 0;
    linked.length = 0;
    storedReplies.length = 0;
    finalized.length = 0;
  });

  test("links the inbound event to the persisted user message", () => {
    linkQueuedChannelIngress(telegramQueued("evt-1"), "user-1");
    expect(linked).toEqual([{ eventId: "evt-1", messageId: "user-1" }]);
  });

  test("finalizes one Telegram reply for a batched follow-up and settles siblings", async () => {
    await completeQueuedChannelFollowUps({
      items: [telegramQueued("evt-a"), telegramQueued("evt-b")],
      conversationId: "conv-1",
      lastUserMessageId: "user-tail",
      replyMessageId: "asst-1",
    });

    expect(markedProcessed).toEqual(["evt-a", "evt-b"]);
    expect(storedReplies).toEqual([
      { eventId: "evt-a", replyMessageId: "asst-1" },
      { eventId: "evt-b", replyMessageId: "asst-1" },
    ]);
    expect(finalized).toEqual([
      { eventId: "evt-a", userMessageId: "user-tail" },
    ]);
    expect(markedDelivered).toEqual(["evt-b"]);
  });

  test("is a no-op when the drained items are not channel follow-ups", async () => {
    await completeQueuedChannelFollowUps({
      items: [
        {
          content: "web",
          attachments: [],
          requestId: "req-web",
          onEvent: () => {},
          sentAt: Date.now(),
        },
      ],
      conversationId: "conv-1",
      lastUserMessageId: "user-1",
    });
    expect(markedProcessed).toEqual([]);
    expect(finalized).toEqual([]);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks: declared before imports that depend on them ──────────────

let updateMessageContentShouldThrow = false;

const updateMessageContentMock = mock(
  (_messageId: string, _content: string) => {
    if (updateMessageContentShouldThrow) {
      throw new Error("DB write failed");
    }
  },
);

mock.module("../persistence/conversation-crud.js", () => ({
  updateMessageContent: updateMessageContentMock,
}));

const messagesInvalidated: string[] = [];

mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishConversationMessagesChanged: (conversationId: string) => {
    messagesInvalidated.push(conversationId);
  },
}));

import type { AssistantEvent } from "../api/index.js";
import { VellumAdapter } from "../notifications/adapters/macos.js";
import type {
  ChannelDeliveryPayload,
  ChannelDestination,
} from "../notifications/types.js";

function makePayload(
  overrides?: Partial<ChannelDeliveryPayload>,
): ChannelDeliveryPayload {
  return {
    deliveryId: "delivery-uuid-1",
    sourceEventName: "schedule.notify",
    copy: { title: "Reminder", body: "Hello" },
    urgency: "medium",
    ...overrides,
  };
}

function makeDestination(
  overrides?: Partial<ChannelDestination>,
): ChannelDestination {
  return {
    channel: "vellum",
    ...overrides,
  };
}

function captureBroadcast(): {
  adapter: VellumAdapter;
  sent: AssistantEvent[];
} {
  const sent: AssistantEvent[] = [];
  const adapter = new VellumAdapter((msg) => sent.push(msg));
  return { adapter, sent };
}

describe("VellumAdapter silent flag", () => {
  test("non-urgent (low) urgency broadcasts silent: true", async () => {
    const { adapter, sent } = captureBroadcast();
    const result = await adapter.send(
      makePayload({ urgency: "low" }),
      makeDestination(),
    );

    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.type).toBe("notification_intent");
    expect(intent.silent).toBe(true);
  });

  test("non-urgent (medium) urgency broadcasts silent: true", async () => {
    const { adapter, sent } = captureBroadcast();
    await adapter.send(makePayload({ urgency: "medium" }), makeDestination());

    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.silent).toBe(true);
  });

  test("urgent (high) urgency broadcasts silent: false", async () => {
    const { adapter, sent } = captureBroadcast();
    await adapter.send(makePayload({ urgency: "high" }), makeDestination());

    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.silent).toBe(false);
  });

  test("critical urgency broadcasts silent: false", async () => {
    const { adapter, sent } = captureBroadcast();
    await adapter.send(makePayload({ urgency: "critical" }), makeDestination());

    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.silent).toBe(false);
  });

  test("broadcasts title, body, deepLinkTarget, and deliveryId verbatim", async () => {
    const { adapter, sent } = captureBroadcast();
    await adapter.send(
      makePayload({
        deliveryId: "delivery-xyz",
        copy: { title: "T", body: "B" },
        deepLinkTarget: { conversationId: "conv-abc" },
        urgency: "high",
      }),
      makeDestination(),
    );

    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.deliveryId).toBe("delivery-xyz");
    expect(intent.title).toBe("T");
    expect(intent.body).toBe("B");
    expect(intent.deepLinkMetadata).toEqual({ conversationId: "conv-abc" });
    expect(intent.silent).toBe(false);
  });
});

describe("VellumAdapter remotePushDispatched pass-through", () => {
  test("broadcasts remote push acceptance fields verbatim", async () => {
    const { adapter, sent } = captureBroadcast();
    await adapter.send(
      makePayload({
        remotePushDispatched: true,
        remotePushPlatforms: ["ios"],
      }),
      makeDestination(),
    );

    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.remotePushDispatched).toBe(true);
    expect(intent.remotePushPlatforms).toEqual(["ios"]);
  });

  test("broadcasts remotePushDispatched: false verbatim", async () => {
    const { adapter, sent } = captureBroadcast();
    await adapter.send(
      makePayload({ remotePushDispatched: false }),
      makeDestination(),
    );

    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.remotePushDispatched).toBe(false);
  });

  test("leaves remotePushDispatched undefined when absent from the payload", async () => {
    const { adapter, sent } = captureBroadcast();
    await adapter.send(makePayload(), makeDestination());

    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.remotePushDispatched).toBeUndefined();
  });
});

describe("VellumAdapter update", () => {
  beforeEach(() => {
    updateMessageContentMock.mockClear();
    updateMessageContentShouldThrow = false;
    messagesInvalidated.length = 0;
  });

  test("rewrites the persisted conversation message with the new body", async () => {
    const { adapter } = captureBroadcast();

    const result = await adapter.update!(
      {
        deliveryId: "delivery-1",
        destination: "vellum",
        messageId: "msg-1",
        conversationId: "conv-1",
      },
      { title: "Daily Briefing", body: "Revised briefing text." },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg-1");
    expect(updateMessageContentMock).toHaveBeenCalledTimes(1);
    expect(updateMessageContentMock.mock.calls[0]).toEqual([
      "msg-1",
      "Revised briefing text.",
    ]);
    // A client holding the conversation open refetches on this tag alone.
    expect(messagesInvalidated).toEqual(["conv-1"]);
  });

  test("rewrites without a conversation to invalidate", async () => {
    // Deliveries recorded before the pairing carried a conversation have none
    // to name, and the rewrite still stands on its own.
    const { adapter } = captureBroadcast();

    const result = await adapter.update!(
      { deliveryId: "delivery-1", destination: "vellum", messageId: "msg-1" },
      { body: "Revised briefing text." },
    );

    expect(result.success).toBe(true);
    expect(updateMessageContentMock).toHaveBeenCalledTimes(1);
    expect(messagesInvalidated).toHaveLength(0);
  });

  test("leaves the message untouched on a title-only edit", async () => {
    // The feed rewrites its summary only when the patch carries a body, so
    // writing the title here would put the conversation out of step with the
    // card it is supposed to match.
    const { adapter } = captureBroadcast();

    const result = await adapter.update!(
      { deliveryId: "delivery-1", destination: "vellum", messageId: "msg-1" },
      { title: "Daily Briefing" },
    );

    expect(result.success).toBe(true);
    expect(updateMessageContentMock).not.toHaveBeenCalled();
  });

  test("writes an empty body through, matching the feed summary patch", async () => {
    const { adapter } = captureBroadcast();

    await adapter.update!(
      { deliveryId: "delivery-1", destination: "vellum", messageId: "msg-1" },
      { title: "Daily Briefing", body: "" },
    );

    expect(updateMessageContentMock.mock.calls[0]![1]).toBe("");
  });

  test("skips deliveries that persisted no conversation message", async () => {
    const { adapter } = captureBroadcast();

    const result = await adapter.update!(
      { deliveryId: "delivery-1", destination: "vellum", messageId: null },
      { body: "Revised briefing text." },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing_message_id");
    expect(updateMessageContentMock).not.toHaveBeenCalled();
  });

  test("reports failure without throwing when the write fails", async () => {
    const { adapter } = captureBroadcast();
    updateMessageContentShouldThrow = true;

    const result = await adapter.update!(
      { deliveryId: "delivery-1", destination: "vellum", messageId: "msg-1" },
      { body: "Revised briefing text." },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("DB write failed");
  });
});

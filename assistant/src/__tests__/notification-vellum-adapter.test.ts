import { describe, expect, test } from "bun:test";

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
  test("broadcasts remotePushDispatched: true verbatim", async () => {
    const { adapter, sent } = captureBroadcast();
    await adapter.send(
      makePayload({ remotePushDispatched: true }),
      makeDestination(),
    );

    const intent = sent[0] as Extract<
      AssistantEvent,
      { type: "notification_intent" }
    >;
    expect(intent.remotePushDispatched).toBe(true);
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

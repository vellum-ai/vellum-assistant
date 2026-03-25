import { beforeEach, describe, expect, mock, test } from "bun:test";

const deliveryCalls: Array<{
  url: string;
  payload: Record<string, unknown>;
  bearerToken?: string;
}> = [];

/** When true, deliverChannelReply throws if the payload contains an approval field. */
let rejectRichDelivery = false;

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://gateway.internal",
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: Record<string, unknown>,
    bearerToken?: string,
  ) => {
    if (rejectRichDelivery && payload.approval) {
      throw new Error("Telegram API error: buttons not supported");
    }
    deliveryCalls.push({ url, payload, bearerToken });
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { TelegramAdapter } from "../notifications/adapters/telegram.js";
import type {
  ChannelDeliveryPayload,
  ChannelDestination,
} from "../notifications/types.js";

function makePayload(
  overrides?: Partial<ChannelDeliveryPayload>,
): ChannelDeliveryPayload {
  return {
    sourceEventName: "schedule.notify",
    copy: {
      title: "Reminder",
      body: "Check the oven now!",
    },
    ...overrides,
  };
}

function makeDestination(
  overrides?: Partial<ChannelDestination>,
): ChannelDestination {
  return {
    channel: "telegram",
    endpoint: "chat-123",
    ...overrides,
  };
}

describe("TelegramAdapter", () => {
  beforeEach(() => {
    deliveryCalls.length = 0;
    rejectRichDelivery = false;
  });

  test("prefers deliveryText and does not append deterministic label", async () => {
    const adapter = new TelegramAdapter();
    const payload = makePayload({
      copy: {
        title: "Check the oven",
        body: "Reminder: Check the oven now!",
        deliveryText: "Check the oven now!",
        conversationTitle: "Oven Reminder",
      },
    });

    const result = await adapter.send(payload, makeDestination());

    expect(result.success).toBe(true);
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]?.url).toBe(
      "http://gateway.internal/deliver/telegram",
    );
    expect(deliveryCalls[0]?.payload.text).toBe("Check the oven now!");
    expect(deliveryCalls[0]?.payload.text as string).not.toContain("Thread:");
  });

  test("falls back to conversationSeedMessage when deliveryText is absent", async () => {
    const adapter = new TelegramAdapter();
    const payload = makePayload({
      copy: {
        title: "Reminder",
        body: "Check the oven now!",
        conversationSeedMessage: "Please check the oven now.",
      },
    });

    await adapter.send(payload, makeDestination());

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]?.payload.text).toBe("Please check the oven now.");
  });

  test("uses recipient-facing fallback text without channel or meta-send phrasing", async () => {
    const adapter = new TelegramAdapter();
    const payload = makePayload({
      copy: {
        title: "Reminder",
        body: "Check the oven now!",
      },
    });

    await adapter.send(payload, makeDestination());

    const text = deliveryCalls[0]?.payload.text as string;
    expect(text).toBe("Check the oven now!");
    expect(text).not.toMatch(/via telegram/i);
    expect(text).not.toMatch(/may i go ahead/i);
    expect(text).not.toMatch(/i'd like to send/i);
  });

  test("falls back to body/title/sourceEventName when richer text is unavailable", async () => {
    const adapter = new TelegramAdapter();

    await adapter.send(
      makePayload({
        copy: {
          title: "Reminder",
          body: "Check the oven now!",
          conversationSeedMessage: '{"raw":"json"}',
        },
      }),
      makeDestination(),
    );
    expect(deliveryCalls[0]?.payload.text).toBe("Check the oven now!");

    await adapter.send(
      makePayload({
        copy: {
          title: "Reminder",
          body: "   ",
        },
      }),
      makeDestination(),
    );
    expect(deliveryCalls[1]?.payload.text).toBe("Reminder");

    await adapter.send(
      makePayload({
        sourceEventName: "watcher.escalation",
        copy: {
          title: " ",
          body: "",
        },
      }),
      makeDestination(),
    );
    expect(deliveryCalls[2]?.payload.text).toBe("watcher escalation");
  });

  // ── Access request inline keyboard tests ──────────────────────────────

  test("includes approval payload with inline buttons for access requests", async () => {
    const adapter = new TelegramAdapter();
    const payload = makePayload({
      sourceEventName: "ingress.access_request",
      copy: {
        title: "Access Request",
        body: "Someone is requesting access.",
        deliveryText: "Someone is requesting access to the assistant.",
      },
      contextPayload: {
        requestId: "req-abc-123",
        requestCode: "XYZW",
        senderIdentifier: "Marina",
        sourceChannel: "telegram",
      },
    });

    const result = await adapter.send(payload, makeDestination());

    expect(result.success).toBe(true);
    expect(deliveryCalls).toHaveLength(1);

    const call = deliveryCalls[0]!;
    expect(call.payload.text).toBe(
      "Someone is requesting access to the assistant.",
    );

    const approval = call.payload.approval as {
      requestId: string;
      actions: Array<{ id: string; label: string }>;
      plainTextFallback: string;
    };
    expect(approval).toBeDefined();
    expect(approval.requestId).toBe("req-abc-123");
    expect(approval.actions).toHaveLength(2);
    expect(approval.actions[0]).toEqual({
      id: "approve_once",
      label: "Approve once",
    });
    expect(approval.actions[1]).toEqual({ id: "reject", label: "Reject" });
    expect(approval.plainTextFallback).toContain("XYZW");
  });

  test("sends plain text without approval when contextPayload is missing", async () => {
    const adapter = new TelegramAdapter();
    const payload = makePayload({
      sourceEventName: "ingress.access_request",
      copy: {
        title: "Access Request",
        body: "Someone is requesting access.",
      },
    });

    const result = await adapter.send(payload, makeDestination());

    expect(result.success).toBe(true);
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]?.payload.approval).toBeUndefined();
  });

  test("sends plain text without approval when requestId is missing from contextPayload", async () => {
    const adapter = new TelegramAdapter();
    const payload = makePayload({
      sourceEventName: "ingress.access_request",
      copy: {
        title: "Access Request",
        body: "Someone is requesting access.",
      },
      contextPayload: {
        senderIdentifier: "Marina",
        sourceChannel: "telegram",
        // no requestId
      },
    });

    const result = await adapter.send(payload, makeDestination());

    expect(result.success).toBe(true);
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]?.payload.approval).toBeUndefined();
  });

  test("falls back to plain text with instructions when rich delivery fails", async () => {
    rejectRichDelivery = true;

    const adapter = new TelegramAdapter();
    const payload = makePayload({
      sourceEventName: "ingress.access_request",
      copy: {
        title: "Access Request",
        body: "Someone is requesting access.",
        deliveryText: "Someone is requesting access to the assistant.",
      },
      contextPayload: {
        requestId: "req-abc-123",
        requestCode: "XYZW",
        senderIdentifier: "Marina",
        sourceChannel: "telegram",
      },
    });

    const result = await adapter.send(payload, makeDestination());

    expect(result.success).toBe(true);
    // Rich delivery threw, so only the plain-text fallback should be recorded.
    expect(deliveryCalls).toHaveLength(1);
    const call = deliveryCalls[0]!;
    // No approval payload in the fallback delivery.
    expect(call.payload.approval).toBeUndefined();
    // The fallback text should include the original message AND the
    // typed-command instructions from plainTextFallback.
    const text = call.payload.text as string;
    expect(text).toContain("Someone is requesting access to the assistant.");
    expect(text).toContain("XYZW");
  });
});

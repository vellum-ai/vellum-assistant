import { beforeEach, describe, expect, mock, test } from "bun:test";

const deliveryCalls: Array<{
  url: string;
  payload: Record<string, unknown>;
  bearerToken?: string;
}> = [];

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
});

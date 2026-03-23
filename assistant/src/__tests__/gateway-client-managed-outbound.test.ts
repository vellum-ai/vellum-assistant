import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  ChannelDeliveryError,
  deliverChannelReply,
} from "../runtime/gateway-client.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

describe("gateway-client managed outbound lane", () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url, init: init ?? {} });
        return new Response(JSON.stringify({ status: "accepted" }), {
          status: 202,
        });
      },
    ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("translates managed callback URL into managed outbound-send request", async () => {
    await deliverChannelReply(
      "https://platform.test/v1/internal/managed-gateway/outbound-send/?route_id=route-123&assistant_id=assistant-123&source_channel=phone&source_update_id=CA-inbound-123&callback_token=runtime-token",
      {
        chatId: "+15550001111",
        text: "hello from runtime",
      },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(
      "https://platform.test/v1/internal/managed-gateway/outbound-send/",
    );

    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Managed-Gateway-Callback-Token"]).toBe("runtime-token");
    expect(headers["X-Idempotency-Key"]).toStartWith("mgw-send-");
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(String(call.init.body)) as {
      route_id: string;
      assistant_id: string;
      normalized_send: {
        sourceChannel: string;
        message: {
          to: string;
          content: string;
          externalMessageId: string;
        };
        source: {
          requestId: string;
        };
        raw: {
          sourceUpdateId: string;
        };
      };
    };
    expect(body.route_id).toBe("route-123");
    expect(body.assistant_id).toBe("assistant-123");
    expect(body.normalized_send.sourceChannel).toBe("phone");
    expect(body.normalized_send.message.to).toBe("+15550001111");
    expect(body.normalized_send.message.content).toBe("hello from runtime");
    expect(body.normalized_send.message.externalMessageId).toStartWith(
      "mgw-send-",
    );
    expect(body.normalized_send.source.requestId).toBe(
      body.normalized_send.message.externalMessageId,
    );
    expect(body.normalized_send.raw.sourceUpdateId).toBe("CA-inbound-123");
  });

  test("retries managed outbound send on retriable upstream responses with stable idempotency key", async () => {
    calls.length = 0;
    let attempt = 0;
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url, init: init ?? {} });
        attempt += 1;
        if (attempt === 1) {
          return new Response("temporary upstream error", { status: 502 });
        }
        return new Response(JSON.stringify({ status: "accepted" }), {
          status: 202,
        });
      },
    ) as unknown as typeof globalThis.fetch;

    await deliverChannelReply(
      "https://platform.test/v1/internal/managed-gateway/outbound-send/?route_id=route-retry&assistant_id=assistant-retry&source_channel=phone&source_update_id=CA-retry",
      {
        chatId: "+15550002222",
        text: "retry this outbound send",
      },
    );

    expect(calls).toHaveLength(2);

    const firstHeaders = calls[0].init.headers as Record<string, string>;
    const secondHeaders = calls[1].init.headers as Record<string, string>;
    expect(firstHeaders["X-Idempotency-Key"]).toBeDefined();
    expect(secondHeaders["X-Idempotency-Key"]).toBe(
      firstHeaders["X-Idempotency-Key"],
    );

    const firstBody = JSON.parse(String(calls[0].init.body)) as {
      normalized_send: { source: { requestId: string } };
    };
    const secondBody = JSON.parse(String(calls[1].init.body)) as {
      normalized_send: { source: { requestId: string } };
    };
    expect(secondBody.normalized_send.source.requestId).toBe(
      firstBody.normalized_send.source.requestId,
    );
  });

  test("falls back to standard callback delivery for non-managed callback URL", async () => {
    await deliverChannelReply(
      "https://gateway.test/deliver/voice",
      {
        chatId: "+15550001111",
        text: "standard gateway callback",
      },
      "runtime-bearer",
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://gateway.test/deliver/voice");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer runtime-bearer");

    const body = JSON.parse(String(call.init.body)) as {
      chatId: string;
      text: string;
    };
    expect(body).toEqual({
      chatId: "+15550001111",
      text: "standard gateway callback",
    });
  });

  test("throws ChannelDeliveryError with userMessage when gateway returns JSON error with userMessage", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          error: "Permission denied",
          userMessage:
            "The bot is not a member of this channel. Please invite it first.",
        }),
        { status: 403 },
      );
    }) as unknown as typeof globalThis.fetch;

    let caught: unknown;
    try {
      await deliverChannelReply("https://gateway.test/deliver/slack", {
        chatId: "C123",
        text: "hello",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ChannelDeliveryError);
    const deliveryError = caught as ChannelDeliveryError;
    expect(deliveryError.statusCode).toBe(403);
    expect(deliveryError.userMessage).toBe(
      "The bot is not a member of this channel. Please invite it first.",
    );
    expect(deliveryError.message).toContain("403");
  });

  test("throws ChannelDeliveryError without userMessage when gateway returns JSON error without userMessage", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: "Delivery failed" }), {
        status: 502,
      });
    }) as unknown as typeof globalThis.fetch;

    let caught: unknown;
    try {
      await deliverChannelReply("https://gateway.test/deliver/slack", {
        chatId: "C123",
        text: "hello",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ChannelDeliveryError);
    const deliveryError = caught as ChannelDeliveryError;
    expect(deliveryError.statusCode).toBe(502);
    expect(deliveryError.userMessage).toBeUndefined();
  });

  test("throws ChannelDeliveryError without userMessage when gateway returns non-JSON error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    let caught: unknown;
    try {
      await deliverChannelReply("https://gateway.test/deliver/slack", {
        chatId: "C123",
        text: "hello",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ChannelDeliveryError);
    const deliveryError = caught as ChannelDeliveryError;
    expect(deliveryError.statusCode).toBe(500);
    expect(deliveryError.userMessage).toBeUndefined();
  });
});

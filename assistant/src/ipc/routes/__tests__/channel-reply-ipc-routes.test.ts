/**
 * The gateway's replies to messages it answered itself reach the person
 * through the channel transport, the same one a turn's reply uses.
 *
 * The Bot API call is the boundary: everything between the gateway's request
 * and Telegram's `sendMessage` is the real code, so the assertion is that the
 * text a person would read left for their chat, in the topic they wrote from.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { DELIVER_GATEWAY_REPLY_IPC_METHOD } from "@vellumai/gateway-client";

type CallTelegramBotApi =
  typeof import("../../../messaging/providers/telegram-bot/api.js").callTelegramBotApi;

const callTelegramBotApiMock = mock<CallTelegramBotApi>(
  async () => ({ message_id: 42 }) as never,
);

// Spread the actual module so exports this suite does not touch stay
// importable by files that share the bun process.
const actualTelegramApi =
  await import("../../../messaging/providers/telegram-bot/api.js");
mock.module("../../../messaging/providers/telegram-bot/api.js", () => ({
  ...actualTelegramApi,
  callTelegramBotApi: (method: string, body: Record<string, unknown>) =>
    callTelegramBotApiMock(method, body),
}));

const { CHANNEL_REPLY_IPC_METHODS } =
  await import("../channel-reply-ipc-routes.js");
const { BadGatewayError, BadRequestError } =
  await import("../../../runtime/routes/errors.js");

const deliverGatewayReply =
  CHANNEL_REPLY_IPC_METHODS[DELIVER_GATEWAY_REPLY_IPC_METHOD]!;

// The callback URL exactly as the gateway's Telegram webhook builds it for a
// message sent in a topic.
const TELEGRAM_CALLBACK = "http://127.0.0.1:7830/deliver/telegram?threadId=7";

beforeEach(() => {
  callTelegramBotApiMock.mockClear();
});

describe("deliver_gateway_reply", () => {
  test("sends the reply to the person's Telegram chat, in their topic", async () => {
    const result = await deliverGatewayReply({
      body: {
        callbackUrl: TELEGRAM_CALLBACK,
        chatId: "12345",
        text: "Welcome! You've been granted access.",
        assistantId: "self",
      },
    });

    const sends = callTelegramBotApiMock.mock.calls.filter(
      ([method]) => method === "sendMessage",
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]![1]).toMatchObject({
      chat_id: "12345",
      text: "Welcome! You've been granted access.",
      message_thread_id: 7,
    });
    expect(result).toEqual({ ok: true, messageIds: ["42"] });
  });

  test("answers a send the channel refuses with a status, not a bare error", async () => {
    // Only a RouteError crosses IPC with a status; without one the gateway
    // reads the refusal as a daemon that never answered.
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new Error("Bad Request: chat not found");
    });

    const rejection = expect(
      deliverGatewayReply({
        body: {
          callbackUrl: TELEGRAM_CALLBACK,
          chatId: "12345",
          text: "Welcome! You've been granted access.",
        },
      }),
    ).rejects;
    await rejection.toBeInstanceOf(BadGatewayError);
    await rejection.toMatchObject({ statusCode: 502 });
  });

  test("refuses a callback no channel transport owns, sending nothing", async () => {
    await expect(
      deliverGatewayReply({
        body: {
          callbackUrl: "http://127.0.0.1:7830/deliver/email",
          chatId: "someone@example.com",
          text: "Verification successful.",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(callTelegramBotApiMock).not.toHaveBeenCalled();
  });

  test("refuses a request with no text, sending nothing", async () => {
    await expect(
      deliverGatewayReply({
        body: { callbackUrl: TELEGRAM_CALLBACK, chatId: "12345", text: "" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(callTelegramBotApiMock).not.toHaveBeenCalled();
  });
});

import { describe, expect, test } from "bun:test";
// The addressing capability resolves a named chat into exactly what each
// transport's own operations read: the callback URL `channelForCallback`
// resolves and the params `deliver` consumes. Resolution is local, so these
// assertions make no platform call; the tests import the transports'
// modules, which pull in their provider-API senders, so the senders'
// credential lookups are stubbed to keep the import inert.
import { mock } from "bun:test";

const actualSecureKeys = await import("../../../security/secure-keys.js");
mock.module("../../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async () => null,
  getSecureKeyResultAsync: async () => ({ value: null }),
}));

const { channelForCallback } = await import("../callback-routing.js");
const { discordTransport } = await import("../discord/transport.js");
const { slackTransport } = await import("../slack/transport.js");
const { telegramTransport } = await import("../telegram-bot/transport.js");
const { whatsappTransport } = await import("../whatsapp/transport.js");

describe("addressFor resolves to the channel's own routing state", () => {
  test("slack: a chat, optionally under a thread", () => {
    const room = slackTransport.addressFor!({ kind: "chat", chatId: "C123" });
    expect(room).toEqual({
      ctx: { callbackUrl: "/deliver/slack", params: {} },
      chatId: "C123",
    });
    const thread = slackTransport.addressFor!({
      kind: "chat",
      chatId: "C123",
      threadId: "1690000000.000001",
    });
    expect(thread).toEqual({
      ctx: {
        callbackUrl: "/deliver/slack?threadTs=1690000000.000001",
        params: { threadTs: "1690000000.000001" },
      },
      chatId: "C123",
      threadId: "1690000000.000001",
    });
    expect(channelForCallback(thread!.ctx.callbackUrl)).toBe("slack");
  });

  test("telegram: a chat with a topic; binds on send", () => {
    expect(
      telegramTransport.addressFor!({
        kind: "chat",
        chatId: "123",
        threadId: "42",
      }),
    ).toEqual({
      ctx: {
        callbackUrl: "/deliver/telegram?threadId=42",
        params: { threadId: "42" },
      },
      chatId: "123",
      threadId: "42",
    });
    expect(telegramTransport.bindsChatOnProactiveSend).toBe(true);
  });

  test("discord: a chat with a thread, which is its own channel", () => {
    const thread = discordTransport.addressFor!({
      kind: "chat",
      chatId: "C1",
      threadId: "T1",
    });
    expect(thread).toEqual({
      ctx: {
        callbackUrl: "/deliver/discord?threadId=T1",
        params: { threadId: "T1" },
      },
      chatId: "C1",
      threadId: "T1",
    });
    expect(channelForCallback(thread!.ctx.callbackUrl)).toBe("discord");
    expect(discordTransport.bindsChatOnProactiveSend).toBeUndefined();
  });

  test("whatsapp: the number is the chat; no threads; binds on send", () => {
    expect(
      whatsappTransport.addressFor!({
        kind: "chat",
        chatId: "12125550100",
        threadId: "ignored",
      }),
    ).toEqual({
      ctx: { callbackUrl: "/deliver/whatsapp", params: {} },
      chatId: "12125550100",
    });
    expect(whatsappTransport.bindsChatOnProactiveSend).toBe(true);
  });
});

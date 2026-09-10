import { describe, expect, test } from "bun:test";
// The addressing capability resolves a neutral target into exactly what each
// transport's own operations read: the callback URL `channelForCallback`
// resolves and the params `deliver` consumes. These tests import the
// transports' modules, which pull in their provider-API senders, so the
// senders' credential lookups are stubbed to keep the import inert, and the
// DM-opening calls a person target makes are stubbed to answer a channel id.
import { mock } from "bun:test";

const actualSecureKeys = await import("../../../security/secure-keys.js");
mock.module("../../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async () => null,
  getSecureKeyResultAsync: async () => ({ value: null }),
}));

const actualDiscordApi = await import("../discord/api.js");
mock.module("../discord/api.js", () => ({
  ...actualDiscordApi,
  openDiscordDmChannel: async (userId: string) => `dm-of-${userId}`,
}));

const actualSlackApi = await import("../slack/api.js");
mock.module("../slack/api.js", () => ({
  ...actualSlackApi,
  openSlackDmChannel: async (userId: string) => `D-of-${userId}`,
}));

const { channelForCallback } = await import("../callback-routing.js");
const { discordTransport } = await import("../discord/transport.js");
const { slackTransport } = await import("../slack/transport.js");
const { telegramTransport } = await import("../telegram-bot/transport.js");
const { whatsappTransport } = await import("../whatsapp/transport.js");

describe("addressFor resolves to the channel's own routing state", () => {
  test("slack: a chat, optionally under a thread; a person is the DM the bot opens", async () => {
    const room = await slackTransport.addressFor!({
      kind: "chat",
      chatId: "C123",
    });
    expect(room).toEqual({
      ctx: { callbackUrl: "/deliver/slack", params: {} },
      chatId: "C123",
    });
    const thread = await slackTransport.addressFor!({
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
    expect(
      await slackTransport.addressFor!({ kind: "person", userId: "U1" }),
    ).toEqual({
      ctx: { callbackUrl: "/deliver/slack", params: {} },
      chatId: "D-of-U1",
    });
    expect(channelForCallback(thread!.ctx.callbackUrl)).toBe("slack");
  });

  test("telegram: a chat with a topic; a person is their DM chat; binds on send", async () => {
    expect(
      await telegramTransport.addressFor!({
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
    expect(
      await telegramTransport.addressFor!({ kind: "person", userId: "777" }),
    ).toEqual({
      ctx: { callbackUrl: "/deliver/telegram", params: {} },
      chatId: "777",
    });
    expect(telegramTransport.bindsChatOnProactiveSend).toBe(true);
  });

  test("discord: a chat with a thread; a person is the DM channel the transport opens", async () => {
    expect(
      await discordTransport.addressFor!({
        kind: "chat",
        chatId: "C1",
        threadId: "T1",
      }),
    ).toEqual({
      ctx: {
        callbackUrl: "/deliver/discord?threadId=T1",
        params: { threadId: "T1" },
      },
      chatId: "C1",
      threadId: "T1",
    });
    const person = await discordTransport.addressFor!({
      kind: "person",
      userId: "U1",
    });
    expect(person).toEqual({
      ctx: { callbackUrl: "/deliver/discord", params: {} },
      chatId: "dm-of-U1",
    });
    expect(channelForCallback(person!.ctx.callbackUrl)).toBe("discord");
    expect(discordTransport.bindsChatOnProactiveSend).toBeUndefined();
  });

  test("whatsapp: a chat and a person are the same number; no threads; binds on send", async () => {
    expect(
      await whatsappTransport.addressFor!({
        kind: "chat",
        chatId: "12125550100",
        threadId: "ignored",
      }),
    ).toEqual({
      ctx: { callbackUrl: "/deliver/whatsapp", params: {} },
      chatId: "12125550100",
    });
    expect(
      await whatsappTransport.addressFor!({
        kind: "person",
        userId: "12125550100",
      }),
    ).toEqual({
      ctx: { callbackUrl: "/deliver/whatsapp", params: {} },
      chatId: "12125550100",
    });
    expect(whatsappTransport.bindsChatOnProactiveSend).toBe(true);
  });
});

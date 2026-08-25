/**
 * The Discord callback seam, end to end through the join rather than either
 * half of it.
 *
 * Discord's send, render and DM delivery each have their own unit coverage,
 * and the gateway's inbound has schema, admission and normalizer coverage.
 * Nothing exercised the point where they meet: a reply addressed to a Discord
 * callback resolving to the Discord transport and being delivered with the
 * chat id it was given. That join is where a channel goes silently deaf while
 * every component around it still passes, which is the shape the Slack
 * plan-mode bug had.
 */

import { describe, expect, mock, test } from "bun:test";

const sent: Array<{ channelId: string; text: string }> = [];

// Spread the real module rather than listing the exports this test happens to
// need. `mock.module` replaces the module wholesale, so a partial stub breaks
// the transport's import of any export it omits, and would break again the
// next time `send.ts` grows one.
const actualSend = await import("../messaging/providers/discord/send.js");

mock.module("../messaging/providers/discord/send.js", () => ({
  ...actualSend,
  sendDiscordReply: async (target: { channelId: string }, text: string) => {
    sent.push({ channelId: target.channelId, text });
    return { messageId: "1401234567890123456" };
  },
}));

const { channelForCallback } =
  await import("../messaging/providers/callback-routing.js");
const { deliverDirect, getTransportForCallback, isDirectDelivery } =
  await import("../messaging/providers/index.js");

type ChannelReplyPayload = Parameters<typeof deliverDirect>[1];

const DISCORD_CALLBACK = "https://gateway.example/deliver/discord";

describe("a Discord reply reaches the Discord transport", () => {
  test("the callback resolves to discord, absolute and relative", () => {
    expect(channelForCallback(DISCORD_CALLBACK)).toBe("discord");
    // Off-channel guardian flows emit a base-less callback.
    expect(channelForCallback("/deliver/discord")).toBe("discord");
    expect(channelForCallback("/deliver/discord?x=1")).toBe("discord");
  });

  test("the resolved transport is the one that can send", () => {
    expect(isDirectDelivery(DISCORD_CALLBACK)).toBe(true);
    const transport = getTransportForCallback(DISCORD_CALLBACK);
    expect(transport).toBeDefined();
    expect(typeof transport?.deliver).toBe("function");
  });

  test("a reply is delivered to the chat id it was addressed to", async () => {
    sent.length = 0;
    const payload: ChannelReplyPayload = {
      chatId: "1409876543210987654",
      text: "hello from the assistant",
    };
    await deliverDirect(DISCORD_CALLBACK, payload);

    expect(sent).toHaveLength(1);
    // `POST /channels/{id}/messages` addresses a channel and nothing more, so
    // the chat id is the channel the reply lands in.
    expect(sent[0]?.channelId).toBe("1409876543210987654");
    expect(sent[0]?.text).toContain("hello from the assistant");
  });

  test("a threaded reply lands in the thread, which is its own channel", async () => {
    sent.length = 0;
    const payload: ChannelReplyPayload = {
      chatId: "1409876543210987654",
      text: "in the thread",
    };
    await deliverDirect(
      `${DISCORD_CALLBACK}?threadId=1405555555555555555`,
      payload,
    );

    expect(sent[0]?.channelId).toBe("1405555555555555555");
  });

  test("Discord declines streaming rather than faking it", () => {
    // No primitive exists, so the transport omits the method and the caller
    // sends the finished reply. An implementation here would be a repeated
    // edit, which is the approach the platforms discourage.
    expect(getTransportForCallback(DISCORD_CALLBACK)?.streamReply).toBe(
      undefined,
    );
  });
});

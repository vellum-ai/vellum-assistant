import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelReplyPayload } from "@vellumai/gateway-client";

// Replace each channel's provider-API send layer with spies so the dispatcher's
// routing and sub-operation selection can be asserted without network calls.
const slack = {
  sendSlackReply: mock((..._args: unknown[]) =>
    Promise.resolve({ ts: "slack-ts" }),
  ),
  sendSlackReaction: mock((..._args: unknown[]) => Promise.resolve()),
  sendSlackAssistantThreadStatus: mock((..._args: unknown[]) =>
    Promise.resolve(),
  ),
  sendSlackAttachments: mock((..._args: unknown[]) =>
    Promise.resolve({ allFailed: false, failureCount: 0 }),
  ),
  sendSlackStreamOp: mock((..._args: unknown[]) =>
    Promise.resolve({ ok: true, ts: "stream-ts" }),
  ),
};
const telegram = {
  sendTelegramReply: mock((..._args: unknown[]) => Promise.resolve()),
  sendTelegramRichReply: mock((..._args: unknown[]) => Promise.resolve()),
  sendTelegramTypingIndicator: mock((..._args: unknown[]) => Promise.resolve()),
  sendTelegramAttachments: mock((..._args: unknown[]) =>
    Promise.resolve({ allFailed: false, failureCount: 0 }),
  ),
};
const whatsapp = {
  sendWhatsAppReply: mock((..._args: unknown[]) => Promise.resolve()),
  sendWhatsAppAttachments: mock((..._args: unknown[]) =>
    Promise.resolve({ allFailed: false, failureCount: 0 }),
  ),
};
const a2a = {
  deliverA2AReply: mock((..._args: unknown[]) => Promise.resolve({ ok: true })),
};
const discord = {
  sendDiscordReply: mock((..._args: unknown[]) =>
    Promise.resolve({ lastMessageId: "discord-id" }),
  ),
  sendDiscordTypingIndicator: mock((..._args: unknown[]) =>
    Promise.resolve(true),
  ),
  sendDiscordAttachments: mock((..._args: unknown[]) =>
    Promise.resolve({ allFailed: false, failureCount: 0, totalCount: 0 }),
  ),
};

mock.module("../slack/send.js", () => slack);
mock.module("../telegram-bot/send.js", () => telegram);
mock.module("../whatsapp/send.js", () => whatsapp);
mock.module("../a2a/deliver.js", () => a2a);
mock.module("../discord/send.js", () => discord);
mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const {
  deliverDirect,
  sendChannelReaction,
  sendChannelTyping,
  setChannelThreadStatus,
  supportsChannelTyping,
  isDirectDelivery,
  getTransportForCallback,
} = await import("../index.js");

const BASE = "https://gateway.internal";

function payload(
  overrides: Partial<ChannelReplyPayload> = {},
): ChannelReplyPayload {
  return { chatId: "C1", ...overrides };
}

beforeEach(() => {
  for (const group of [slack, telegram, whatsapp, a2a, discord]) {
    for (const spy of Object.values(group)) {
      spy.mockClear();
    }
  }
});

describe("routing", () => {
  test("resolves each channel's callback path to its transport", () => {
    expect(
      getTransportForCallback(`${BASE}/deliver/slack?threadTs=1`)?.channel,
    ).toBe("slack");
    expect(getTransportForCallback(`${BASE}/deliver/telegram`)?.channel).toBe(
      "telegram",
    );
    expect(getTransportForCallback(`${BASE}/deliver/whatsapp`)?.channel).toBe(
      "whatsapp",
    );
    expect(
      getTransportForCallback(`${BASE}/deliver/a2a?taskId=t1`)?.channel,
    ).toBe("a2a");
    expect(getTransportForCallback(`${BASE}/deliver/discord`)?.channel).toBe(
      "discord",
    );
  });

  test("isDirectDelivery is true for owned paths, false otherwise", () => {
    expect(isDirectDelivery(`${BASE}/deliver/slack`)).toBe(true);
    expect(isDirectDelivery(`${BASE}/deliver/a2a?taskId=t1`)).toBe(true);
    expect(isDirectDelivery(`${BASE}/deliver/discord`)).toBe(true);
    expect(isDirectDelivery(`${BASE}/v1/messages`)).toBe(false);
    expect(
      isDirectDelivery(
        `${BASE}/v1/internal/managed-gateway/outbound-send/?route_id=r1`,
      ),
    ).toBe(false);
    // `phone` is a canonical channel with no direct-delivery transport, so it
    // stands in for the never-registered case discord used to cover.
    expect(isDirectDelivery(`${BASE}/deliver/phone`)).toBe(false);
    expect(getTransportForCallback(`${BASE}/deliver/phone`)).toBeUndefined();
  });
});

describe("Slack sub-operation selection", () => {
  test("text routes to sendSlackReply, threading the callback URL's threadTs", async () => {
    await deliverDirect(
      `${BASE}/deliver/slack?threadTs=1700.5`,
      payload({ text: "hi" }),
    );
    expect(slack.sendSlackReply).toHaveBeenCalledTimes(1);
    const opts = slack.sendSlackReply.mock.calls[0][2] as { threadTs?: string };
    expect(opts.threadTs).toBe("1700.5");
    expect(slack.sendSlackReaction).not.toHaveBeenCalled();
  });

  test("threads a base-less callback URL's threadTs", async () => {
    await deliverDirect(
      `/deliver/slack?threadTs=1700.9`,
      payload({ text: "hi" }),
    );
    expect(slack.sendSlackReply).toHaveBeenCalledTimes(1);
    const opts = slack.sendSlackReply.mock.calls[0][2] as { threadTs?: string };
    expect(opts.threadTs).toBe("1700.9");
  });

  test("sendChannelReaction reaches Slack without touching the text path", async () => {
    await sendChannelReaction(`${BASE}/deliver/slack`, {
      chatId: "C1",
      messageId: "1700.5",
      emoji: "white_check_mark",
      action: "add",
    });

    expect(slack.sendSlackReaction).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
  });

  test("setChannelThreadStatus reaches Slack without touching the text path", async () => {
    await setChannelThreadStatus(`${BASE}/deliver/slack`, {
      chatId: "C1",
      threadTs: "1700.5",
      status: "is thinking",
    });

    expect(slack.sendSlackAssistantThreadStatus).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
  });

  test("a channel with no status surface resolves quietly", async () => {
    const result = await setChannelThreadStatus(`${BASE}/deliver/telegram`, {
      chatId: "123",
      threadTs: "1700.5",
      status: "is thinking",
    });

    expect(result).toEqual({ ok: true });
    expect(telegram.sendTelegramReply).not.toHaveBeenCalled();
  });

  test("sendChannelTyping resolves quietly for a channel with no typing capability", async () => {
    const result = await sendChannelTyping(`${BASE}/deliver/slack`, "C1");

    expect(result).toEqual({ ok: true });
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
  });

  test("slackStream routes to sendSlackStreamOp ahead of the text path", async () => {
    const result = await deliverDirect(
      `${BASE}/deliver/slack?threadTs=1700.5`,
      payload({
        text: "ignored while streaming",
        slackStream: { action: "start", threadTs: "1700.5" },
      }),
    );
    expect(slack.sendSlackStreamOp).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackStreamOp.mock.calls[0]).toEqual([
      "C1",
      { action: "start", threadTs: "1700.5" },
    ]);
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, ts: "stream-ts" });
  });
});

describe("capability gating across channels", () => {
  test("a channel with no reaction capability resolves quietly", async () => {
    // Slack is the only channel that implements it, because the only producer
    // is Slack's own acknowledgement fallback. A channel without the method
    // is not a failed delivery, so nothing is attempted and nothing throws.
    const target = {
      chatId: "C1",
      messageId: "1",
      emoji: "eyes",
      action: "add",
    } as const;
    expect(
      await sendChannelReaction(`${BASE}/deliver/telegram`, target),
    ).toEqual({ ok: true });
    expect(telegram.sendTelegramReply).not.toHaveBeenCalled();
  });

  test("the typing capability is read from the transport, not the channel name", () => {
    // The heartbeat gate in background-dispatch asks this rather than testing
    // `sourceChannel === "telegram"`, so a channel that implements the method
    // starts showing an indicator without a caller being changed.
    expect(supportsChannelTyping(`${BASE}/deliver/telegram`)).toBe(true);
    expect(supportsChannelTyping(`${BASE}/deliver/discord`)).toBe(true);
    expect(supportsChannelTyping(`${BASE}/deliver/slack`)).toBe(false);
    expect(supportsChannelTyping(`${BASE}/deliver/whatsapp`)).toBe(false);
  });

  test("sendChannelTyping reaches Telegram's typing indicator", async () => {
    await sendChannelTyping(`${BASE}/deliver/telegram`, "123");

    expect(telegram.sendTelegramTypingIndicator).toHaveBeenCalledTimes(1);
  });

  test("WhatsApp text routes to sendWhatsAppReply", async () => {
    await deliverDirect(`${BASE}/deliver/whatsapp`, payload({ text: "hi" }));
    expect(whatsapp.sendWhatsAppReply).toHaveBeenCalledTimes(1);
  });

  test("A2A routes to deliverA2AReply with the callback URL", async () => {
    const url = `${BASE}/deliver/a2a?taskId=t1`;
    await deliverDirect(url, payload({ text: "hi" }));
    expect(a2a.deliverA2AReply).toHaveBeenCalledTimes(1);
    expect(a2a.deliverA2AReply.mock.calls[0][0]).toBe(url);
  });

  test("Discord text routes to sendDiscordReply, targeting the channel", async () => {
    await deliverDirect(`${BASE}/deliver/discord`, payload({ text: "hi" }));
    expect(discord.sendDiscordReply).toHaveBeenCalledTimes(1);
    expect(discord.sendDiscordReply.mock.calls[0][0]).toEqual({
      channelId: "C1",
    });
    expect(discord.sendDiscordReply.mock.calls[0][1]).toBe("hi");
  });

  test("Discord threads a reply to the thread id, not the parent channel", async () => {
    await deliverDirect(
      `${BASE}/deliver/discord?threadId=T9`,
      payload({ text: "hi" }),
    );
    expect(discord.sendDiscordReply).toHaveBeenCalledTimes(1);
    // A Discord thread is itself a channel: the reply must post to the thread
    // snowflake, never to the parent channel the payload's chatId carries.
    expect(discord.sendDiscordReply.mock.calls[0][0]).toEqual({
      channelId: "T9",
    });
  });

  test("sendChannelTyping reaches Discord's typing indicator", async () => {
    await sendChannelTyping(`${BASE}/deliver/discord`, "999");

    expect(discord.sendDiscordTypingIndicator).toHaveBeenCalledTimes(1);
  });

  test("a Slack-only stream payload to Discord falls through to deliver", async () => {
    await deliverDirect(
      `${BASE}/deliver/discord`,
      payload({
        text: "hi",
        slackStream: { action: "start", threadTs: "1700.5" },
      }),
    );
    expect(discord.sendDiscordReply).toHaveBeenCalledTimes(1);
  });
});

describe("unsupported callback", () => {
  test("throws when no transport owns the callback", async () => {
    await expect(
      deliverDirect(`${BASE}/deliver/phone`, payload({ text: "hi" })),
    ).rejects.toThrow(/unsupported callback/);
  });
});

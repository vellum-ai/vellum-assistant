import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelReplyPayload } from "@vellumai/gateway-client";

// Replace each channel's provider-API send layer with spies so the dispatcher's
// routing and sub-operation selection can be asserted without network calls.
const slack = {
  sendSlackReply: mock((..._args: unknown[]) =>
    Promise.resolve({ ts: "slack-ts" }),
  ),
  sendSlackReaction: mock((..._args: unknown[]) => Promise.resolve()),
  sendSlackAgentSessionStatus: mock((..._args: unknown[]) => Promise.resolve()),
  sendSlackAttachments: mock((..._args: unknown[]) =>
    Promise.resolve({ allFailed: false, failureCount: 0 }),
  ),
  sendSlackStreamOp: mock((..._args: unknown[]) =>
    Promise.resolve({ ok: true, ts: "stream-ts" }),
  ),
  updateSlackMessage: mock((..._args: unknown[]) =>
    Promise.resolve({ ts: "slack-ts" }),
  ),
};
const telegram = {
  editTelegramMessage: mock((..._args: unknown[]) => Promise.resolve()),
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
  editDiscordMessage: mock((..._args: unknown[]) => Promise.resolve()),
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
  editChannelMessage,
  sendChannelStreamOp,
  setChannelActivity,
  supportsChannelActivity,
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

  test("editChannelMessage updates in place instead of posting", async () => {
    await editChannelMessage(`${BASE}/deliver/slack`, {
      chatId: "C1",
      messageId: "1700.5",
      text: "revised",
    });

    expect(slack.updateSlackMessage).toHaveBeenCalledTimes(1);
    // The distinction the split exists for: an edit never reaches the post
    // path, so a failed edit cannot become a second visible message.
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
  });

  test("setChannelActivity reaches Slack without touching the text path", async () => {
    await setChannelActivity(`${BASE}/deliver/slack`, {
      chatId: "C1",
      phase: "thinking",
    });

    expect(slack.sendSlackAgentSessionStatus).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
  });

  test("a channel with no activity indicator resolves quietly", async () => {
    const result = await setChannelActivity(`${BASE}/deliver/whatsapp`, {
      chatId: "123",
      phase: "thinking",
    });

    expect(result).toEqual({ ok: true });
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
  });

  test("sendChannelStreamOp reaches Slack without touching the text path", async () => {
    const result = await sendChannelStreamOp(
      `${BASE}/deliver/slack?threadTs=1700.5`,
      "C1",
      {
        action: "start",
        anchorMessageId: "1700.5",
        text: "hi",
        appended: "hi",
      },
    );
    expect(slack.sendSlackStreamOp).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackStreamOp.mock.calls[0]).toEqual([
      "C1",
      {
        action: "start",
        anchorMessageId: "1700.5",
        text: "hi",
        appended: "hi",
      },
    ]);
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, ts: "stream-ts" });
  });
});

describe("capability gating across channels", () => {
  test("Slack renders a muted edit as its own context block", async () => {
    await editChannelMessage(`${BASE}/deliver/slack`, {
      chatId: "C1",
      messageId: "1700.5",
      text: "This approval request has been resolved.",
      emphasis: "muted",
    });

    // The producer asked for a settled message and named no markup. Slack
    // decides that means a context block.
    const [, , , options] = slack.updateSlackMessage.mock.calls[0]!;
    expect((options as { blocks?: unknown[] }).blocks).toEqual([
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This approval request has been resolved.",
          },
        ],
      },
    ]);
  });

  test("an edit with no emphasis carries no channel markup", async () => {
    await editChannelMessage(`${BASE}/deliver/slack`, {
      chatId: "C1",
      messageId: "1700.5",
      text: "revised",
    });

    const [, , , options] = slack.updateSlackMessage.mock.calls[0]!;
    expect((options as { blocks?: unknown[] }).blocks).toBeUndefined();
  });

  test("editChannelMessage now reaches Telegram, not only Slack", async () => {
    // The capability gate is what let Telegram gain this: no caller changed,
    // the transport grew the method.
    await editChannelMessage(`${BASE}/deliver/telegram`, {
      chatId: "123",
      messageId: "456",
      text: "revised",
    });

    expect(telegram.editTelegramMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendTelegramReply).not.toHaveBeenCalled();
  });

  test("a channel that cannot revise a sent message resolves quietly", async () => {
    // WhatsApp has no `edit`. A channel without the method is not a failed
    // delivery: nothing is attempted, nothing throws, and no fresh message is
    // posted in place of the revision.
    expect(
      await editChannelMessage(`${BASE}/deliver/whatsapp`, {
        chatId: "C1",
        messageId: "1",
        text: "revised",
      }),
    ).toEqual({ ok: true });
    expect(whatsapp.sendWhatsAppReply).not.toHaveBeenCalled();
  });

  test("Discord edits in place instead of posting", async () => {
    await editChannelMessage(`${BASE}/deliver/discord`, {
      chatId: "C1",
      messageId: "M9",
      text: "revised",
    });

    expect(discord.editDiscordMessage).toHaveBeenCalledTimes(1);
    // Same distinction the Slack case asserts: an edit never reaches the post
    // path, so a failed edit cannot become a second visible message.
    expect(discord.sendDiscordReply).not.toHaveBeenCalled();
  });

  test("Discord renders a muted edit as subtext", async () => {
    await editChannelMessage(`${BASE}/deliver/discord`, {
      chatId: "C1",
      messageId: "M9",
      text: "This approval request has been resolved.",
      emphasis: "muted",
    });

    // `muted` is surface-agnostic and each channel picks its own token. Slack
    // uses a context block; Discord's nearest equivalent is subtext, which it
    // renders at the size and colour of a dismiss line.
    expect(discord.editDiscordMessage.mock.calls[0][3]).toEqual({
      emphasis: "muted",
    });
  });

  test("the activity capability is read from the transport, not the channel name", () => {
    // The gate in background-dispatch asks this rather than testing
    // `sourceChannel === "slack"`, so a channel that implements the method
    // starts showing an indicator without a caller being changed. All three
    // answer the same question now, which is the point of the single method:
    // Slack holds its indicator and the other two re-assert theirs, and a
    // caller cannot tell the difference.
    expect(supportsChannelActivity(`${BASE}/deliver/slack`)).toBe(true);
    expect(supportsChannelActivity(`${BASE}/deliver/telegram`)).toBe(true);
    expect(supportsChannelActivity(`${BASE}/deliver/discord`)).toBe(true);
    expect(supportsChannelActivity(`${BASE}/deliver/whatsapp`)).toBe(false);
  });

  test("setChannelActivity reaches Telegram's typing indicator", async () => {
    await setChannelActivity(`${BASE}/deliver/telegram`, {
      chatId: "123",
      phase: "thinking",
    });

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

  test("setChannelActivity reaches Discord's typing indicator", async () => {
    await setChannelActivity(`${BASE}/deliver/discord`, {
      chatId: "999",
      phase: "thinking",
    });

    expect(discord.sendDiscordTypingIndicator).toHaveBeenCalledTimes(1);
  });

  test("a channel that cannot stream resolves quietly, and posts nothing", async () => {
    const result = await sendChannelStreamOp(`${BASE}/deliver/discord`, "999", {
      action: "start",
      anchorMessageId: "1700.5",
      text: "hi",
      appended: "hi",
    });

    expect(result).toEqual({ ok: true });
    expect(discord.sendDiscordReply).not.toHaveBeenCalled();
  });
});

describe("unsupported callback", () => {
  test("throws when no transport owns the callback", async () => {
    await expect(
      deliverDirect(`${BASE}/deliver/phone`, payload({ text: "hi" })),
    ).rejects.toThrow(/unsupported callback/);
  });
});

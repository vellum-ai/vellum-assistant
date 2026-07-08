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

mock.module("../slack/send.js", () => slack);
mock.module("../telegram-bot/send.js", () => telegram);
mock.module("../whatsapp/send.js", () => whatsapp);
mock.module("../a2a/deliver.js", () => a2a);
mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { deliverDirect, isDirectDelivery, getTransportForCallback } =
  await import("../index.js");

const BASE = "https://gateway.internal";

function payload(
  overrides: Partial<ChannelReplyPayload> = {},
): ChannelReplyPayload {
  return { chatId: "C1", ...overrides };
}

beforeEach(() => {
  for (const group of [slack, telegram, whatsapp, a2a]) {
    for (const spy of Object.values(group)) spy.mockClear();
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
  });

  test("isDirectDelivery is true for owned paths, false otherwise", () => {
    expect(isDirectDelivery(`${BASE}/deliver/slack`)).toBe(true);
    expect(isDirectDelivery(`${BASE}/deliver/a2a?taskId=t1`)).toBe(true);
    expect(isDirectDelivery(`${BASE}/deliver/discord`)).toBe(false);
    expect(isDirectDelivery(`${BASE}/v1/messages`)).toBe(false);
    expect(
      isDirectDelivery(
        `${BASE}/v1/internal/managed-gateway/outbound-send/?route_id=r1`,
      ),
    ).toBe(false);
    expect(getTransportForCallback(`${BASE}/deliver/discord`)).toBeUndefined();
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

  test("reaction routes to sendSlackReaction, not the text path", async () => {
    await deliverDirect(
      `${BASE}/deliver/slack`,
      payload({
        reaction: {
          action: "add",
          name: "white_check_mark",
          messageTs: "1700.5",
        },
      }),
    );
    expect(slack.sendSlackReaction).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
  });

  test("assistantThreadStatus routes to sendSlackAssistantThreadStatus", async () => {
    await deliverDirect(
      `${BASE}/deliver/slack`,
      payload({
        assistantThreadStatus: {
          channel: "C1",
          threadTs: "1700.5",
          status: "is thinking",
        },
      }),
    );
    expect(slack.sendSlackAssistantThreadStatus).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackReply).not.toHaveBeenCalled();
  });

  test("a typing payload to Slack falls through to deliver (no typing capability)", async () => {
    await deliverDirect(
      `${BASE}/deliver/slack`,
      payload({ chatAction: "typing", text: "hi" }),
    );
    expect(slack.sendSlackReply).toHaveBeenCalledTimes(1);
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
  test("a reaction payload to Telegram falls through to deliver (no sendReaction)", async () => {
    await deliverDirect(
      `${BASE}/deliver/telegram`,
      payload({
        text: "hi",
        reaction: { action: "add", name: "x", messageTs: "1" },
      }),
    );
    expect(telegram.sendTelegramReply).toHaveBeenCalledTimes(1);
  });

  test("typing to Telegram routes to its typing indicator", async () => {
    await deliverDirect(
      `${BASE}/deliver/telegram`,
      payload({ chatAction: "typing" }),
    );
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
});

describe("unsupported callback", () => {
  test("throws when no transport owns the callback", async () => {
    await expect(
      deliverDirect(`${BASE}/deliver/discord`, payload({ text: "hi" })),
    ).rejects.toThrow(/unsupported callback/);
  });
});

/**
 * DiscordAdapter delivery behavior.
 *
 * The invariant under test: the adapter addresses the *person*. Every send
 * and update resolves the DM channel from the guardian's user snowflake at
 * call time, so a room id stored anywhere can never become a delivery
 * target, and approval notifications carry the typed-command instructions
 * because nothing ingests component presses yet.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const dmOpens: string[] = [];
const sendCalls: Array<{
  channelId: string;
  text: string;
  approval?: { requestId: string } | undefined;
}> = [];
const editCalls: Array<{ channelId: string; messageId: string; text: string }> =
  [];

// Spread the actual module: the real send.js is imported below for its
// error class and transitively needs api.js's other named exports.
const actualApi = await import("../messaging/providers/discord/api.js");
mock.module("../messaging/providers/discord/api.js", () => ({
  ...actualApi,
  openDiscordDmChannel: async (userId: string) => {
    dmOpens.push(userId);
    return `dm-for-${userId}`;
  },
}));

const actualSend = await import("../messaging/providers/discord/send.js");
mock.module("../messaging/providers/discord/send.js", () => ({
  DiscordPartialSendError: actualSend.DiscordPartialSendError,
  sendDiscordReply: async (
    target: { channelId: string },
    text: string,
    approval?: { requestId: string },
  ) => {
    if (approval && failRichSends) {
      throw failRichSends === "partial"
        ? new actualSend.DiscordPartialSendError(
            new Error("final chunk rejected"),
            2,
            "tail of the card",
            "1500",
          )
        : new Error("simulated component rejection");
    }
    sendCalls.push({ channelId: target.channelId, text, approval });
    return { lastMessageId: String(2000 + sendCalls.length) };
  },
  editDiscordMessage: async (
    target: { channelId: string },
    messageId: string,
    text: string,
  ) => {
    editCalls.push({ channelId: target.channelId, messageId, text });
  },
}));

import type {
  ChannelDeliveryPayload,
  ChannelDestination,
} from "../notifications/types.js";

const { DiscordAdapter } = await import("../notifications/adapters/discord.js");

const GUARDIAN_USER_ID = "111222333444555666";

function makePayload(
  overrides?: Partial<ChannelDeliveryPayload>,
): ChannelDeliveryPayload {
  return {
    sourceEventName: "schedule.notify",
    copy: {
      title: "Heads up",
      body: "Your task finished.",
    },
    urgency: "medium",
    ...overrides,
  };
}

function makeDestination(
  overrides?: Partial<ChannelDestination>,
): ChannelDestination {
  return {
    channel: "discord",
    endpoint: GUARDIAN_USER_ID,
    ...overrides,
  };
}

let failRichSends: boolean | "partial" = false;

beforeEach(() => {
  dmOpens.length = 0;
  sendCalls.length = 0;
  editCalls.length = 0;
  failRichSends = false;
});

describe("DiscordAdapter.send", () => {
  test("resolves the DM channel from the guardian's user snowflake", async () => {
    const adapter = new DiscordAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("2001");
    expect(dmOpens).toEqual([GUARDIAN_USER_ID]);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].channelId).toBe(`dm-for-${GUARDIAN_USER_ID}`);
    expect(sendCalls[0].text).toContain("Your task finished.");
  });

  test("approval notifications deliver with component buttons", async () => {
    const adapter = new DiscordAdapter();
    const result = await adapter.send(
      makePayload({
        approvalContext: {
          requestId: "req-1",
          actions: [{ id: "approve_once", label: "Approve once" }],
          plainTextFallback: 'Reply "approve" or "reject" to decide.',
        },
      }),
      makeDestination(),
    );

    expect(result.success).toBe(true);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].approval?.requestId).toBe("req-1");
    // The rich card carries no typed-command tail; buttons are the controls.
    expect(sendCalls[0].text).not.toContain("Reply");
  });

  test("a mid-card failure completes the card instead of replaying it", async () => {
    failRichSends = "partial";
    const adapter = new DiscordAdapter();
    const result = await adapter.send(
      makePayload({
        approvalContext: {
          requestId: "req-1",
          actions: [{ id: "approve_once", label: "Approve once" }],
          plainTextFallback: 'Reply "approve" or "reject" to decide.',
        },
      }),
      makeDestination(),
    );

    expect(result.success).toBe(true);
    expect(sendCalls).toHaveLength(1);
    // Only the undelivered remainder goes out, with the typed instructions;
    // the delivered chunks are never sent twice.
    expect(sendCalls[0].approval).toBeUndefined();
    expect(sendCalls[0].text).toContain("tail of the card");
    expect(sendCalls[0].text).toContain('Reply "approve" or "reject"');
  });

  test("a failed rich delivery falls back to the typed-command card", async () => {
    failRichSends = true;
    const adapter = new DiscordAdapter();
    const result = await adapter.send(
      makePayload({
        approvalContext: {
          requestId: "req-1",
          actions: [{ id: "approve_once", label: "Approve once" }],
          plainTextFallback: 'Reply "approve" or "reject" to decide.',
        },
      }),
      makeDestination(),
    );

    expect(result.success).toBe(true);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].approval).toBeUndefined();
    expect(sendCalls[0].text).toContain(
      'Reply "approve" or "reject" to decide.',
    );
  });

  test("a destination without a guardian user id fails without calling the API", async () => {
    const adapter = new DiscordAdapter();
    const result = await adapter.send(
      makePayload(),
      makeDestination({ endpoint: undefined }),
    );

    expect(result.success).toBe(false);
    expect(dmOpens).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
  });
});

describe("DiscordAdapter.update", () => {
  test("edits the card through the same person-resolved DM channel", async () => {
    const adapter = new DiscordAdapter();
    const result = await adapter.update(
      {
        deliveryId: "delivery-1",
        destination: GUARDIAN_USER_ID,
        messageId: "2001",
      },
      { body: "This approval request has been resolved." },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("2001");
    expect(dmOpens).toEqual([GUARDIAN_USER_ID]);
    expect(editCalls).toEqual([
      {
        channelId: `dm-for-${GUARDIAN_USER_ID}`,
        messageId: "2001",
        text: "This approval request has been resolved.",
      },
    ]);
  });

  test("a delivery row without a captured message id cannot be updated", async () => {
    const adapter = new DiscordAdapter();
    const result = await adapter.update(
      {
        deliveryId: "delivery-2",
        destination: GUARDIAN_USER_ID,
        messageId: null,
      },
      { body: "resolved" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing_message_id");
    expect(editCalls).toHaveLength(0);
  });
});

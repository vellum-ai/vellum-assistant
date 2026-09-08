/**
 * Tests for the Slack notification adapter's send path: which deliveries
 * render a card and which go out as text carrying the typed-reply
 * instruction.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ChannelDeliveryPayload,
  ChannelDestination,
} from "../notifications/types.js";

const sendCalls: Array<{
  chatId: string;
  text: string;
  options: Record<string, unknown> | undefined;
}> = [];

const actualSend = await import("../messaging/providers/slack/send.js");
mock.module("../messaging/providers/slack/send.js", () => ({
  ...actualSend,
  sendSlackReply: async (
    chatId: string,
    text: string,
    options?: Record<string, unknown>,
  ) => {
    sendCalls.push({ chatId, text, options });
    return { ts: String(1700000000 + sendCalls.length), channel: chatId };
  },
}));

const { SlackAdapter } = await import("../notifications/adapters/slack.js");

function makePayload(
  overrides?: Partial<ChannelDeliveryPayload>,
): ChannelDeliveryPayload {
  return {
    sourceEventName: "guardian.question",
    copy: {
      title: "Question",
      body: "What time works?",
      deliveryText: "What time works?",
    },
    urgency: "high",
    ...overrides,
  };
}

function makeDestination(): ChannelDestination {
  return { channel: "slack", endpoint: "D0GUARDIAN" };
}

describe("SlackAdapter.send", () => {
  beforeEach(() => {
    sendCalls.length = 0;
  });

  test("a question with no options is sent as text with its typed-reply instruction", async () => {
    const adapter = new SlackAdapter();
    const result = await adapter.send(
      makePayload({
        contextPayload: {
          requestId: "req-voice-1",
          requestCode: "DEF456",
          requestKind: "pending_question",
          questionText: "What time works?",
        },
        approvalContext: {
          requestId: "req-voice-1",
          actions: [],
          plainTextFallback:
            'Reference code: DEF456. Reply "DEF456 <your answer>".',
          intent: "question",
        },
      }),
      makeDestination(),
    );

    expect(result.success).toBe(true);
    expect(sendCalls).toHaveLength(1);
    // No buttons to draw, so no card: text, with the instruction appended.
    expect(sendCalls[0]?.options?.blocks).toBeUndefined();
    expect(sendCalls[0]?.text).toBe(
      'What time works?\n\nReference code: DEF456. Reply "DEF456 <your answer>".',
    );
  });

  test("a question with options renders a card whose text carries no instruction", async () => {
    const adapter = new SlackAdapter();
    await adapter.send(
      makePayload({
        copy: {
          title: "Question",
          body: "Which one?\n\n1. Left\n2. Right",
          deliveryText: "Which one?\n\n1. Left\n2. Right",
        },
        contextPayload: {
          requestId: "req-q-1",
          requestCode: "ABC123",
          requestKind: "pending_question",
          questionText: "Which one?",
          options: [
            { id: "left", label: "Left" },
            { id: "right", label: "Right" },
          ],
        },
        approvalContext: {
          requestId: "req-q-1",
          actions: [
            { id: "answer_0", label: "Left" },
            { id: "answer_1", label: "Right" },
            { id: "answer_skip", label: "Skip" },
          ],
          plainTextFallback:
            'Reference code: ABC123. Reply "ABC123 <your answer>".',
          intent: "question",
        },
      }),
      makeDestination(),
    );

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.options?.blocks).toBeDefined();
    expect(sendCalls[0]?.text).not.toContain("ABC123");
    // The send layer keeps the approval so a rejected card can retry as
    // text with the instruction re-attached.
    expect(
      (sendCalls[0]?.options?.approval as { requestId?: string } | undefined)
        ?.requestId,
    ).toBe("req-q-1");
  });
});

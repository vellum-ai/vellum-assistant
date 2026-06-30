import { beforeEach, describe, expect, mock, test } from "bun:test";

const deliveredChannelReplies: Array<{
  callbackUrl: string;
  payload: Record<string, unknown>;
}> = [];
const markedProcessedEvents: string[] = [];
const processingFailureEvents: string[] = [];
const deliveredEvents: string[] = [];
const deliveryFailureEvents: string[] = [];
const deliveredSegmentCounts: Array<{ eventId: string; count: number }> = [];
const operationOrder: string[] = [];
const storedReplyMessageIds: Array<{
  eventId: string;
  replyMessageId: string;
}> = [];
const storedStreamedReplyTs: Array<{
  eventId: string;
  messageTs: string;
}> = [];
const replyDeliveryCalls: Array<{
  messageId?: string;
  startFromSegment?: number;
  messageTs?: string;
}> = [];
let deliverChannelReplyImpl: (
  callbackUrl: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async () => ({ ok: true });
let deliverReplyViaCallbackImpl: (
  ...args: unknown[]
) => Promise<void> = async () => {};

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../persistence/delivery-channels.js", () => ({
  updateDeliveredSegmentCount: (eventId: string, count: number) => {
    deliveredSegmentCounts.push({ eventId, count });
  },
}));

mock.module("../../../persistence/delivery-crud.js", () => ({
  linkMessage: () => {},
  storeReplyMessageId: (eventId: string, replyMessageId: string) => {
    storedReplyMessageIds.push({ eventId, replyMessageId });
  },
  storeStreamedReplyTs: (eventId: string, messageTs: string) => {
    operationOrder.push("store-streamed-ts");
    storedStreamedReplyTs.push({ eventId, messageTs });
  },
}));

mock.module("../../../persistence/delivery-status.js", () => ({
  markDeliveryDelivered: (eventId: string) => {
    deliveredEvents.push(eventId);
  },
  markProcessed: (eventId: string) => {
    markedProcessedEvents.push(eventId);
  },
  recordDeliveryFailure: (eventId: string) => {
    deliveryFailureEvents.push(eventId);
  },
  recordProcessingFailure: (eventId: string) => {
    operationOrder.push("processing-failure");
    processingFailureEvents.push(eventId);
  },
}));

mock.module("../../gateway-client.js", () => ({
  deliverChannelReply: async (
    callbackUrl: string,
    payload: Record<string, unknown>,
  ) => {
    deliveredChannelReplies.push({ callbackUrl, payload });
    return deliverChannelReplyImpl(callbackUrl, payload);
  },
}));

mock.module("../../channel-reply-delivery.js", () => ({
  deliverReplyViaCallback: async (...args: unknown[]) => {
    const options = args[4] as
      | { messageId?: string; startFromSegment?: number; messageTs?: string }
      | undefined;
    const call: (typeof replyDeliveryCalls)[number] = {
      messageId: options?.messageId,
    };
    if (options?.startFromSegment !== undefined) {
      call.startFromSegment = options.startFromSegment;
    }
    if (options?.messageTs !== undefined) {
      call.messageTs = options.messageTs;
    }
    replyDeliveryCalls.push(call);
    return deliverReplyViaCallbackImpl(...args);
  },
}));

import {
  clearThreadTs,
  getThreadTs,
  setThreadTs,
} from "../../../channels/slack-thread-store.js";
import type { TrustContext } from "../../../daemon/trust-context.js";
import type { MessageProcessor } from "../../http-types.js";
import {
  isBoundGuardianActor,
  processChannelMessageInBackground,
  shouldStartSlackThinkingStatusForText,
  shouldStartSlackThinkingStatusImmediately,
} from "./background-dispatch.js";

beforeEach(() => {
  deliveredChannelReplies.length = 0;
  markedProcessedEvents.length = 0;
  processingFailureEvents.length = 0;
  deliveredEvents.length = 0;
  deliveryFailureEvents.length = 0;
  deliveredSegmentCounts.length = 0;
  operationOrder.length = 0;
  storedReplyMessageIds.length = 0;
  storedStreamedReplyTs.length = 0;
  replyDeliveryCalls.length = 0;
  deliverChannelReplyImpl = async () => ({ ok: true });
  deliverReplyViaCallbackImpl = async () => {};
});

const slackStreamOps = (): Array<Record<string, unknown>> =>
  deliveredChannelReplies
    .map((entry) => entry.payload.slackStream as Record<string, unknown>)
    .filter(Boolean);

describe("isBoundGuardianActor", () => {
  test("returns true only when requester matches bound guardian", () => {
    expect(
      isBoundGuardianActor({
        trustClass: "guardian",
        guardianExternalUserId: "guardian-1",
        requesterExternalUserId: "guardian-1",
      }),
    ).toBe(true);
  });

  test("returns false for non-guardian trust classes", () => {
    expect(
      isBoundGuardianActor({
        trustClass: "trusted_contact",
        guardianExternalUserId: "guardian-1",
        requesterExternalUserId: "guardian-1",
      }),
    ).toBe(false);
  });

  test("returns false when guardian id is missing", () => {
    expect(
      isBoundGuardianActor({
        trustClass: "guardian",
        requesterExternalUserId: "guardian-1",
      }),
    ).toBe(false);
  });

  test("returns false when requester does not match guardian", () => {
    expect(
      isBoundGuardianActor({
        trustClass: "guardian",
        guardianExternalUserId: "guardian-1",
        requesterExternalUserId: "requester-1",
      }),
    ).toBe(false);
  });
});

describe("processChannelMessageInBackground — slack thread mapping", () => {
  const trustCtx: TrustContext = {
    trustClass: "guardian",
    guardianExternalUserId: "guardian-1",
    requesterExternalUserId: "guardian-1",
  } as unknown as TrustContext;

  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 10));

  test("restores prior thread mapping when processMessage is rejected as already-processing", async () => {
    const conversationId = "conv-restore-on-busy";
    const channelId = "C-RESTORE";
    const inFlightThreadTs = "1700000000.000001";

    // Simulate a prior threaded turn that installed the mapping and is
    // still in flight when a new channel-root event arrives.
    setThreadTs(conversationId, channelId, inFlightThreadTs);

    const processMessage: MessageProcessor = async () => {
      throw new Error("Conversation is already processing a message");
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-1",
      content: "root-level message",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      // Callback URL has no threadTs query param → channel-root event
      // that would otherwise call `clearThreadTs`.
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    // The in-flight threaded turn's mapping must survive the busy rejection.
    expect(getThreadTs(conversationId)).toBe(inFlightThreadTs);

    clearThreadTs(conversationId);
  });

  test("retains updated mapping when processMessage succeeds", async () => {
    const conversationId = "conv-retain-on-success";
    const channelId = "C-SUCCESS";
    const newThreadTs = "1700000000.000002";

    // No prior mapping; this turn arrives in a thread and should install one.
    clearThreadTs(conversationId);

    const processMessage: MessageProcessor = async () => ({
      messageId: "user-msg-1",
    });

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-2",
      content: "thread reply",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${newThreadTs}`,
    });

    await flush();

    expect(getThreadTs(conversationId)).toBe(newThreadTs);

    clearThreadTs(conversationId);
  });

  test("records callback delivery failures without failing processing", async () => {
    const conversationId = "conv-delivery-failure";
    const channelId = "C-DELIVERY-FAILURE";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-msg-delivery-failure",
      });
      return { messageId: "user-msg-delivery-failure" };
    };
    deliverReplyViaCallbackImpl = async () => {
      throw new Error("fetch failed");
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-delivery-failure",
      content: "please reply",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    expect(markedProcessedEvents).toEqual(["evt-delivery-failure"]);
    expect(processingFailureEvents).toEqual([]);
    expect(storedReplyMessageIds).toEqual([
      {
        eventId: "evt-delivery-failure",
        replyMessageId: "assistant-msg-delivery-failure",
      },
    ]);
    expect(replyDeliveryCalls).toEqual([
      { messageId: "assistant-msg-delivery-failure", startFromSegment: 0 },
    ]);
    expect(deliveryFailureEvents).toEqual(["evt-delivery-failure"]);
    expect(deliveredEvents).toEqual([]);

    clearThreadTs(conversationId);
  });

  test("stores assistant reply ids returned by non-agent-loop fast paths", async () => {
    const conversationId = "conv-fast-path-reply";
    const channelId = "C-FAST-PATH";

    const processMessage: MessageProcessor = async () => ({
      messageId: "user-msg-fast-path",
      assistantMessageId: "assistant-msg-fast-path",
    });

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-fast-path",
      content: "/unknown",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    expect(markedProcessedEvents).toEqual(["evt-fast-path"]);
    expect(storedReplyMessageIds).toEqual([
      {
        eventId: "evt-fast-path",
        replyMessageId: "assistant-msg-fast-path",
      },
    ]);
    expect(replyDeliveryCalls).toEqual([
      { messageId: "assistant-msg-fast-path", startFromSegment: 0 },
    ]);
    expect(deliveredEvents).toEqual(["evt-fast-path"]);

    clearThreadTs(conversationId);
  });

  test("falls back to durable delivery for a non-threaded Slack DM", async () => {
    const conversationId = "conv-dm-no-thread";
    const channelId = "D-NO-THREAD";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Reply with no thread to stream into.",
        conversationId,
      });
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-msg-no-thread",
      });
      return { messageId: "user-msg-no-thread" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-no-thread",
      content: "please reply",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "im",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    expect(slackStreamOps()).toEqual([]);
    expect(
      deliveredChannelReplies
        .map((entry) => entry.payload.text)
        .filter(Boolean),
    ).toEqual([]);
    expect(replyDeliveryCalls).toEqual([
      { messageId: "assistant-msg-no-thread", startFromSegment: 0 },
    ]);
    expect(deliveredEvents).toEqual(["evt-no-thread"]);

    clearThreadTs(conversationId);
  });

  test("streams a threaded Slack DM reply and reconciles durable delivery to the stream", async () => {
    const conversationId = "conv-dm-streamed";
    const channelId = "D-STREAMED";
    const threadTs = "1700000000.000044";
    const streamTs = "1700000000.000033";
    deliverChannelReplyImpl = async () => ({ ok: true, ts: streamTs });

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Streamed DM reply.",
        conversationId,
      });
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-msg-streamed",
      });
      return { messageId: "user-msg-streamed" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-streamed",
      content: "please reply",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "im",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    expect(slackStreamOps()).toEqual([
      { action: "start", threadTs, markdownText: "Streamed DM reply." },
      { action: "stop", streamTs },
    ]);
    expect(
      deliveredChannelReplies
        .map((entry) => entry.payload.text)
        .filter(Boolean),
    ).toEqual([]);
    expect(replyDeliveryCalls).toEqual([
      {
        messageId: "assistant-msg-streamed",
        startFromSegment: 1,
        messageTs: streamTs,
      },
    ]);
    expect(deliveredEvents).toEqual(["evt-streamed"]);

    clearThreadTs(conversationId);
  });

  test("keeps Slack channel replies on the existing final delivery path", async () => {
    const conversationId = "conv-channel-final-delivery";
    const channelId = "C-FINAL-DELIVERY";
    const threadTs = "1700000000.000022";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Intermediate text.",
        conversationId,
      });
      options?.onEvent?.({
        type: "tool_use_start",
        toolName: "web_search",
        input: { query: "example" },
        conversationId,
        toolUseId: "toolu_1",
      });
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Final text.",
        conversationId,
      });
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-msg-channel-final",
      });
      return { messageId: "user-msg-channel" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-channel-final-delivery",
      content: "channel request",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "channel",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    expect(
      deliveredChannelReplies
        .map((entry) => entry.payload.text)
        .filter(Boolean),
    ).toEqual([]);
    expect(slackStreamOps()).toEqual([]);
    expect(replyDeliveryCalls).toEqual([
      { messageId: "assistant-msg-channel-final", startFromSegment: 0 },
    ]);
    expect(deliveredEvents).toEqual(["evt-channel-final-delivery"]);

    clearThreadTs(conversationId);
  });

  test("falls back to durable delivery when the Slack stream fails to start", async () => {
    const conversationId = "conv-dm-stream-start-fails";
    const channelId = "D-STREAM-START-FAILS";
    const threadTs = "1700000000.000055";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Reply whose stream never opens.",
        conversationId,
      });
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-msg-stream-start-fails",
      });
      return { messageId: "user-msg-stream-start-fails" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-stream-start-fails",
      content: "please reply",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "im",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    expect(slackStreamOps().map((op) => op.action)).toEqual(["start"]);
    expect(replyDeliveryCalls).toEqual([
      { messageId: "assistant-msg-stream-start-fails", startFromSegment: 0 },
    ]);
    expect(deliveredEvents).toEqual(["evt-stream-start-fails"]);

    clearThreadTs(conversationId);
  });

  test("finalizes the stream and records a processing failure when processing throws", async () => {
    const conversationId = "conv-dm-stream-processing-failure";
    const channelId = "D-STREAM-PROCESSING-FAILURE";
    const threadTs = "1700000000.000066";
    const streamTs = "1700000000.000077";
    deliverChannelReplyImpl = async () => ({ ok: true, ts: streamTs });

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Streamed text before failure.",
        conversationId,
      });
      options?.onEvent?.({
        type: "tool_use_start",
        toolName: "web_search",
        input: { query: "example" },
        conversationId,
        toolUseId: "toolu_1",
      });
      throw new Error("processing failed after streamed text");
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-stream-processing-failure",
      content: "please do the thing",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "im",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    expect(slackStreamOps().map((op) => op.action)).toEqual(["start", "stop"]);
    expect(replyDeliveryCalls).toEqual([]);
    expect(storedStreamedReplyTs).toEqual([
      { eventId: "evt-stream-processing-failure", messageTs: streamTs },
    ]);
    expect(processingFailureEvents).toEqual(["evt-stream-processing-failure"]);
    expect(operationOrder).toEqual(["store-streamed-ts", "processing-failure"]);

    clearThreadTs(conversationId);
  });
});

describe("Slack thinking status timing", () => {
  const slackStatusLabels = [
    "is on it",
    "is working hard",
    "is touching grass",
  ];

  const trustCtx: TrustContext = {
    trustClass: "guardian",
    guardianExternalUserId: "guardian-1",
    requesterExternalUserId: "guardian-1",
  } as unknown as TrustContext;

  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 10));

  beforeEach(() => {
    deliveredChannelReplies.length = 0;
  });

  test("recognizes only deliverable text as a Slack thinking-status trigger", () => {
    expect(shouldStartSlackThinkingStatusForText("")).toBe(false);
    expect(shouldStartSlackThinkingStatusForText("   ")).toBe(false);
    expect(shouldStartSlackThinkingStatusForText("<")).toBe(false);
    expect(shouldStartSlackThinkingStatusForText("<no_response")).toBe(false);
    expect(shouldStartSlackThinkingStatusForText("<no_response/>")).toBe(false);
    expect(shouldStartSlackThinkingStatusForText("  <no_response />  ")).toBe(
      false,
    );
    expect(shouldStartSlackThinkingStatusForText("Real response.")).toBe(true);
    expect(
      shouldStartSlackThinkingStatusForText("<no_response/>\nReal response."),
    ).toBe(true);
  });

  test("starts Slack thinking status immediately for DMs and direct mentions", () => {
    expect(
      shouldStartSlackThinkingStatusImmediately({
        sourceChannel: "slack",
        chatType: "im",
      }),
    ).toBe(true);
    expect(
      shouldStartSlackThinkingStatusImmediately({
        sourceChannel: "slack",
        slackBotMentioned: true,
      }),
    ).toBe(true);
    expect(
      shouldStartSlackThinkingStatusImmediately({
        sourceChannel: "slack",
        chatType: "channel",
      }),
    ).toBe(false);
    expect(
      shouldStartSlackThinkingStatusImmediately({
        sourceChannel: "telegram",
        chatType: "im",
        slackBotMentioned: true,
      }),
    ).toBe(false);
  });

  test("sets Slack thinking indicator immediately for a DM", async () => {
    const conversationId = "conv-dm-immediate-status";
    const channelId = "D-DM-IMMEDIATE";
    const messageTs = "1700000000.000010";

    const processMessage: MessageProcessor = async () => {
      expect(deliveredChannelReplies).toHaveLength(1);
      expect(deliveredChannelReplies[0]!.payload.reaction).toEqual({
        action: "add",
        name: "eyes",
        messageTs,
      });
      return { messageId: "user-msg-dm-immediate" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-dm-immediate-status",
      content: "dm message",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "im",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&messageTs=${messageTs}`,
    });

    await flush();

    const reactions = deliveredChannelReplies.map(
      (entry) => entry.payload.reaction,
    );
    expect(reactions).toEqual([
      { action: "add", name: "eyes", messageTs },
      { action: "remove", name: "eyes", messageTs },
    ]);
  });

  test("sets Slack thinking status immediately for an app mention", async () => {
    const conversationId = "conv-mention-immediate-status";
    const channelId = "C-MENTION-IMMEDIATE";
    const threadTs = "1700000000.000011";

    const processMessage: MessageProcessor = async () => {
      expect(deliveredChannelReplies).toHaveLength(1);
      expect(deliveredChannelReplies[0]!.payload.assistantThreadStatus).toEqual(
        {
          channel: channelId,
          threadTs,
          status: expect.any(String),
          loadingMessages: ["Thinking\u2026"],
        },
      );
      const threadStatus = deliveredChannelReplies[0]!.payload
        .assistantThreadStatus as { status: string };
      expect(slackStatusLabels).toContain(threadStatus.status);
      return { messageId: "user-msg-mention-immediate" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-mention-immediate-status",
      content: "@assistant please respond",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      slackBotMentioned: true,
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    const statuses = deliveredChannelReplies.map((entry) => {
      const status = entry.payload.assistantThreadStatus as
        | { status?: string }
        | undefined;
      return status?.status;
    });
    expect(slackStatusLabels).toContain(statuses[0]!);
    expect(statuses[1]).toBe("");
  });

  test("does not set Slack thinking status for no_response text deltas", async () => {
    const conversationId = "conv-no-response-status";
    const channelId = "C-NO-RESPONSE";
    const threadTs = "1700000000.000003";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "<no_response/>",
        conversationId,
      });
      return { messageId: "user-msg-no-response" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-no-response-status",
      content: "ambient channel chatter",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    expect(deliveredChannelReplies).toEqual([]);
  });

  test("sets and clears Slack thinking status after real assistant text starts", async () => {
    const conversationId = "conv-real-response-status";
    const channelId = "C-REAL-RESPONSE";
    const threadTs = "1700000000.000004";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "<",
        conversationId,
      });
      expect(deliveredChannelReplies).toEqual([]);

      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "b>Working on it.",
        conversationId,
      });
      return { messageId: "user-msg-real-response" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-real-response-status",
      content: "please respond",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    const statuses = deliveredChannelReplies.map((entry) => {
      const status = entry.payload.assistantThreadStatus as
        | { status?: string }
        | undefined;
      return status?.status;
    });
    expect(slackStatusLabels).toContain(statuses[0]!);
    expect(statuses[1]).toBe("");
  });

  test("buffers task_progress for ambiguous Slack turns until deliverable text appears", async () => {
    const conversationId = "conv-progress-buffered";
    const channelId = "C-PROGRESS-BUFFERED";
    const threadTs = "1700000000.000012";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "ui_surface_show",
        conversationId,
        surfaceId: "surface-progress",
        surfaceType: "card",
        data: {
          title: "Task progress",
          body: "Working",
          template: "task_progress",
          templateData: {
            steps: [
              { label: "Search docs", status: "in_progress" },
              { label: "Summarize", status: "pending" },
            ],
          },
        },
      });
      expect(deliveredChannelReplies).toEqual([]);

      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "I found the answer.",
        conversationId,
      });
      return { messageId: "user-msg-progress-buffered" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-progress-buffered",
      content: "ambient request",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    const statuses = deliveredChannelReplies.map(
      (entry) => entry.payload.assistantThreadStatus,
    );
    expect(statuses).toEqual([
      {
        channel: channelId,
        threadTs,
        status: expect.any(String),
        loadingMessages: ["In progress (1/2): Search docs"],
      },
      {
        channel: channelId,
        threadTs,
        status: "",
      },
    ]);
    expect(slackStatusLabels).toContain(
      (statuses[0] as { status: string }).status,
    );
  });

  test("keeps ambiguous Slack no_response turns quiet even with task_progress", async () => {
    const conversationId = "conv-progress-no-response";
    const channelId = "C-PROGRESS-NO-RESPONSE";
    const threadTs = "1700000000.000013";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "ui_surface_show",
        conversationId,
        surfaceId: "surface-progress-no-response",
        surfaceType: "card",
        data: {
          title: "Task progress",
          body: "Working",
          template: "task_progress",
          templateData: {
            steps: [{ label: "Inspect", status: "in_progress" }],
          },
        },
      });
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "<no_response/>",
        conversationId,
      });
      return { messageId: "user-msg-progress-no-response" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-progress-no-response",
      content: "ambient chatter",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    expect(deliveredChannelReplies).toEqual([]);
  });

  test("updates Slack loading message when task_progress changes", async () => {
    const conversationId = "conv-progress-update";
    const channelId = "C-PROGRESS-UPDATE";
    const threadTs = "1700000000.000014";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      options?.onEvent?.({
        type: "ui_surface_show",
        conversationId,
        surfaceId: "surface-progress-update",
        surfaceType: "card",
        data: {
          title: "Task progress",
          body: "Working",
          template: "task_progress",
          templateData: {
            steps: [
              { label: "Read request", status: "in_progress" },
              { label: "Write answer", status: "pending" },
            ],
          },
        },
      });
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "On it.",
        conversationId,
      });
      options?.onEvent?.({
        type: "ui_surface_update",
        conversationId,
        surfaceId: "surface-progress-update",
        data: {
          templateData: {
            steps: [
              { label: "Read request", status: "completed" },
              { label: "Write answer", status: "in_progress" },
            ],
          },
        },
      });
      return { messageId: "user-msg-progress-update" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-progress-update",
      content: "please respond",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    const statuses = deliveredChannelReplies.map(
      (entry) => entry.payload.assistantThreadStatus,
    );
    expect(statuses).toEqual([
      {
        channel: channelId,
        threadTs,
        status: expect.any(String),
        loadingMessages: ["In progress (1/2): Read request"],
      },
      {
        channel: channelId,
        threadTs,
        status: expect.any(String),
        loadingMessages: ["In progress (2/2): Write answer"],
      },
      {
        channel: channelId,
        threadTs,
        status: "",
      },
    ]);
    expect(slackStatusLabels).toContain(
      (statuses[0] as { status: string }).status,
    );
    expect(slackStatusLabels).toContain(
      (statuses[1] as { status: string }).status,
    );
  });
});

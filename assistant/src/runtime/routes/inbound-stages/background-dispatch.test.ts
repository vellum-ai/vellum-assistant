import { beforeEach, describe, expect, mock, test } from "bun:test";

const deliveredChannelReplies: Array<{
  callbackUrl: string;
  payload: Record<string, unknown>;
}> = [];
const markedProcessedEvents: string[] = [];
const processingFailureEvents: string[] = [];
const retryableFailureEvents: string[] = [];
const deferredRetryEvents: string[] = [];
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
let siblingDeliveryStatuses: string[] = [];
let siblingStreamedReplyTs: string | undefined;
let deliverChannelReplyImpl: (
  callbackUrl: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async () => ({ ok: true });
let deliverReplyViaCallbackImpl: (
  ...args: unknown[]
) => Promise<void> = async () => {};

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
  getSiblingStreamedReplyTs: () => siblingStreamedReplyTs,
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
  markRetryableFailure: (eventId: string) => {
    operationOrder.push("retryable-failure");
    retryableFailureEvents.push(eventId);
  },
  deferRetryUntilIdle: (eventId: string) => {
    operationOrder.push("defer-retry");
    deferredRetryEvents.push(eventId);
  },
  getSiblingEventDeliveryStatuses: () => siblingDeliveryStatuses,
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

const sentStreamOps: Array<Record<string, unknown>> = [];
let sendChannelStreamOpImpl: (
  op: Record<string, unknown>,
) => Promise<{ ok: boolean; ts?: string }> = async () => ({ ok: true });
const sentActivity: Array<Record<string, unknown>> = [];
let setChannelActivityImpl: (
  target: Record<string, unknown>,
) => { ok: boolean } | Promise<{ ok: boolean }> = () => ({ ok: true });
// Undefined stands for a channel whose indicator holds until it is changed, so
// the controller reports each phase once and the assertions read as the turn's
// lifecycle rather than as timer ticks. A test that needs the self-expiring
// shape sets a cadence.
let activityRefreshMsImpl: () => number | undefined = () => undefined;
mock.module("../../../messaging/providers/index.js", () => ({
  supportsChannelActivity: () => true,
  channelActivityRefreshMs: () => activityRefreshMsImpl(),
  setChannelActivity: async (
    _callbackUrl: string,
    target: Record<string, unknown>,
  ) => {
    sentActivity.push(target);
    return setChannelActivityImpl(target);
  },
  sendChannelStreamOp: async (
    _callbackUrl: string,
    _chatId: string,
    op: Record<string, unknown>,
  ) => {
    sentStreamOps.push(op);
    return sendChannelStreamOpImpl(op);
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

import type { Conversation } from "../../../daemon/conversation.js";
import { CONVERSATION_BUSY_MESSAGE } from "../../../daemon/conversation-messaging.js";
import {
  clearConversations,
  setConversation,
} from "../../../daemon/conversation-registry.js";
import type { TrustContext } from "../../../daemon/trust-context-types.js";
import type { MessageProcessor } from "../../http-types.js";
import {
  isBoundGuardianActor,
  processChannelMessageInBackground,
  shouldShowActivityForText,
  shouldShowActivityImmediately,
} from "./background-dispatch.js";
import { __resetChannelTurnAdmissionForTests } from "./channel-turn-admission.js";

beforeEach(() => {
  __resetChannelTurnAdmissionForTests();
  clearConversations();
  deliveredChannelReplies.length = 0;
  sentStreamOps.length = 0;
  sendChannelStreamOpImpl = async () => ({ ok: true });
  sentActivity.length = 0;
  setChannelActivityImpl = () => ({ ok: true });
  activityRefreshMsImpl = () => undefined;
  markedProcessedEvents.length = 0;
  processingFailureEvents.length = 0;
  retryableFailureEvents.length = 0;
  deferredRetryEvents.length = 0;
  deliveredEvents.length = 0;
  deliveryFailureEvents.length = 0;
  deliveredSegmentCounts.length = 0;
  operationOrder.length = 0;
  storedReplyMessageIds.length = 0;
  storedStreamedReplyTs.length = 0;
  replyDeliveryCalls.length = 0;
  siblingDeliveryStatuses = [];
  siblingStreamedReplyTs = undefined;
  deliverChannelReplyImpl = async () => ({ ok: true });
  deliverReplyViaCallbackImpl = async () => {};
});

const slackStreamOps = (): Array<Record<string, unknown>> => sentStreamOps;

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

describe("processChannelMessageInBackground — reply delivery", () => {
  const trustCtx: TrustContext = {
    trustClass: "guardian",
    guardianExternalUserId: "guardian-1",
    requesterExternalUserId: "guardian-1",
  } as unknown as TrustContext;

  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 10));

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
  });

  test("suppresses reply delivery when a deduplicated redelivery's prior attempt already delivered", async () => {
    const conversationId = "conv-dedup-delivered";
    const channelId = "C-DEDUP-DELIVERED";

    // At-least-once redelivery: the persist layer dedups on the idempotency
    // key, so processMessage skips the agent loop and returns `deduplicated`.
    // The original sibling event already reached `delivered`, so re-emitting
    // the reply would duplicate it.
    siblingDeliveryStatuses = ["delivered"];
    const processMessage: MessageProcessor = async () => ({
      messageId: "user-msg-dedup",
      deduplicated: true,
    });

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-dedup-delivered",
      content: "redelivered message",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    // The redelivery is recorded as processed, but the original reply is not
    // re-delivered — no durable delivery, no terminal delivery transition.
    expect(markedProcessedEvents).toEqual(["evt-dedup-delivered"]);
    expect(replyDeliveryCalls).toEqual([]);
    expect(deliveredEvents).toEqual([]);
    expect(deliveredChannelReplies).toEqual([]);
  });

  test("skips reply delivery when a deduplicated redelivery's prior attempt failed (sweep owns recovery)", async () => {
    const conversationId = "conv-dedup-failed";
    const channelId = "C-DEDUP-FAILED";

    // The original sibling event's delivery failed and is owned by the
    // delivery-retry sweep; the redelivery must not race it.
    siblingDeliveryStatuses = ["failed"];
    const processMessage: MessageProcessor = async () => ({
      messageId: "user-msg-dedup",
      deduplicated: true,
    });

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-dedup-failed",
      content: "redelivered message",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    expect(markedProcessedEvents).toEqual(["evt-dedup-failed"]);
    expect(replyDeliveryCalls).toEqual([]);
    expect(deliveredEvents).toEqual([]);
    expect(deliveredChannelReplies).toEqual([]);
  });

  test("recovers the reply when a deduplicated redelivery's prior attempt is stuck pending (crash window)", async () => {
    const conversationId = "conv-dedup-pending";
    const channelId = "C-DEDUP-PENDING";

    // The first process persisted the turn but died before recording a
    // delivery outcome, leaving the original sibling event stuck `pending`.
    // The sweep only selects `failed`, so this redelivery is the only path
    // that can recover the undelivered reply.
    siblingDeliveryStatuses = ["pending"];
    const processMessage: MessageProcessor = async () => ({
      messageId: "user-msg-dedup",
      deduplicated: true,
    });

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-dedup-pending",
      content: "redelivered message",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    // finalizeEventDelivery runs: it re-delivers the original turn's reply via
    // `sinceMessageId` (no targeted `messageId`, since no agent loop ran) and
    // marks this event delivered.
    expect(markedProcessedEvents).toEqual(["evt-dedup-pending"]);
    expect(replyDeliveryCalls).toEqual([
      { messageId: undefined, startFromSegment: 0 },
    ]);
    expect(deliveredEvents).toEqual(["evt-dedup-pending"]);
  });

  test("edits the sibling's streamed Slack reply in place when recovering a deduplicated redelivery in the crash window", async () => {
    const conversationId = "conv-dedup-pending-streamed";
    const channelId = "C-DEDUP-PENDING-STREAMED";
    const streamTs = "1700000000.000099";

    // The original attempt streamed its reply live into Slack — its message
    // `ts` is durably recorded on the sibling row — but crashed before
    // finalizing delivery, leaving the sibling stuck `pending`. Reposting the
    // persisted reply would duplicate the already-visible streamed message, so
    // recovery must reuse the recorded `ts` to edit that message in place.
    siblingDeliveryStatuses = ["pending"];
    siblingStreamedReplyTs = streamTs;
    const processMessage: MessageProcessor = async () => ({
      messageId: "user-msg-dedup",
      deduplicated: true,
    });

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-dedup-pending-streamed",
      content: "redelivered message",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    // The reply is delivered onto the existing streamed message (`messageTs`
    // reused) rather than posted anew, and the event is marked delivered.
    expect(markedProcessedEvents).toEqual(["evt-dedup-pending-streamed"]);
    expect(replyDeliveryCalls).toEqual([
      { messageId: undefined, startFromSegment: 0, messageTs: streamTs },
    ]);
    expect(deliveredEvents).toEqual(["evt-dedup-pending-streamed"]);
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
  });

  test("streams a threaded Slack DM reply and reconciles durable delivery to the stream", async () => {
    const conversationId = "conv-dm-streamed";
    const channelId = "D-STREAMED";
    const threadTs = "1700000000.000044";
    const streamTs = "1700000000.000033";
    sendChannelStreamOpImpl = async () => ({ ok: true, ts: streamTs });

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
      {
        action: "start",
        anchorMessageId: threadTs,
        text: "Streamed DM reply.",
        appended: "Streamed DM reply.",
      },
      { action: "stop", streamId: streamTs, text: "Streamed DM reply." },
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
    // The stream `ts` is durably recorded the moment the stream opens, so a
    // crash before delivery finalizes leaves a breadcrumb for recovery.
    expect(storedStreamedReplyTs).toEqual([
      { eventId: "evt-streamed", messageTs: streamTs },
    ]);
    expect(deliveredEvents).toEqual(["evt-streamed"]);
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
  });

  test("finalizes the stream and records a processing failure when processing throws", async () => {
    const conversationId = "conv-dm-stream-processing-failure";
    const channelId = "D-STREAM-PROCESSING-FAILURE";
    const threadTs = "1700000000.000066";
    const streamTs = "1700000000.000077";
    sendChannelStreamOpImpl = async () => ({ ok: true, ts: streamTs });

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
  });
});

describe("processChannelMessageInBackground — admission (queue if busy)", () => {
  const trustCtx: TrustContext = {
    trustClass: "guardian",
    guardianExternalUserId: "guardian-1",
    requesterExternalUserId: "guardian-1",
  } as unknown as TrustContext;

  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 10));

  /** Register a busy stand-in conversation; `release()` frees its lock. */
  function registerBusyConversation(conversationId: string): {
    release: () => void;
  } {
    let processing = true;
    const idleWaiters = new Set<() => void>();
    const fake = {
      isProcessing: () => processing,
      waitForIdle: ({ timeoutMs }: { timeoutMs: number }) =>
        new Promise<boolean>((resolve) => {
          if (!processing) {
            resolve(true);
            return;
          }
          const notify = (): void => {
            clearTimeout(timer);
            idleWaiters.delete(notify);
            resolve(true);
          };
          const timer = setTimeout(() => {
            idleWaiters.delete(notify);
            resolve(false);
          }, timeoutMs);
          (timer as { unref?: () => void }).unref?.();
          idleWaiters.add(notify);
        }),
    };
    setConversation(conversationId, fake as unknown as Conversation);
    return {
      release: () => {
        processing = false;
        for (const notify of [...idleWaiters]) {
          notify();
        }
      },
    };
  }

  test("defers a channel turn while the conversation is mid-turn, then processes and delivers on idle", async () => {
    const conversationId = "conv-admission-defer";
    const channelId = "C-ADMISSION-DEFER";
    const busy = registerBusyConversation(conversationId);

    let processed = false;
    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      options,
    ) => {
      processed = true;
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-msg-admission",
      });
      return { messageId: "user-msg-admission" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-admission-defer",
      content: "thread reply that arrived mid-session",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "channel",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();
    // Mid-turn: the reply is deferred — not dropped, not run concurrently.
    expect(processed).toBe(false);
    expect(markedProcessedEvents).toEqual([]);
    expect(processingFailureEvents).toEqual([]);
    expect(retryableFailureEvents).toEqual([]);

    busy.release();
    await flush();

    // The instant the in-flight turn frees the lock, the deferred reply runs
    // and delivers.
    expect(processed).toBe(true);
    expect(markedProcessedEvents).toEqual(["evt-admission-defer"]);
    expect(replyDeliveryCalls).toEqual([
      { messageId: "assistant-msg-admission", startFromSegment: 0 },
    ]);
    expect(deliveredEvents).toEqual(["evt-admission-defer"]);
  });

  test("routes a busy error after admission to the retry sweep instead of dead-lettering", async () => {
    const conversationId = "conv-admission-busy-race";
    const channelId = "C-ADMISSION-BUSY-RACE";
    // The conversation is not resident, so admission admits immediately, but the
    // turn still throws the busy error (a non-channel turn took the lock in the
    // race window). It must be retryable, never a fatal dead-letter.
    const processMessage: MessageProcessor = async () => {
      throw new Error(CONVERSATION_BUSY_MESSAGE);
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-admission-busy-race",
      content: "please reply",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "channel",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}`,
    });

    await flush();

    // Re-scheduled for the sweep without burning an attempt or dead-lettering.
    expect(deferredRetryEvents).toEqual(["evt-admission-busy-race"]);
    expect(retryableFailureEvents).toEqual([]);
    expect(processingFailureEvents).toEqual([]);
    expect(markedProcessedEvents).toEqual([]);
    expect(deliveredEvents).toEqual([]);
  });
});

describe("channel activity timing", () => {
  const trustCtx: TrustContext = {
    trustClass: "guardian",
    guardianExternalUserId: "guardian-1",
    requesterExternalUserId: "guardian-1",
  } as unknown as TrustContext;

  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 10));

  const phases = (): unknown[] =>
    sentActivity.map((entry) => (entry as { phase?: unknown }).phase);

  beforeEach(() => {
    deliveredChannelReplies.length = 0;
  });

  test("recognizes only deliverable text as a reason to show activity", () => {
    expect(shouldShowActivityForText("")).toBe(false);
    expect(shouldShowActivityForText("   ")).toBe(false);
    expect(shouldShowActivityForText("<")).toBe(false);
    expect(shouldShowActivityForText("<no_response")).toBe(false);
    expect(shouldShowActivityForText("<no_response/>")).toBe(false);
    expect(shouldShowActivityForText("  <no_response />  ")).toBe(false);
    expect(shouldShowActivityForText("Real response.")).toBe(true);
    expect(shouldShowActivityForText("<no_response/>\nReal response.")).toBe(
      true,
    );
  });

  test("recognizes a direct conversation in every channel's word for one", () => {
    // One idea, three spellings, because `chatType` arrives as whatever the
    // channel called it. Slack `im`, Discord `dm`, Telegram `private`. Missing
    // one does not fail loudly: that channel silently reads as an ambient room
    // and stops showing an indicator it used to show.
    expect(shouldShowActivityImmediately({ chatType: "im" })).toBe(true);
    expect(shouldShowActivityImmediately({ chatType: "dm" })).toBe(true);
    expect(shouldShowActivityImmediately({ chatType: "private" })).toBe(true);
  });

  test("treats a room with other readers as ambient, including a group DM", () => {
    // Slack's `mpim` has other readers, so it is a room: the assistant may
    // process the traffic and decide to stay quiet, and an indicator there
    // announces it was reading.
    expect(shouldShowActivityImmediately({ chatType: "mpim" })).toBe(false);
    expect(shouldShowActivityImmediately({ chatType: "channel" })).toBe(false);
    expect(shouldShowActivityImmediately({ chatType: "supergroup" })).toBe(
      false,
    );
    expect(shouldShowActivityImmediately({})).toBe(false);
  });

  test("shows activity immediately when the assistant is mentioned", () => {
    expect(shouldShowActivityImmediately({ botMentioned: true })).toBe(true);
    expect(
      shouldShowActivityImmediately({
        chatType: "channel",
        botMentioned: true,
      }),
    ).toBe(true);
  });

  test("shows activity immediately in a DM and settles it when the turn ends", async () => {
    const conversationId = "conv-dm-immediate-activity";
    const channelId = "D-DM-IMMEDIATE";
    const messageTs = "1700000000.000010";

    const processMessage: MessageProcessor = async () => {
      // Already showing before the turn does any work: a DM is addressed to
      // the assistant, so nothing needs to be observed first.
      expect(phases()).toEqual(["thinking"]);
      return { messageId: "user-msg-dm-immediate" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-dm-immediate-activity",
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

    // `idle` is owed explicitly. A channel that holds its indicator keeps it
    // up until told otherwise, so a missing terminal phase is a stuck spinner
    // rather than a cosmetic slip.
    expect(phases()).toEqual(["thinking", "idle"]);
    expect(sentActivity[0]).toEqual({ chatId: channelId, phase: "thinking" });
  });

  test("shows activity immediately for an app mention and settles it", async () => {
    const conversationId = "conv-mention-immediate-activity";
    const channelId = "C-MENTION-IMMEDIATE";
    const threadTs = "1700000000.000011";

    const processMessage: MessageProcessor = async () => {
      expect(phases()).toEqual(["thinking"]);
      return { messageId: "user-msg-mention-immediate" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-mention-immediate-activity",
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

    expect(phases()).toEqual(["thinking", "idle"]);
  });

  test("retries a terminal transition the channel failed to accept", async () => {
    const conversationId = "conv-idle-retry";
    const channelId = "D-IDLE-RETRY";
    let idleAttempts = 0;
    setChannelActivityImpl = (target) => {
      if (target.phase === "idle") {
        idleAttempts += 1;
        return { ok: idleAttempts > 1 };
      }
      return { ok: true };
    };

    processChannelMessageInBackground({
      processMessage: async () => ({ messageId: "user-msg-idle-retry" }),
      conversationId,
      eventId: "evt-idle-retry",
      content: "dm message",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "im",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&messageTs=1700000000.000020`,
    });

    await flush();

    // A dropped `idle` is not cosmetic on a channel that holds its indicator:
    // Slack keeps showing the assistant as working for an hour, so the
    // terminal transition is the one worth attempting twice.
    expect(idleAttempts).toBe(2);
  });

  test("runs idle next when the turn stops during a slow request, with no stale busy phase between", async () => {
    const conversationId = "conv-slow-refresh";
    const channelId = "D-SLOW-REFRESH";

    // A self-expiring channel re-asserts on a timer, which is the only shape
    // where a refresh backlog can form at all.
    activityRefreshMsImpl = () => 5;

    let release: (() => void) | undefined;
    let calls = 0;
    setChannelActivityImpl = (target) => {
      calls += 1;
      if (calls === 1 && target.phase !== "idle") {
        // Hold the first busy call open across many refresh intervals.
        return new Promise<{ ok: boolean }>((resolve) => {
          release = () => resolve({ ok: true });
        });
      }
      return { ok: true };
    };

    const processMessage: MessageProcessor = async () => {
      // Long enough for several ticks to fire while the first call is unresolved.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { messageId: "user-msg-slow-refresh" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-slow-refresh",
      content: "dm message",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      chatType: "im",
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&messageTs=1700000000.000030`,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    release?.();
    await flush();

    const seen = phases();
    // The terminal phase is last and nothing busy follows it. A busy phase
    // executing after `idle` is the visible bug: the indicator comes back on a
    // turn that has already replied, which teaches people to distrust it.
    expect(seen.at(-1)).toBe("idle");
    expect(seen.slice(seen.indexOf("idle") + 1)).toEqual([]);
    // Ticks did not accumulate behind the outstanding call. Counting rather
    // than checking the last entry is what catches a backlog that happens to
    // drain in a harmless order.
    expect(seen.filter((phase) => phase === "thinking")).toHaveLength(1);
  });

  test("stays silent for a turn that decides not to answer", async () => {
    const conversationId = "conv-no-response-activity";
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
      eventId: "evt-no-response-activity",
      content: "ambient channel chatter",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    // Not merely "no spinner": nothing at all was said to the channel. An
    // `idle` here would still be a message about a turn nobody asked to see,
    // and in a shared room it announces that the assistant read the traffic.
    expect(sentActivity).toEqual([]);
    expect(deliveredChannelReplies).toEqual([]);
  });

  test("waits for real text in a room it was not addressed in, then settles", async () => {
    const conversationId = "conv-real-response-activity";
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
      // A partial `<` could still become `<no_response/>`, so nothing shows.
      expect(sentActivity).toEqual([]);

      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "b>Working on it.",
        conversationId,
      });
      expect(phases()).toEqual(["thinking"]);
      return { messageId: "user-msg-real-response" };
    };

    processChannelMessageInBackground({
      processMessage,
      conversationId,
      eventId: "evt-real-response-activity",
      content: "please respond",
      sourceChannel: "slack",
      sourceInterface: "slack",
      externalChatId: channelId,
      trustCtx,
      metadataHints: [],
      replyCallbackUrl: `https://example.test/deliver/slack?channel=${channelId}&threadTs=${threadTs}`,
    });

    await flush();

    expect(phases()).toEqual(["thinking", "idle"]);
  });
});

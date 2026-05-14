import { beforeEach, describe, expect, mock, test } from "bun:test";

const deliveredChannelReplies: Array<{
  callbackUrl: string;
  payload: Record<string, unknown>;
}> = [];

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../memory/delivery-channels.js", () => ({
  updateDeliveredSegmentCount: () => {},
}));

mock.module("../../../memory/delivery-crud.js", () => ({
  linkMessage: () => {},
}));

mock.module("../../../memory/delivery-status.js", () => ({
  markProcessed: () => {},
  recordProcessingFailure: () => {},
}));

mock.module("../../gateway-client.js", () => ({
  deliverChannelReply: async (
    callbackUrl: string,
    payload: Record<string, unknown>,
  ) => {
    deliveredChannelReplies.push({ callbackUrl, payload });
    return { ok: true };
  },
}));

mock.module("../channel-delivery-routes.js", () => ({
  deliverReplyViaCallback: async () => {},
}));

import type { TrustContext } from "../../../daemon/trust-context.js";
import {
  clearThreadTs,
  getThreadTs,
  setThreadTs,
} from "../../../memory/slack-thread-store.js";
import type { MessageProcessor } from "../../http-types.js";
import {
  isBoundGuardianActor,
  processChannelMessageInBackground,
  shouldStartSlackThinkingStatusForText,
  shouldStartSlackThinkingStatusImmediately,
} from "./background-dispatch.js";

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
});

describe("Slack thinking status timing", () => {
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
          status: "is thinking...",
        },
      );
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
    expect(statuses).toEqual(["is thinking...", ""]);
  });

  test("does not set Slack thinking status for no_response text deltas", async () => {
    const conversationId = "conv-no-response-status";
    const channelId = "C-NO-RESPONSE";
    const threadTs = "1700000000.000003";

    const processMessage: MessageProcessor = async (
      _conversationId,
      _content,
      _attachmentIds,
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
      _attachmentIds,
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
    expect(statuses).toEqual(["is thinking...", ""]);
  });
});

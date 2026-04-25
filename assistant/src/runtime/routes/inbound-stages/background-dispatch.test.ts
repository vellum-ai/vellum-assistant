import { describe, expect, mock, test } from "bun:test";

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

import type { TrustContext } from "../../../daemon/conversation-runtime-assembly.js";
import {
  clearThreadTs,
  getThreadTs,
  setThreadTs,
} from "../../../memory/slack-thread-store.js";
import type { MessageProcessor } from "../../http-types.js";
import {
  isBoundGuardianActor,
  processChannelMessageInBackground,
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

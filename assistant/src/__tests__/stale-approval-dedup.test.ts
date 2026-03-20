import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const deliveredMessages: Array<{
  url: string;
  body: Record<string, unknown>;
}> = [];

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (url: string, body: Record<string, unknown>) => {
    deliveredMessages.push({ url, body });
  },
}));

mock.module("../runtime/approval-message-composer.js", () => ({
  composeApprovalMessageGenerative: async () => "Already resolved.",
}));

// ---------------------------------------------------------------------------
// Import the module under test after mocks are set up
// ---------------------------------------------------------------------------

import type pino from "pino";

import {
  clearStaleNotificationCache,
  deliverStaleApprovalReply,
} from "../runtime/routes/guardian-approval-reply-helpers.js";

const noopLogger = new Proxy({} as pino.Logger, {
  get: () => () => {},
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deliverStaleApprovalReply deduplication", () => {
  beforeEach(() => {
    deliveredMessages.length = 0;
    clearStaleNotificationCache();
  });

  afterEach(() => {
    clearStaleNotificationCache();
  });

  test("sends the first 'approval_already_resolved' notification", async () => {
    await deliverStaleApprovalReply({
      scenario: "approval_already_resolved",
      sourceChannel: "slack",
      replyCallbackUrl: "https://example.com/reply",
      chatId: "chat-1",
      assistantId: "asst-1",
      logger: noopLogger,
      errorLogMessage: "test",
    });

    expect(deliveredMessages).toHaveLength(1);
  });

  test("suppresses duplicate 'approval_already_resolved' for the same chat", async () => {
    const params = {
      scenario: "approval_already_resolved" as const,
      sourceChannel: "slack" as const,
      replyCallbackUrl: "https://example.com/reply",
      chatId: "chat-1",
      assistantId: "asst-1",
      logger: noopLogger,
      errorLogMessage: "test",
    };

    await deliverStaleApprovalReply(params);
    await deliverStaleApprovalReply(params);
    await deliverStaleApprovalReply(params);

    expect(deliveredMessages).toHaveLength(1);
  });

  test("allows 'approval_already_resolved' for different chats", async () => {
    const base = {
      scenario: "approval_already_resolved" as const,
      sourceChannel: "slack" as const,
      replyCallbackUrl: "https://example.com/reply",
      assistantId: "asst-1",
      logger: noopLogger,
      errorLogMessage: "test",
    };

    await deliverStaleApprovalReply({ ...base, chatId: "chat-1" });
    await deliverStaleApprovalReply({ ...base, chatId: "chat-2" });

    expect(deliveredMessages).toHaveLength(2);
  });

  test("does not deduplicate non-'approval_already_resolved' scenarios", async () => {
    const params = {
      scenario: "reminder_prompt" as const,
      sourceChannel: "slack" as const,
      replyCallbackUrl: "https://example.com/reply",
      chatId: "chat-1",
      assistantId: "asst-1",
      logger: noopLogger,
      errorLogMessage: "test",
    };

    await deliverStaleApprovalReply(params);
    await deliverStaleApprovalReply(params);

    expect(deliveredMessages).toHaveLength(2);
  });

  test("allows re-send after cache is cleared (simulates TTL expiry)", async () => {
    const params = {
      scenario: "approval_already_resolved" as const,
      sourceChannel: "slack" as const,
      replyCallbackUrl: "https://example.com/reply",
      chatId: "chat-1",
      assistantId: "asst-1",
      logger: noopLogger,
      errorLogMessage: "test",
    };

    await deliverStaleApprovalReply(params);
    expect(deliveredMessages).toHaveLength(1);

    // Simulate TTL expiry
    clearStaleNotificationCache();

    await deliverStaleApprovalReply(params);
    expect(deliveredMessages).toHaveLength(2);
  });
});

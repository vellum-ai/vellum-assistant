import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { RuntimeAttachmentMetadata } from "../runtime/http-types.js";

type DeliveryCall = {
  callbackUrl: string;
  payload: Record<string, unknown>;
  bearerToken?: string;
};

const deliveryCalls: DeliveryCall[] = [];
const conversationMessages: Array<{
  id: string;
  role: string;
  content: string;
}> = [];
const attachmentsByMessageId = new Map<
  string,
  Array<{
    id: string;
    originalFilename?: string;
    mimeType?: string;
    sizeBytes?: number;
    kind?: string;
  }>
>();

let renderedHistoryContent: {
  text: string;
  textSegments: string[];
  toolCalls: unknown[];
  toolCallsBeforeText: boolean;
  contentOrder: string[];
  surfaces: unknown[];
} = {
  text: "",
  textSegments: [],
  toolCalls: [],
  toolCallsBeforeText: false,
  contentOrder: [],
  surfaces: [],
};

let deliveryFailAtIndex = -1;

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    callbackUrl: string,
    payload: Record<string, unknown>,
    bearerToken?: string,
  ) => {
    if (
      deliveryFailAtIndex >= 0 &&
      deliveryCalls.length === deliveryFailAtIndex
    ) {
      throw new Error("Simulated delivery failure (502)");
    }
    deliveryCalls.push({ callbackUrl, payload, bearerToken });
    return { ok: true };
  },
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  addMessage: () => ({ id: "mock-msg-id" }),
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  }),
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => conversationMessages,
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: (messageId: string) =>
    attachmentsByMessageId.get(messageId) ?? [],
}));

mock.module("../daemon/handlers/shared.js", () => ({
  renderHistoryContent: () => renderedHistoryContent,
}));

const { deliverRenderedReplyViaCallback, deliverReplyViaCallback } =
  await import("../runtime/channel-reply-delivery.js");

describe("channel-reply-delivery", () => {
  beforeEach(() => {
    deliveryCalls.length = 0;
    deliveryFailAtIndex = -1;
    conversationMessages.length = 0;
    attachmentsByMessageId.clear();
    renderedHistoryContent = {
      text: "",
      textSegments: [],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: [],
      surfaces: [],
    };
  });

  it("sends non-empty text segments as separate messages and puts attachments on the last segment", async () => {
    const attachments: RuntimeAttachmentMetadata[] = [
      {
        id: "att-1",
        filename: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        kind: "uploaded",
      },
    ];

    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-1",
      textSegments: ["Before tool.", "   ", "", "After tool."],
      fallbackText: "Before tool.After tool.",
      attachments,
      assistantId: "assistant-1",
      bearerToken: "token",
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0]).toEqual({
      callbackUrl: "http://gateway/deliver/telegram",
      payload: {
        chatId: "chat-1",
        text: "Before tool.",
        attachments: undefined,
        assistantId: "assistant-1",
      },
      bearerToken: "token",
    });
    expect(deliveryCalls[1]).toEqual({
      callbackUrl: "http://gateway/deliver/telegram",
      payload: {
        chatId: "chat-1",
        text: "After tool.",
        attachments,
        assistantId: "assistant-1",
      },
      bearerToken: "token",
    });
  });

  it("falls back to rendered.text when no non-empty textSegments exist", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-2",
      textSegments: [" ", ""],
      fallbackText: "Fallback text",
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("Fallback text");
  });

  it("uses rendered textSegments (tool boundaries) when delivering from conversation history", async () => {
    conversationMessages.push(
      { id: "msg-user", role: "user", content: "hi" },
      {
        id: "msg-assistant",
        role: "assistant",
        content: '[{"type":"text","text":"ignored"}]',
      },
    );
    attachmentsByMessageId.set("msg-assistant", [
      {
        id: "att-2",
        originalFilename: "log.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
        kind: "uploaded",
      },
    ]);
    renderedHistoryContent = {
      text: "Before tool.After tool.",
      textSegments: ["Before tool.", "After tool."],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0", "tool:0", "text:1"],
      surfaces: [],
    };

    await deliverReplyViaCallback(
      "conv-1",
      "chat-3",
      "http://gateway/deliver/telegram",
      "token",
      "assistant-2",
    );

    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0].payload).toEqual({
      chatId: "chat-3",
      text: "Before tool.",
      attachments: undefined,
      assistantId: "assistant-2",
    });
    expect(deliveryCalls[1].payload).toEqual({
      chatId: "chat-3",
      text: "After tool.",
      attachments: [
        {
          id: "att-2",
          filename: "log.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
          kind: "uploaded",
        },
      ],
      assistantId: "assistant-2",
    });
  });

  it("skips already-delivered segments when startFromSegment is set", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-resume",
      textSegments: ["Segment A.", "Segment B.", "Segment C."],
      interSegmentDelayMs: 0,
      startFromSegment: 1,
    });

    // Should only deliver segments B and C (indices 1 and 2)
    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0].payload.text).toBe("Segment B.");
    expect(deliveryCalls[1].payload.text).toBe("Segment C.");
  });

  it("calls onSegmentDelivered after each successful segment", async () => {
    const delivered: number[] = [];

    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-progress",
      textSegments: ["Part 1.", "Part 2.", "Part 3."],
      interSegmentDelayMs: 0,
      onSegmentDelivered: (count) => delivered.push(count),
    });

    expect(delivered).toEqual([1, 2, 3]);
    expect(deliveryCalls).toHaveLength(3);
  });

  it("does not call onSegmentDelivered for a failing segment", async () => {
    const delivered: number[] = [];
    deliveryFailAtIndex = 2;

    try {
      await deliverRenderedReplyViaCallback({
        callbackUrl: "http://gateway/deliver/telegram",
        chatId: "chat-fail",
        textSegments: ["Part 1.", "Part 2.", "Part 3."],
        interSegmentDelayMs: 0,
        onSegmentDelivered: (count) => delivered.push(count),
      });
    } catch {
      // Expected failure on third segment
    }

    // Only segments 0 and 1 were delivered, callback was called twice
    expect(delivered).toEqual([1, 2]);
    expect(deliveryCalls).toHaveLength(2);
  });

  it("resumes delivery after partial failure using startFromSegment", async () => {
    const delivered: number[] = [];

    // First attempt: fails on third segment (index 2)
    deliveryFailAtIndex = 2;
    try {
      await deliverRenderedReplyViaCallback({
        callbackUrl: "http://gateway/deliver/telegram",
        chatId: "chat-retry",
        textSegments: ["Seg A.", "Seg B.", "Seg C."],
        interSegmentDelayMs: 0,
        onSegmentDelivered: (count) => delivered.push(count),
      });
    } catch {
      // Expected
    }

    expect(delivered).toEqual([1, 2]);
    expect(deliveryCalls).toHaveLength(2);

    // Reset for retry
    deliveryCalls.length = 0;
    delivered.length = 0;
    deliveryFailAtIndex = -1;

    // Retry: start from segment 2 (the last delivered count)
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-retry",
      textSegments: ["Seg A.", "Seg B.", "Seg C."],
      interSegmentDelayMs: 0,
      startFromSegment: 2,
      onSegmentDelivered: (count) => delivered.push(count),
    });

    // Only segment C should be delivered
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("Seg C.");
    expect(delivered).toEqual([3]);
  });

  it("skips all segments when startFromSegment equals total count", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-done",
      textSegments: ["Done A.", "Done B."],
      interSegmentDelayMs: 0,
      startFromSegment: 2,
    });

    // All segments already delivered, nothing to send
    expect(deliveryCalls).toHaveLength(0);
  });

  it("passes ephemeral and user through to each delivery call", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "C123",
      textSegments: ["Part 1.", "Part 2."],
      interSegmentDelayMs: 0,
      ephemeral: true,
      user: "U456",
    });

    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0].payload.ephemeral).toBe(true);
    expect(deliveryCalls[0].payload.user).toBe("U456");
    expect(deliveryCalls[1].payload.ephemeral).toBe(true);
    expect(deliveryCalls[1].payload.user).toBe("U456");
  });

  it("does not include ephemeral fields when not set", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "C123",
      textSegments: ["Normal message."],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.ephemeral).toBeUndefined();
    expect(deliveryCalls[0].payload.user).toBeUndefined();
  });

  it("passes startFromSegment through deliverReplyViaCallback options", async () => {
    conversationMessages.push(
      { id: "msg-u", role: "user", content: "hi" },
      { id: "msg-a", role: "assistant", content: '"text"' },
    );
    renderedHistoryContent = {
      text: "Alpha.Beta.Gamma.",
      textSegments: ["Alpha.", "Beta.", "Gamma."],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0", "tool:0", "text:1", "tool:1", "text:2"],
      surfaces: [],
    };

    const delivered: number[] = [];
    await deliverReplyViaCallback(
      "conv-resume",
      "chat-resume",
      "http://gateway/deliver/telegram",
      "token",
      "assistant-3",
      {
        startFromSegment: 1,
        onSegmentDelivered: (count) => delivered.push(count),
      },
    );

    // Should skip 'Alpha.' and deliver 'Beta.' and 'Gamma.'
    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0].payload.text).toBe("Beta.");
    expect(deliveryCalls[1].payload.text).toBe("Gamma.");
    expect(delivered).toEqual([2, 3]);
  });
});

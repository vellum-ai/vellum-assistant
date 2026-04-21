import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { RuntimeAttachmentMetadata } from "../runtime/http-types.js";

type DeliveryCall = {
  callbackUrl: string;
  payload: Record<string, unknown>;
  bearerToken?: string;
};

const deliveryCalls: DeliveryCall[] = [];
type MockMessageRow = {
  id: string;
  role: string;
  content: string;
  metadata?: string | null;
};
const conversationMessages: MockMessageRow[] = [];
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
type UpdateMessageMetadataCall = {
  messageId: string;
  updates: Record<string, unknown>;
};
const updateMessageMetadataCalls: UpdateMessageMetadataCall[] = [];

/** Per-test override for the synthetic Slack `ts` returned by deliverChannelReply. */
let nextDeliveryTs: string | null = null;

let renderedHistoryContent: {
  text: string;
  textSegments: string[];
  toolCalls: unknown[];
  toolCallsBeforeText: boolean;
  contentOrder: string[];
  surfaces: unknown[];
  thinkingSegments: string[];
} = {
  text: "",
  textSegments: [],
  toolCalls: [],
  toolCallsBeforeText: false,
  contentOrder: [],
  surfaces: [],
  thinkingSegments: [],
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
    if (nextDeliveryTs !== null) {
      const ts = nextDeliveryTs;
      // Only the first segment of a multi-segment delivery should carry
      // back a meaningful ts for `channelTs` reconciliation. Tests that
      // need specific ts values per-segment can re-set this between calls.
      return { ok: true, ts };
    }
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
  getMessageById: (messageId: string) =>
    conversationMessages.find((m) => m.id === messageId) ?? null,
  updateMessageMetadata: (
    messageId: string,
    updates: Record<string, unknown>,
  ) => {
    updateMessageMetadataCalls.push({ messageId, updates });
    const row = conversationMessages.find((m) => m.id === messageId);
    if (!row) return;
    const existing =
      row.metadata && typeof row.metadata === "string"
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : {};
    row.metadata = JSON.stringify({ ...existing, ...updates });
  },
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
    updateMessageMetadataCalls.length = 0;
    nextDeliveryTs = null;
    renderedHistoryContent = {
      text: "",
      textSegments: [],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: [],
      surfaces: [],
      thinkingSegments: [],
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
      thinkingSegments: [],
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

  it("suppresses delivery when the only text segment is <no_response/>", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "chat-silent",
      textSegments: ["<no_response/>"],
      fallbackText: "Fallback text",
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(0);
  });

  it("suppresses attachment delivery when <no_response/> is present", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "chat-silent-att",
      textSegments: ["<no_response/>"],
      attachments: [
        {
          id: "att-no-resp",
          filename: "secret.txt",
          mimeType: "text/plain",
          sizeBytes: 10,
          kind: "uploaded",
        },
      ],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(0);
  });

  it("suppresses delivery for <no_response/> with surrounding whitespace", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "chat-silent-ws",
      textSegments: ["  <no_response/>  "],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(0);
  });

  it("suppresses delivery when <no_response/> is wrapped with model artifacts", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "chat-silent-artifact",
      textSegments: ["[04/21/26 21:53]: <no_response/>"],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(0);
  });

  it("suppresses delivery for <no_response /> with space before slash and surrounding artifacts", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "chat-silent-artifact-space",
      textSegments: ["[timestamp]: <no_response />"],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(0);
  });

  it("delivers other segments when <no_response/> is mixed with real text", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "chat-mixed",
      textSegments: ["<no_response/>", "Real response."],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("Real response.");
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
      thinkingSegments: [],
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

  // ── slackMeta.channelTs reconciliation (post-send) ─────────────────────
  // These tests close the gap where outbound assistant messages were
  // persisted with a partial slackMeta lacking `channelTs`. The renderer
  // (`readSlackMetadata`) rejects rows missing `channelTs`, so without
  // reconciliation every outbound assistant row falls through to the
  // legacy/flat fallback and is excluded from thread-tag rendering and the
  // active-thread focus block.
  describe("slackMeta.channelTs reconciliation", () => {
    /** Build the outer envelope mirroring `handleMessageComplete`'s write. */
    function partialSlackEnvelope(
      channelId: string,
      threadTs?: string,
    ): string {
      // Note: this matches the partial write — channelTs is intentionally
      // absent so `readSlackMetadata` returns null until reconciliation runs.
      const inner: Record<string, unknown> = {
        source: "slack",
        eventKind: "message",
        channelId,
        ...(threadTs ? { threadTs } : {}),
      };
      return JSON.stringify({
        userMessageChannel: "slack",
        assistantMessageChannel: "slack",
        slackMeta: JSON.stringify(inner),
      });
    }

    function pushPartialAssistantRow(
      conversationId: string,
      messageId: string,
      channelId: string,
      threadTs?: string,
    ): void {
      conversationMessages.push({
        id: messageId,
        role: "assistant",
        content: '[{"type":"text","text":"hello"}]',
        metadata: partialSlackEnvelope(channelId, threadTs),
      });
      // Set up renderer to produce one segment so onMessageTs fires once.
      renderedHistoryContent = {
        text: "hello",
        textSegments: ["hello"],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0"],
        surfaces: [],
        thinkingSegments: [],
      };
    }

    it("writes channelTs into slackMeta from the gateway-returned ts (top-level reply)", async () => {
      pushPartialAssistantRow("conv-recon-top", "msg-recon-top", "C123");
      nextDeliveryTs = "1700000123.000456";

      await deliverReplyViaCallback(
        "conv-recon-top",
        "C123",
        "http://gateway/deliver/slack",
        "token",
        "assistant-recon",
      );

      expect(updateMessageMetadataCalls.length).toBe(1);
      const call = updateMessageMetadataCalls[0];
      expect(call.messageId).toBe("msg-recon-top");
      const merged = call.updates.slackMeta as string;
      expect(typeof merged).toBe("string");
      const parsed = JSON.parse(merged) as Record<string, unknown>;
      expect(parsed.source).toBe("slack");
      expect(parsed.channelId).toBe("C123");
      expect(parsed.eventKind).toBe("message");
      expect(parsed.channelTs).toBe("1700000123.000456");
      expect(parsed.threadTs).toBeUndefined();
    });

    it("preserves an existing threadTs when reconciling channelTs (threaded reply)", async () => {
      pushPartialAssistantRow(
        "conv-recon-thread",
        "msg-recon-thread",
        "C456",
        "1234.5678",
      );
      nextDeliveryTs = "1700000200.000700";

      await deliverReplyViaCallback(
        "conv-recon-thread",
        "C456",
        "http://gateway/deliver/slack",
        "token",
        "assistant-recon-thread",
      );

      expect(updateMessageMetadataCalls.length).toBe(1);
      const merged = updateMessageMetadataCalls[0].updates.slackMeta as string;
      const parsed = JSON.parse(merged) as Record<string, unknown>;
      expect(parsed.threadTs).toBe("1234.5678");
      expect(parsed.channelTs).toBe("1700000200.000700");
    });

    it("does NOT call updateMessageMetadata when the assistant row has no slackMeta", async () => {
      // vellum/telegram/non-slack outbound: the row's metadata envelope has
      // no slackMeta sub-key. The reconciler must short-circuit silently.
      conversationMessages.push({
        id: "msg-vellum",
        role: "assistant",
        content: '[{"type":"text","text":"hi"}]',
        metadata: JSON.stringify({
          userMessageChannel: "vellum",
          assistantMessageChannel: "vellum",
        }),
      });
      renderedHistoryContent = {
        text: "hi",
        textSegments: ["hi"],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0"],
        surfaces: [],
        thinkingSegments: [],
      };
      nextDeliveryTs = "1700000300.000800";

      await deliverReplyViaCallback(
        "conv-vellum",
        "chat-vellum",
        "http://gateway/deliver/telegram",
        "token",
        "assistant-vellum",
      );

      expect(updateMessageMetadataCalls.length).toBe(0);
    });

    it("does NOT call updateMessageMetadata when slackMeta already has channelTs", async () => {
      // Idempotency: a re-delivery (e.g. from channel-retry-sweep) must not
      // overwrite a channelTs that is already in place.
      const existingMeta = JSON.stringify({
        source: "slack",
        eventKind: "message",
        channelId: "C789",
        channelTs: "1699999999.000111",
      });
      conversationMessages.push({
        id: "msg-already",
        role: "assistant",
        content: '[{"type":"text","text":"hi"}]',
        metadata: JSON.stringify({
          userMessageChannel: "slack",
          assistantMessageChannel: "slack",
          slackMeta: existingMeta,
        }),
      });
      renderedHistoryContent = {
        text: "hi",
        textSegments: ["hi"],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0"],
        surfaces: [],
        thinkingSegments: [],
      };
      nextDeliveryTs = "1700000400.000999";

      await deliverReplyViaCallback(
        "conv-already",
        "C789",
        "http://gateway/deliver/slack",
        "token",
        "assistant-already",
      );

      expect(updateMessageMetadataCalls.length).toBe(0);
    });

    it("only reconciles from the FIRST segment's ts when the reply is split", async () => {
      pushPartialAssistantRow("conv-multi", "msg-multi", "C999");
      // Two-segment delivery: only the first segment's ts is the canonical
      // channelTs for the persisted row. Subsequent segments correspond to
      // independent Slack messages.
      renderedHistoryContent = {
        text: "AlphaBeta",
        textSegments: ["Alpha", "Beta"],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0", "tool:0", "text:1"],
        surfaces: [],
        thinkingSegments: [],
      };
      nextDeliveryTs = "1700000500.000111";

      await deliverReplyViaCallback(
        "conv-multi",
        "C999",
        "http://gateway/deliver/slack",
        "token",
        "assistant-multi",
      );

      // Two delivery POSTs but only one metadata write — the first ts wins.
      expect(deliveryCalls.length).toBe(2);
      expect(updateMessageMetadataCalls.length).toBe(1);
      const merged = updateMessageMetadataCalls[0].updates.slackMeta as string;
      const parsed = JSON.parse(merged) as Record<string, unknown>;
      expect(parsed.channelTs).toBe("1700000500.000111");
    });

    it("composes with caller-supplied onMessageTs without losing either side-effect", async () => {
      pushPartialAssistantRow("conv-compose", "msg-compose", "C111");
      nextDeliveryTs = "1700000600.000222";
      const callerTsSeen: string[] = [];

      await deliverReplyViaCallback(
        "conv-compose",
        "C111",
        "http://gateway/deliver/slack",
        "token",
        "assistant-compose",
        {
          onMessageTs: (ts) => callerTsSeen.push(ts),
        },
      );

      // Caller's onMessageTs still fires for the delivered segment.
      expect(callerTsSeen).toEqual(["1700000600.000222"]);
      // And reconciliation still wrote channelTs.
      expect(updateMessageMetadataCalls.length).toBe(1);
      const merged = updateMessageMetadataCalls[0].updates.slackMeta as string;
      const parsed = JSON.parse(merged) as Record<string, unknown>;
      expect(parsed.channelTs).toBe("1700000600.000222");
    });

    it("after reconciliation, readSlackMetadata returns a valid envelope", async () => {
      // End-to-end: this is the assertion that the ORIGINAL gap test
      // (`outbound-slack-persistence.test.ts:209`) was inverted on. Once
      // reconciliation runs, readSlackMetadata must accept the merged value.
      pushPartialAssistantRow("conv-readback", "msg-readback", "C222");
      nextDeliveryTs = "1700000700.000333";

      await deliverReplyViaCallback(
        "conv-readback",
        "C222",
        "http://gateway/deliver/slack",
        "token",
        "assistant-readback",
      );

      expect(updateMessageMetadataCalls.length).toBe(1);
      const merged = updateMessageMetadataCalls[0].updates.slackMeta as string;
      // Imported here so the production read path (the same one the renderer
      // uses) is what actually validates the merged envelope.
      const { readSlackMetadata } = await import(
        "../messaging/providers/slack/message-metadata.js"
      );
      const parsed = readSlackMetadata(merged);
      expect(parsed).not.toBeNull();
      expect(parsed?.channelTs).toBe("1700000700.000333");
      expect(parsed?.channelId).toBe("C222");
      expect(parsed?.source).toBe("slack");
      expect(parsed?.eventKind).toBe("message");
    });
  });
});

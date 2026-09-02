import { beforeEach, describe, expect, it, mock } from "bun:test";

import { REACTION_MESSAGE_KIND } from "../persistence/conversation-types.js";
import { resolveMessageContentBlocks } from "../persistence/message-content-file.js";
import type { RuntimeAttachmentMetadata } from "../runtime/http-types.js";

type DeliveryCall = {
  callbackUrl: string;
  payload: Record<string, unknown>;
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

/**
 * Number of leading `updateMessageMetadata` calls that throw a transient
 * SQLite error before the mock starts writing. Lets a test assert that a lost
 * reconciliation write is recovered rather than forfeited.
 */
let metadataWriteFailuresRemaining = 0;

/** Per-test override for the synthetic Slack `ts` returned by deliverChannelReply. */
let nextDeliveryTs: string | null = null;
/** Per-segment ts values, consumed in order before `nextDeliveryTs`. */
const deliveryTsQueue: string[] = [];

type RenderedHistoryStub = {
  text: string;
  textSegments: string[];
  toolCalls: unknown[];
  toolCallsBeforeText: boolean;
  contentOrder: string[];
  surfaces: unknown[];
  thinkingSegments: string[];
};

let renderedHistoryContent: RenderedHistoryStub = {
  text: "",
  textSegments: [],
  toolCalls: [],
  toolCallsBeforeText: false,
  contentOrder: [],
  surfaces: [],
  thinkingSegments: [],
};
const renderedHistoryContentQueue: RenderedHistoryStub[] = [];

let deliveryFailAtIndex = -1;

const editCalls: { callbackUrl: string; target: Record<string, unknown> }[] =
  [];

mock.module("../messaging/providers/index.js", () => ({
  editChannelMessage: async (
    callbackUrl: string,
    target: Record<string, unknown>,
  ) => {
    editCalls.push({ callbackUrl, target });
    return { ok: true };
  },
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    callbackUrl: string,
    payload: Record<string, unknown>,
  ) => {
    if (
      deliveryFailAtIndex >= 0 &&
      deliveryCalls.length === deliveryFailAtIndex
    ) {
      throw new Error("Simulated delivery failure (502)");
    }
    deliveryCalls.push({ callbackUrl, payload });
    const queued = deliveryTsQueue.shift();
    if (queued !== undefined) {
      return { ok: true, ts: queued };
    }
    if (nextDeliveryTs !== null) {
      return { ok: true, ts: nextDeliveryTs };
    }
    return { ok: true };
  },
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
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
  getMessages: () =>
    conversationMessages.map((m) => ({
      ...m,
      content: resolveMessageContentBlocks(m.content),
    })),
  getMessagesAfter: (
    _conversationId: string,
    afterMessageId: string | null,
  ) => {
    const resolved = conversationMessages.map((m) => ({
      ...m,
      content: resolveMessageContentBlocks(m.content),
    }));
    if (!afterMessageId) {
      return resolved;
    }
    const index = resolved.findIndex(
      (message) => message.id === afterMessageId,
    );
    return index === -1 ? [] : resolved.slice(index + 1);
  },
  getMessageById: (messageId: string) =>
    conversationMessages.find((m) => m.id === messageId) ?? null,
  // Stands in for the schema-validated parse. The delivery reader pairs it
  // with the real `isReactionMessageMetadata`, so the marker the assertions
  // turn on is still the production predicate reading a production-shaped row.
  parseMessageMetadata: (metadataJson: string | null) => {
    if (!metadataJson) {
      return undefined;
    }
    try {
      return JSON.parse(metadataJson) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  },
  updateMessageMetadata: (
    messageId: string,
    updates: Record<string, unknown>,
  ) => {
    if (metadataWriteFailuresRemaining > 0) {
      metadataWriteFailuresRemaining -= 1;
      // Shaped like bun:sqlite's error so `withSqliteRetry` classifies it as
      // transient contention rather than a fatal write.
      throw Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
      });
    }
    updateMessageMetadataCalls.push({ messageId, updates });
    const row = conversationMessages.find((m) => m.id === messageId);
    if (!row) {
      return;
    }
    const existing =
      row.metadata && typeof row.metadata === "string"
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : {};
    row.metadata = JSON.stringify({ ...existing, ...updates });
  },
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

// The reconciler writes the outbound-posts index through delivery-crud;
// stub it so this suite stays DB-free while capturing the writes.
const recordedOutboundPosts: Array<Record<string, string>> = [];
/** Runs after each index write: a seam to observe or interleave a deletion before the envelope stamp. */
let onRecordOutboundPost: ((post: Record<string, string>) => void) | null =
  null;
mock.module("../persistence/delivery-crud.js", () => ({
  recordOutboundPost: (post: Record<string, string>) => {
    recordedOutboundPosts.push(post);
    onRecordOutboundPost?.(post);
  },
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: (messageId: string) =>
    attachmentsByMessageId.get(messageId) ?? [],
  getFilePathForAttachment: () => null,
}));

/**
 * Renders keyed by a row's raw string content, consulted ahead of the queue.
 * The queue and the shared default are argument-blind, so a suite that mixes
 * rows in one scan cannot otherwise tell them apart, and a row the code under
 * test is supposed to skip would still render as its neighbour.
 */
const renderedHistoryContentByContent = new Map<string, RenderedHistoryStub>();

mock.module("../daemon/handlers/shared.js", () => ({
  renderHistoryContent: (content: unknown) => {
    if (typeof content === "string") {
      const keyed = renderedHistoryContentByContent.get(content);
      if (keyed) {
        return keyed;
      }
    }
    return renderedHistoryContentQueue.shift() ?? renderedHistoryContent;
  },
}));

const {
  deliverRenderedReplyViaCallback,
  deliverReplyViaCallback,
  findAssistantReplyMessageIdForTurn,
} = await import("../runtime/channel-reply-delivery.js");

describe("channel-reply-delivery", () => {
  beforeEach(() => {
    deliveryCalls.length = 0;
    deliveryFailAtIndex = -1;
    conversationMessages.length = 0;
    attachmentsByMessageId.clear();
    updateMessageMetadataCalls.length = 0;
    metadataWriteFailuresRemaining = 0;
    nextDeliveryTs = null;
    deliveryTsQueue.length = 0;
    recordedOutboundPosts.length = 0;
    onRecordOutboundPost = null;
    renderedHistoryContentQueue.length = 0;
    renderedHistoryContentByContent.clear();
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

  it("finds the assistant reply in the linked user turn", () => {
    conversationMessages.push(
      {
        id: "user-target",
        role: "user",
        content: "target",
      },
      {
        id: "assistant-tool-call",
        role: "assistant",
        content: "tool call",
      },
      {
        id: "assistant-target",
        role: "assistant",
        content: "final reply",
      },
      {
        id: "user-newer",
        role: "user",
        content: "newer",
      },
      {
        id: "assistant-newer",
        role: "assistant",
        content: "newer reply",
      },
    );
    renderedHistoryContentQueue.push({
      text: "Final reply.",
      textSegments: ["Final reply."],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    });

    expect(findAssistantReplyMessageIdForTurn("conv-1", "user-target")).toBe(
      "assistant-target",
    );
  });

  describe("reaction rows are never a turn's reply", () => {
    /** The body `persistReactionRecords` stores; never channel-visible text. */
    const SENTINEL = "[reaction]";

    const stubFor = (text: string): RenderedHistoryStub => ({
      text,
      textSegments: [text],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    });

    /**
     * The row `persistReactionRecords` writes at the turn boundary, rendering
     * as the stored sentinel exactly as the real renderer would. Read
     * literally that text is what reaches the channel, so these tests fail on
     * a guard that only stops short of the delivery call.
     */
    const reactionRow = (id: string): MockMessageRow => {
      renderedHistoryContentByContent.set(SENTINEL, stubFor(SENTINEL));
      return {
        id,
        role: "assistant",
        content: SENTINEL,
        metadata: JSON.stringify({
          messageKind: REACTION_MESSAGE_KIND,
          provenanceSourceChannel: "slack",
        }),
      };
    };

    /** How the turn's one non-reaction assistant row renders. */
    const renderAs = (text: string): void => {
      renderedHistoryContent = stubFor(text);
    };

    it("resolves a reaction-only turn to its silence marker, not the sentinel row", () => {
      conversationMessages.push(
        { id: "user-target", role: "user", content: "target" },
        {
          id: "assistant-silence",
          role: "assistant",
          content: "<no_response/>",
        },
        // Drained after the turn's own rows, so it is the newest row and the
        // one a newest-first scan reaches first.
        reactionRow("assistant-reaction"),
      );
      renderAs("<no_response/>");

      expect(findAssistantReplyMessageIdForTurn("conv-1", "user-target")).toBe(
        "assistant-silence",
      );
    });

    it("posts nothing at all for a reaction-only turn", async () => {
      conversationMessages.push(
        { id: "user-target", role: "user", content: "target" },
        {
          id: "assistant-silence",
          role: "assistant",
          content: "<no_response/>",
        },
        reactionRow("assistant-reaction"),
      );
      renderAs("<no_response/>");

      await deliverReplyViaCallback(
        "conv-1",
        "chat-1",
        "http://gateway/deliver/slack",
        "assistant-1",
        { messageId: "assistant-silence", sinceMessageId: "user-target" },
      );

      expect(deliveryCalls).toEqual([]);
    });

    it("delivers the turn's real reply when a reaction row is newer than it", async () => {
      conversationMessages.push(
        { id: "user-target", role: "user", content: "target" },
        { id: "assistant-real", role: "assistant", content: "real reply" },
        reactionRow("assistant-reaction"),
      );
      renderAs("Done.");

      await deliverReplyViaCallback(
        "conv-1",
        "chat-1",
        "http://gateway/deliver/slack",
        "assistant-1",
        { sinceMessageId: "user-target" },
      );

      expect(deliveryCalls).toHaveLength(1);
      expect(deliveryCalls[0].payload.text).toBe("Done.");
    });

    it("falls through to the real reply when the stored reply id names a reaction row", async () => {
      // The retry sweep persists whatever the turn scan returned, so a reply
      // id latched before this guard existed still points at a reaction row.
      conversationMessages.push(
        { id: "user-target", role: "user", content: "target" },
        { id: "assistant-real", role: "assistant", content: "real reply" },
        reactionRow("assistant-reaction"),
      );
      renderAs("Done.");

      await deliverReplyViaCallback(
        "conv-1",
        "chat-1",
        "http://gateway/deliver/slack",
        "assistant-1",
        { messageId: "assistant-reaction", sinceMessageId: "user-target" },
      );

      expect(deliveryCalls).toHaveLength(1);
      expect(deliveryCalls[0].payload.text).toBe("Done.");
    });
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
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0]).toEqual({
      callbackUrl: "http://gateway/deliver/telegram",
      payload: {
        chatId: "chat-1",
        text: "Before tool.",
        renderRichly: true,
        attachments: undefined,
        assistantId: "assistant-1",
      },
    });
    expect(deliveryCalls[1]).toEqual({
      callbackUrl: "http://gateway/deliver/telegram",
      payload: {
        chatId: "chat-1",
        text: "After tool.",
        renderRichly: true,
        attachments,
        assistantId: "assistant-1",
      },
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
      "assistant-2",
    );

    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0].payload).toEqual({
      chatId: "chat-3",
      text: "Before tool.",
      renderRichly: true,
      attachments: undefined,
      assistantId: "assistant-2",
    });
    expect(deliveryCalls[1].payload).toEqual({
      chatId: "chat-3",
      text: "After tool.",
      renderRichly: true,
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

  it("falls back to current-turn assistant text when the newest assistant row is tool-only", async () => {
    conversationMessages.push(
      { id: "msg-old-user", role: "user", content: "old prompt" },
      {
        id: "msg-old-assistant",
        role: "assistant",
        content: '[{"type":"text","text":"old answer"}]',
      },
      { id: "msg-current-user", role: "user", content: "current prompt" },
      {
        id: "msg-current-text",
        role: "assistant",
        content: '[{"type":"text","text":"current answer"}]',
      },
      {
        id: "msg-current-tool-result",
        role: "user",
        content: '[{"type":"tool_result","tool_use_id":"tu-1","content":"ok"}]',
      },
      {
        id: "msg-current-tool-only",
        role: "assistant",
        content:
          '[{"type":"tool_use","id":"tu-2","name":"remember","input":{}}]',
      },
    );
    renderedHistoryContentQueue.push(
      {
        text: "",
        textSegments: [],
        toolCalls: [{ name: "remember", input: {} }],
        toolCallsBeforeText: true,
        contentOrder: ["tool:0"],
        surfaces: [],
        thinkingSegments: [],
      },
      {
        text: "Current answer.",
        textSegments: ["Current answer."],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0"],
        surfaces: [],
        thinkingSegments: [],
      },
      {
        text: "Current answer.",
        textSegments: ["Current answer."],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0"],
        surfaces: [],
        thinkingSegments: [],
      },
    );

    await deliverReplyViaCallback(
      "conv-1",
      "chat-current",
      "http://gateway/deliver/slack",
      "assistant-current",
      { sinceMessageId: "msg-current-user" },
    );

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("Current answer.");
  });

  it("does not cross the current user boundary when no current-turn assistant text exists", async () => {
    conversationMessages.push(
      { id: "msg-old-user", role: "user", content: "old prompt" },
      {
        id: "msg-old-assistant",
        role: "assistant",
        content: '[{"type":"text","text":"old answer"}]',
      },
      { id: "msg-current-user", role: "user", content: "current prompt" },
      {
        id: "msg-current-tool-only",
        role: "assistant",
        content:
          '[{"type":"tool_use","id":"tu-1","name":"remember","input":{}}]',
      },
    );
    renderedHistoryContentQueue.push({
      text: "",
      textSegments: [],
      toolCalls: [{ name: "remember", input: {} }],
      toolCallsBeforeText: true,
      contentOrder: ["tool:0"],
      surfaces: [],
      thinkingSegments: [],
    });

    await deliverReplyViaCallback(
      "conv-1",
      "chat-current",
      "http://gateway/deliver/slack",
      "assistant-current",
      { sinceMessageId: "msg-current-user" },
    );

    expect(deliveryCalls).toHaveLength(0);
  });

  // Silence means the turn produced no real reply text anywhere — not "the
  // last row was a sentinel". A trailing bare <no_response/> row must not
  // swallow the real reply written earlier in the same turn.
  it("delivers the earlier real reply when the turn ends with a bare no_response row", async () => {
    conversationMessages.push(
      { id: "msg-current-user", role: "user", content: "current prompt" },
      {
        id: "msg-current-text",
        role: "assistant",
        content: '[{"type":"text","text":"current answer"}]',
      },
      {
        id: "msg-current-silent",
        role: "assistant",
        content: '[{"type":"text","text":"<no_response/>"}]',
      },
    );
    const silentStub = {
      text: "<no_response/>",
      textSegments: ["<no_response/>"],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    };
    const answerStub = {
      text: "current answer",
      textSegments: ["current answer"],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    };
    // Turn scan reads the silent row then the text row; delivery re-reads
    // the chosen text row.
    renderedHistoryContentQueue.push(silentStub, answerStub, answerStub);

    await deliverReplyViaCallback(
      "conv-1",
      "chat-current",
      "http://gateway/deliver/slack",
      "assistant-current",
      { sinceMessageId: "msg-current-user" },
    );

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("current answer");
  });

  it("stays silent when a no_response turn has no real reply text anywhere", async () => {
    conversationMessages.push(
      { id: "msg-current-user", role: "user", content: "current prompt" },
      {
        id: "msg-current-silent",
        role: "assistant",
        content: '[{"type":"text","text":"<no_response/>"}]',
      },
    );
    const silentStub = {
      text: "<no_response/>",
      textSegments: ["<no_response/>"],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    };
    // Turn scan reads the silent row; delivery re-reads it as the terminal
    // deliberate-silence target.
    renderedHistoryContentQueue.push(silentStub, silentStub);

    await deliverReplyViaCallback(
      "conv-1",
      "chat-current",
      "http://gateway/deliver/slack",
      "assistant-current",
      { sinceMessageId: "msg-current-user" },
    );

    expect(deliveryCalls).toHaveLength(0);
  });

  it("falls through a messageId-targeted bare no_response row to the turn's real reply", async () => {
    conversationMessages.push(
      { id: "msg-current-user", role: "user", content: "current prompt" },
      {
        id: "msg-current-text",
        role: "assistant",
        content: '[{"type":"text","text":"current answer"}]',
      },
      {
        id: "msg-current-silent",
        role: "assistant",
        content: '[{"type":"text","text":"<no_response/>"}]',
      },
    );
    const silentStub = {
      text: "<no_response/>",
      textSegments: ["<no_response/>"],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    };
    const answerStub = {
      text: "current answer",
      textSegments: ["current answer"],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    };
    // messageId branch reads the targeted silent row, the turn scan reads
    // the silent row then the text row, and delivery re-reads the text row.
    renderedHistoryContentQueue.push(
      silentStub,
      silentStub,
      answerStub,
      answerStub,
    );

    await deliverReplyViaCallback(
      "conv-1",
      "chat-current",
      "http://gateway/deliver/slack",
      "assistant-current",
      { messageId: "msg-current-silent", sinceMessageId: "msg-current-user" },
    );

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("current answer");
  });

  // A bare-sentinel row never delivers its attachments (marker rows suppress
  // attachment delivery), so attachments alone must not make the row count
  // as the turn's real reply and stop the fall-through.
  it("falls through a bare no_response row with attachments to the turn's real reply", async () => {
    conversationMessages.push(
      { id: "msg-current-user", role: "user", content: "current prompt" },
      {
        id: "msg-current-text",
        role: "assistant",
        content: '[{"type":"text","text":"current answer"}]',
      },
      {
        id: "msg-current-silent",
        role: "assistant",
        content: '[{"type":"text","text":"<no_response/>"}]',
      },
    );
    attachmentsByMessageId.set("msg-current-silent", [
      {
        id: "att-silent",
        originalFilename: "chart.png",
        mimeType: "image/png",
        sizeBytes: 10,
        kind: "generated",
      },
    ]);
    const silentStub = {
      text: "<no_response/>",
      textSegments: ["<no_response/>"],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    };
    const answerStub = {
      text: "current answer",
      textSegments: ["current answer"],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    };
    // messageId branch reads the targeted silent row, the turn scan reads
    // the silent row then the text row, and delivery re-reads the text row.
    renderedHistoryContentQueue.push(
      silentStub,
      silentStub,
      answerStub,
      answerStub,
    );

    await deliverReplyViaCallback(
      "conv-1",
      "chat-current",
      "http://gateway/deliver/slack",
      "assistant-current",
      { messageId: "msg-current-silent", sinceMessageId: "msg-current-user" },
    );

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("current answer");
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

  it("updates a live-delivered message when skipped text has attachments", async () => {
    const seenTs: string[] = [];
    const attachments: RuntimeAttachmentMetadata[] = [
      {
        id: "attachment-1",
        filename: "report.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        kind: "file",
      },
    ];

    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "chat-live",
      textSegments: ["Already sent live."],
      attachments,
      startFromSegment: 1,
      messageTs: "1700000000.000055",
      onMessageTs: (ts) => {
        seenTs.push(ts);
      },
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload).toEqual({
      chatId: "chat-live",
      attachments,
      assistantId: undefined,
      audience: undefined,
    });
    // Attachments post as new messages, so nothing is edited on this path.
    expect(editCalls).toHaveLength(0);
    expect(seenTs).toEqual(["1700000000.000055"]);
  });

  it("carries the audience through to every delivery call", async () => {
    const audience = { kind: "oneReader", userId: "U456" } as const;
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "C123",
      textSegments: ["Part 1.", "Part 2."],
      interSegmentDelayMs: 0,
      audience,
    });

    expect(deliveryCalls).toHaveLength(2);
    // Every segment, not just the first: a reply restricted to one reader
    // that loses the restriction partway becomes a public one.
    for (const call of deliveryCalls) {
      expect(call.payload.audience).toEqual(audience);
    }
  });

  it("leaves the audience unset when the reply is for the room", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "C123",
      textSegments: ["Normal message."],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.audience).toBeUndefined();
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

  it("strips a prefixed inline <no_response/> and delivers the rest of the segment", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-inline-prefix",
      textSegments: ["<no_response/>\n\nReal reply."],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("Real reply.");
  });

  it("strips a trailing inline <no_response/> and delivers the rest of the segment", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-inline-trailing",
      textSegments: ["Real reply.\n\n<no_response/>"],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("Real reply.");
  });

  it("never leaks the sentinel into delivered text, including the fallback path", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/telegram",
      chatId: "chat-fallback-strip",
      textSegments: [],
      fallbackText: "Fallback reply. <no_response/>",
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe("Fallback reply.");
    for (const call of deliveryCalls) {
      expect(String(call.payload.text)).not.toContain("<no_response");
    }
  });

  it("suppresses delivery for a case-insensitive bare sentinel", async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: "http://gateway/deliver/slack",
      chatId: "chat-silent-case",
      textSegments: ["<NO_RESPONSE/>"],
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(0);
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

  it("targets an explicit assistant message instead of the latest reply", async () => {
    conversationMessages.push(
      { id: "msg-u", role: "user", content: "hi" },
      { id: "msg-old", role: "assistant", content: '"old reply"' },
      { id: "msg-new", role: "assistant", content: '"new reply"' },
    );
    attachmentsByMessageId.set("msg-old", [
      {
        id: "att-old",
        originalFilename: "old.txt",
        mimeType: "text/plain",
        sizeBytes: 11,
        kind: "uploaded",
      },
    ]);
    attachmentsByMessageId.set("msg-new", [
      {
        id: "att-new",
        originalFilename: "new.txt",
        mimeType: "text/plain",
        sizeBytes: 22,
        kind: "uploaded",
      },
    ]);
    renderedHistoryContent = {
      text: "Reply.",
      textSegments: ["Reply."],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ["text:0"],
      surfaces: [],
      thinkingSegments: [],
    };

    await deliverReplyViaCallback(
      "conv-target",
      "chat-target",
      "http://gateway/deliver/telegram",
      "assistant-3",
      { messageId: "msg-old" },
    );

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.attachments).toEqual([
      {
        id: "att-old",
        filename: "old.txt",
        mimeType: "text/plain",
        sizeBytes: 11,
        kind: "uploaded",
      },
    ]);
  });

  it("rejects an explicit target that is not an assistant message", async () => {
    conversationMessages.push({ id: "msg-u", role: "user", content: "hi" });

    await expect(
      deliverReplyViaCallback(
        "conv-target",
        "chat-target",
        "http://gateway/deliver/telegram",
        "assistant-3",
        { messageId: "msg-u" },
      ),
    ).rejects.toThrow("Target assistant reply message not found");
  });

  // ── slackMeta.channelTs reconciliation (post-send) ─────────────────────
  // These tests close the gap where outbound assistant messages were
  // persisted with a partial slackMeta lacking `channelTs`. The renderer
  // (`readSlackMetadata`) rejects rows missing `channelTs`, so without
  // reconciliation every outbound assistant row falls through to the
  // legacy/flat fallback and is excluded from thread-tag rendering and the
  // active-thread focus block.
  describe("sent-message-id reconciliation", () => {
    /**
     * Build the outer envelope mirroring `buildAssistantChannelMetadata`'s
     * write for a Slack reply: the neutral envelope, Slack's own fields on
     * its passthrough, and no `messageId` yet, since the row is written
     * before the post.
     */
    function partialEnvelope(channelId: string, threadId?: string): string {
      return JSON.stringify({
        userMessageChannel: "slack",
        assistantMessageChannel: "slack",
        providerMeta: JSON.stringify({
          source: "slack",
          conversationExternalId: channelId,
          eventKind: "message",
          ...(threadId ? { threadId } : {}),
          timestampTimezone: "America/New_York",
        }),
      });
    }

    function pushPartialAssistantRow(
      conversationId: string,
      messageId: string,
      channelId: string,
      threadId?: string,
    ): void {
      conversationMessages.push({
        id: messageId,
        role: "assistant",
        content: '[{"type":"text","text":"hello"}]',
        metadata: partialEnvelope(channelId, threadId),
      });
      // One segment, so onMessageTs fires once.
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

    function twoSegments(): void {
      renderedHistoryContent = {
        text: "AlphaBeta",
        textSegments: ["Alpha", "Beta"],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0", "tool:0", "text:1"],
        surfaces: [],
        thinkingSegments: [],
      };
    }

    function envelopeOf(messageId: string): Record<string, unknown> {
      const row = conversationMessages.find((m) => m.id === messageId);
      const outer = JSON.parse(row?.metadata ?? "{}") as Record<string, string>;
      return JSON.parse(outer.providerMeta) as Record<string, unknown>;
    }

    it("writes the gateway-returned ts as the row's messageId (top-level reply)", async () => {
      pushPartialAssistantRow("conv-recon-top", "msg-recon-top", "C123");
      nextDeliveryTs = "1700000123.000456";

      await deliverReplyViaCallback(
        "conv-recon-top",
        "C123",
        "http://gateway/deliver/slack",
        "assistant-recon",
      );

      expect(updateMessageMetadataCalls.length).toBe(1);
      expect(updateMessageMetadataCalls[0].messageId).toBe("msg-recon-top");
      const envelope = envelopeOf("msg-recon-top");
      expect(envelope.source).toBe("slack");
      expect(envelope.conversationExternalId).toBe("C123");
      expect(envelope.eventKind).toBe("message");
      expect(envelope.messageId).toBe("1700000123.000456");
      expect(envelope.threadId).toBeUndefined();
      // Slack's own field survived the stamp.
      expect(envelope.timestampTimezone).toBe("America/New_York");
      expect(recordedOutboundPosts).toHaveLength(1);
      expect(recordedOutboundPosts[0]).toMatchObject({
        sourceChannel: "slack",
        externalChatId: "C123",
        providerMessageId: "1700000123.000456",
        messageId: "msg-recon-top",
      });
    });

    it("preserves an existing threadId when stamping the id (threaded reply)", async () => {
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
        "assistant-recon-thread",
      );

      const envelope = envelopeOf("msg-recon-thread");
      expect(envelope.threadId).toBe("1234.5678");
      expect(envelope.messageId).toBe("1700000200.000700");
    });

    it("does NOT call updateMessageMetadata when the assistant row has no envelope", async () => {
      // vellum outbound: the row's metadata carries no provider envelope.
      // The reconciler must short-circuit silently.
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
        "assistant-vellum",
      );

      expect(updateMessageMetadataCalls.length).toBe(0);
      expect(recordedOutboundPosts.length).toBe(0);
    });

    it("does NOT write again when the row already names the ts", async () => {
      // Idempotency: a redelivery of the same message must not write the
      // row or the index again.
      conversationMessages.push({
        id: "msg-already",
        role: "assistant",
        content: '[{"type":"text","text":"hi"}]',
        metadata: JSON.stringify({
          userMessageChannel: "slack",
          assistantMessageChannel: "slack",
          providerMeta: JSON.stringify({
            source: "slack",
            conversationExternalId: "C789",
            eventKind: "message",
            messageId: "1699999999.000111",
          }),
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
      nextDeliveryTs = "1699999999.000111";

      await deliverReplyViaCallback(
        "conv-already",
        "C789",
        "http://gateway/deliver/slack",
        "assistant-already",
      );

      expect(updateMessageMetadataCalls.length).toBe(0);
      expect(recordedOutboundPosts.length).toBe(0);
    });

    it("stamps a reply reserved with Slack's pre-send envelope and converges it onto the neutral one", async () => {
      // Transitional: such a row is pending for the retry sweep only when a
      // daemon that reserved Slack replies under `slackMeta` left it there.
      conversationMessages.push({
        id: "msg-presend-slack",
        role: "assistant",
        content: '[{"type":"text","text":"hello"}]',
        metadata: JSON.stringify({
          userMessageChannel: "slack",
          assistantMessageChannel: "slack",
          slackMeta: JSON.stringify({
            source: "slack",
            eventKind: "message",
            channelId: "C321",
            threadTs: "1700000000.000001",
            timestampTimezone: "America/New_York",
            timestampTimezoneLabel: "EST",
          }),
        }),
      });
      renderedHistoryContent = {
        text: "hello",
        textSegments: ["hello"],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0"],
        surfaces: [],
        thinkingSegments: [],
      };
      nextDeliveryTs = "1700000321.000111";

      await deliverReplyViaCallback(
        "conv-presend",
        "C321",
        "http://gateway/deliver/slack",
        "assistant-presend",
      );

      expect(recordedOutboundPosts).toHaveLength(1);
      expect(recordedOutboundPosts[0]).toMatchObject({
        sourceChannel: "slack",
        externalChatId: "C321",
        providerMessageId: "1700000321.000111",
        messageId: "msg-presend-slack",
      });
      const row = conversationMessages.find(
        (m) => m.id === "msg-presend-slack",
      );
      const outer = JSON.parse(row?.metadata ?? "{}") as Record<
        string,
        unknown
      >;
      // One envelope per row: the pre-send Slack one is gone, the turn's
      // other keys survive.
      expect(outer.slackMeta).toBeUndefined();
      expect(outer.userMessageChannel).toBe("slack");
      expect(envelopeOf("msg-presend-slack")).toEqual({
        source: "slack",
        conversationExternalId: "C321",
        eventKind: "message",
        threadId: "1700000000.000001",
        messageId: "1700000321.000111",
        timestampTimezone: "America/New_York",
        timestampTimezoneLabel: "EST",
      });
      const { readSlackMetadataFromMessageMetadata } =
        await import("../messaging/providers/slack/message-metadata.js");
      expect(readSlackMetadataFromMessageMetadata(row?.metadata)).toMatchObject(
        {
          channelTs: "1700000321.000111",
          threadTs: "1700000000.000001",
          timestampTimezoneLabel: "EST",
        },
      );
    });

    it("leaves a Slack reply that already names its post under slackMeta alone", async () => {
      conversationMessages.push({
        id: "msg-slack-complete",
        role: "assistant",
        content: '[{"type":"text","text":"hello"}]',
        metadata: JSON.stringify({
          slackMeta: JSON.stringify({
            source: "slack",
            eventKind: "message",
            channelId: "C321",
            channelTs: "1700000100.000001",
          }),
        }),
      });
      renderedHistoryContent = {
        text: "hello",
        textSegments: ["hello"],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0"],
        surfaces: [],
        thinkingSegments: [],
      };
      nextDeliveryTs = "1700000321.000222";

      await deliverReplyViaCallback(
        "conv-complete",
        "C321",
        "http://gateway/deliver/slack",
        "assistant-complete",
      );

      expect(updateMessageMetadataCalls.length).toBe(0);
      expect(recordedOutboundPosts.length).toBe(0);
    });

    it("records every segment of a split reply: the first as messageId, the rest as additional posts, all in the index", async () => {
      pushPartialAssistantRow("conv-multi", "msg-multi", "C999");
      twoSegments();
      deliveryTsQueue.push("1700000500.000111", "1700000500.000222");

      await deliverReplyViaCallback(
        "conv-multi",
        "C999",
        "http://gateway/deliver/slack",
        "assistant-multi",
      );

      expect(deliveryCalls.length).toBe(2);
      expect(updateMessageMetadataCalls.length).toBe(2);
      const envelope = envelopeOf("msg-multi");
      expect(envelope.messageId).toBe("1700000500.000111");
      expect(envelope.additionalMessageIds).toEqual(["1700000500.000222"]);
      expect(
        recordedOutboundPosts.map((post) => post.providerMessageId),
      ).toEqual(["1700000500.000111", "1700000500.000222"]);
    });

    it("composes with caller-supplied onMessageTs without losing either side-effect", async () => {
      pushPartialAssistantRow("conv-compose", "msg-compose", "C111");
      nextDeliveryTs = "1700000600.000222";
      const callerTsSeen: string[] = [];

      await deliverReplyViaCallback(
        "conv-compose",
        "C111",
        "http://gateway/deliver/slack",
        "assistant-compose",
        {
          onMessageTs: (ts) => {
            callerTsSeen.push(ts);
          },
        },
      );

      expect(callerTsSeen).toEqual(["1700000600.000222"]);
      expect(envelopeOf("msg-compose").messageId).toBe("1700000600.000222");
    });

    it("after reconciliation, the row has a Slack view the transcript renderer accepts", async () => {
      // The Slack renderers read the neutral envelope through its Slack
      // view; before the stamp there is none, after it there is.
      pushPartialAssistantRow("conv-readback", "msg-readback", "C222");
      const { readSlackMetadataFromMessageMetadata } =
        await import("../messaging/providers/slack/message-metadata.js");
      const before = conversationMessages.find((m) => m.id === "msg-readback");
      expect(readSlackMetadataFromMessageMetadata(before?.metadata)).toBeNull();
      nextDeliveryTs = "1700000700.000333";

      await deliverReplyViaCallback(
        "conv-readback",
        "C222",
        "http://gateway/deliver/slack",
        "assistant-readback",
      );

      const after = conversationMessages.find((m) => m.id === "msg-readback");
      const view = readSlackMetadataFromMessageMetadata(after?.metadata);
      expect(view).not.toBeNull();
      expect(view?.channelTs).toBe("1700000700.000333");
      expect(view?.channelId).toBe("C222");
      expect(view?.source).toBe("slack");
      expect(view?.eventKind).toBe("message");
      expect(view?.timestampTimezone).toBe("America/New_York");
    });

    it("retries a reconciliation write that hits transient SQLite contention", async () => {
      // The stamp is the only durable record of the post's id: no later sweep
      // heals a miss once the event is marked delivered, so a SQLITE_BUSY on
      // the first attempt must not lose it.
      pushPartialAssistantRow("conv-busy", "msg-busy", "C333");
      nextDeliveryTs = "1700000800.000444";
      metadataWriteFailuresRemaining = 1;

      await deliverReplyViaCallback(
        "conv-busy",
        "C333",
        "http://gateway/deliver/slack",
        "assistant-busy",
      );

      expect(updateMessageMetadataCalls.length).toBe(1);
      expect(envelopeOf("msg-busy").messageId).toBe("1700000800.000444");
    });

    it("stamps from a later segment when the first segment's write is lost", async () => {
      // The row records the first id that reaches a DURABLE write, not the
      // first id observed: a first-invocation latch would forfeit the id
      // forever when that write fails, and the row would never gain an id
      // of its own.
      pushPartialAssistantRow("conv-lost", "msg-lost", "C444");
      twoSegments();
      deliveryTsQueue.push("1700000900.000555", "1700000900.000556");
      // Exhaust the initial attempt plus every `withSqliteRetry` retry, so the
      // first segment's stamp is genuinely swallowed.
      metadataWriteFailuresRemaining = 4;

      await deliverReplyViaCallback(
        "conv-lost",
        "C444",
        "http://gateway/deliver/slack",
        "assistant-lost",
      );

      expect(deliveryCalls.length).toBe(2);
      expect(updateMessageMetadataCalls.length).toBe(1);
      expect(envelopeOf("msg-lost").messageId).toBe("1700000900.000556");
      // Both posts still reached the index, which does not depend on the
      // envelope write.
      expect(
        recordedOutboundPosts.map((post) => post.providerMessageId),
      ).toEqual(["1700000900.000555", "1700000900.000556"]);
    });

    it("commits the reconciliation write before posting the next segment", async () => {
      // `onMessageTs` is awaited, so the row is durable at each segment
      // boundary. Otherwise a crash between two posts of a split reply loses
      // the stamp for a message the reader can already see.
      pushPartialAssistantRow("conv-order", "msg-order", "C555");
      twoSegments();
      deliveryTsQueue.push("1700001000.000666", "1700001000.000667");
      const seenAtSecondPost: unknown[] = [];
      onRecordOutboundPost = (post) => {
        if (post.providerMessageId === "1700001000.000667") {
          seenAtSecondPost.push(envelopeOf("msg-order").messageId);
        }
      };

      await deliverReplyViaCallback(
        "conv-order",
        "C555",
        "http://gateway/deliver/slack",
        "assistant-order",
      );

      expect(seenAtSecondPost).toEqual(["1700001000.000666"]);
    });

    it("keeps a deletion that lands between the index write and the envelope stamp", async () => {
      // Once the index names the post, a delete resolves to the row and
      // stamps the envelope that still lacks its id. The stamp that follows
      // must read that state, not the one it saw before the index write,
      // and keep the row fully deleted: its only post is gone.
      pushPartialAssistantRow("conv-window", "msg-window", "C666");
      nextDeliveryTs = "1700001100.000777";
      onRecordOutboundPost = () => {
        const row = conversationMessages.find((m) => m.id === "msg-window")!;
        const outer = JSON.parse(row.metadata!) as Record<string, string>;
        row.metadata = JSON.stringify({
          ...outer,
          providerMeta: JSON.stringify({
            ...(JSON.parse(outer.providerMeta) as Record<string, unknown>),
            deletedMessageIds: ["1700001100.000777"],
            deletedAt: 1700001101000,
          }),
        });
      };

      await deliverReplyViaCallback(
        "conv-window",
        "C666",
        "http://gateway/deliver/slack",
        "assistant-window",
      );

      const envelope = envelopeOf("msg-window");
      expect(envelope.messageId).toBe("1700001100.000777");
      expect(envelope.deletedMessageIds).toEqual(["1700001100.000777"]);
      expect(envelope.deletedAt).toBe(1700001101000);
    });

    it("clears the row-level marker when a later post arrives after every known post was deleted", async () => {
      // The first post was deleted before the second segment reconciled, so
      // the row read as fully deleted. The second post is on the channel,
      // so the row is not; the per-post record of the first deletion stays.
      conversationMessages.push({
        id: "msg-revive",
        role: "assistant",
        content: '[{"type":"text","text":"hello"}]',
        metadata: JSON.stringify({
          assistantMessageChannel: "slack",
          providerMeta: JSON.stringify({
            source: "slack",
            conversationExternalId: "C777",
            eventKind: "message",
            messageId: "1700001200.000100",
            deletedMessageIds: ["1700001200.000100"],
            deletedAt: 1700001201000,
          }),
        }),
      });
      renderedHistoryContent = {
        text: "second",
        textSegments: ["second"],
        toolCalls: [],
        toolCallsBeforeText: false,
        contentOrder: ["text:0"],
        surfaces: [],
        thinkingSegments: [],
      };
      nextDeliveryTs = "1700001200.000200";

      await deliverReplyViaCallback(
        "conv-revive",
        "C777",
        "http://gateway/deliver/slack",
        "assistant-revive",
      );

      const envelope = envelopeOf("msg-revive");
      expect(envelope.additionalMessageIds).toEqual(["1700001200.000200"]);
      expect(envelope.deletedMessageIds).toEqual(["1700001200.000100"]);
      expect(envelope.deletedAt).toBeUndefined();
    });
  });
});

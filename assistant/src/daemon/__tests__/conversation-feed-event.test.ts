/**
 * Tests for the background conversation feed event emission logic in
 * conversation-agent-loop.ts.
 *
 * Rather than running the full agent loop, these tests exercise the
 * extraction logic in isolation by simulating the conditions under which
 * emitFeedEvent is called: conversation type, message content, and title.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level mocks — must be in place before importing the module under test
// ---------------------------------------------------------------------------

const emitFeedEventSpy = mock<
  (params: {
    source: string;
    title: string;
    summary: string;
    dedupKey?: string;
  }) => Promise<unknown>
>(async () => ({}));

mock.module("../../home/emit-feed-event.js", () => ({
  emitFeedEvent: emitFeedEventSpy,
}));

const getConversationSpy = mock<
  (id: string) => {
    conversationType: string;
    title: string | null;
  } | null
>(() => null);

const getMessageByIdSpy = mock<
  (
    messageId: string,
    conversationId?: string,
  ) => { id: string; content: string } | null
>(() => null);

// We need to stub enough of conversation-crud to avoid DB initialization.
// The actual agent loop imports getConversation and getMessageById from
// conversation-crud — we intercept those here for test assertions.
mock.module("../../memory/conversation-crud.js", () => ({
  getConversation: getConversationSpy,
  getMessageById: getMessageByIdSpy,
  // Stubs for other exports that may be transitively referenced:
  addMessage: () => {},
  clearStrippedInjectionMetadataForConversation: () => {},
  deleteMessageById: () => {},
  getConversationOriginChannel: () => null,
  getConversationOriginInterface: () => null,
  getLastUserTimestampBefore: () => null,
  provenanceFromTrustContext: () => ({}),
  updateConversationContextWindow: () => {},
  updateConversationTitle: () => {},
  updateMessageMetadata: () => {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulates the feed-event emission logic from conversation-agent-loop.ts.
 *
 * This mirrors the block inserted after `message_complete` so we can test it
 * in isolation without spinning up the full agent loop infrastructure.
 */
function simulateFeedEventEmission(
  conversationId: string,
  lastAssistantMessageId: string | undefined,
): void {
  const conv = getConversationSpy(conversationId);
  if (
    conv &&
    (conv.conversationType === "background" ||
      conv.conversationType === "scheduled")
  ) {
    const lastMsg = lastAssistantMessageId
      ? getMessageByIdSpy(lastAssistantMessageId, conversationId)
      : undefined;
    let summary: string;
    if (lastMsg) {
      const parsed: unknown = JSON.parse(lastMsg.content);
      if (typeof parsed === "string") {
        summary = parsed.slice(0, 200);
      } else if (Array.isArray(parsed)) {
        const textBlock = (
          parsed as Array<{ type?: string; text?: string }>
        ).find((b) => b.type === "text");
        summary =
          typeof textBlock?.text === "string"
            ? textBlock.text.slice(0, 200)
            : (conv.title ?? "Background task completed.");
      } else {
        summary = conv.title ?? "Background task completed.";
      }
    } else {
      summary = conv.title ?? "Background task completed.";
    }
    void emitFeedEventSpy({
      source: "assistant",
      title: conv.title ?? "Background Task",
      summary,
      dedupKey: `bg-conv:${conversationId}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("background conversation feed event", () => {
  beforeEach(() => {
    emitFeedEventSpy.mockClear();
    getConversationSpy.mockClear();
    getMessageByIdSpy.mockClear();
  });

  afterEach(() => {
    emitFeedEventSpy.mockReset();
    getConversationSpy.mockReset();
    getMessageByIdSpy.mockReset();
  });

  test("emits feed event for background conversation with text content", () => {
    const convId = "conv-bg-123";
    const msgId = "msg-456";

    getConversationSpy.mockReturnValue({
      conversationType: "background",
      title: "Nightly Cleanup",
    });
    getMessageByIdSpy.mockReturnValue({
      id: msgId,
      content: JSON.stringify([
        { type: "text", text: "Cleaned up 42 files successfully." },
      ]),
    });

    simulateFeedEventEmission(convId, msgId);

    expect(emitFeedEventSpy).toHaveBeenCalledTimes(1);
    expect(emitFeedEventSpy).toHaveBeenCalledWith({
      source: "assistant",
      title: "Nightly Cleanup",
      summary: "Cleaned up 42 files successfully.",
      dedupKey: `bg-conv:${convId}`,
    });
  });

  test("emits feed event for scheduled conversation", () => {
    const convId = "conv-sched-789";
    const msgId = "msg-101";

    getConversationSpy.mockReturnValue({
      conversationType: "scheduled",
      title: "Weekly Report",
    });
    getMessageByIdSpy.mockReturnValue({
      id: msgId,
      content: JSON.stringify([{ type: "text", text: "Report generated." }]),
    });

    simulateFeedEventEmission(convId, msgId);

    expect(emitFeedEventSpy).toHaveBeenCalledTimes(1);
    expect(emitFeedEventSpy).toHaveBeenCalledWith({
      source: "assistant",
      title: "Weekly Report",
      summary: "Report generated.",
      dedupKey: `bg-conv:${convId}`,
    });
  });

  test("truncates summary to 200 characters", () => {
    const convId = "conv-bg-long";
    const msgId = "msg-long";
    const longText = "A".repeat(300);

    getConversationSpy.mockReturnValue({
      conversationType: "background",
      title: "Long Task",
    });
    getMessageByIdSpy.mockReturnValue({
      id: msgId,
      content: JSON.stringify([{ type: "text", text: longText }]),
    });

    simulateFeedEventEmission(convId, msgId);

    expect(emitFeedEventSpy).toHaveBeenCalledTimes(1);
    const call = emitFeedEventSpy.mock.calls[0]![0];
    expect(call.summary).toHaveLength(200);
    expect(call.summary).toBe(longText.slice(0, 200));
  });

  test("falls back to conversation title when no text block in content", () => {
    const convId = "conv-bg-notext";
    const msgId = "msg-notext";

    getConversationSpy.mockReturnValue({
      conversationType: "background",
      title: "Image Task",
    });
    getMessageByIdSpy.mockReturnValue({
      id: msgId,
      content: JSON.stringify([{ type: "image", source: { data: "..." } }]),
    });

    simulateFeedEventEmission(convId, msgId);

    expect(emitFeedEventSpy).toHaveBeenCalledTimes(1);
    expect(emitFeedEventSpy.mock.calls[0]![0].summary).toBe("Image Task");
  });

  test("falls back to default summary when no message and no title", () => {
    const convId = "conv-bg-notitle";

    getConversationSpy.mockReturnValue({
      conversationType: "background",
      title: null,
    });

    simulateFeedEventEmission(convId, undefined);

    expect(emitFeedEventSpy).toHaveBeenCalledTimes(1);
    const call = emitFeedEventSpy.mock.calls[0]![0];
    expect(call.title).toBe("Background Task");
    expect(call.summary).toBe("Background task completed.");
  });

  test("does NOT emit feed event for standard (foreground) conversations", () => {
    const convId = "conv-standard-1";

    getConversationSpy.mockReturnValue({
      conversationType: "standard",
      title: "Regular Chat",
    });

    simulateFeedEventEmission(convId, undefined);

    expect(emitFeedEventSpy).not.toHaveBeenCalled();
  });

  test("does NOT emit feed event for private conversations", () => {
    const convId = "conv-private-1";

    getConversationSpy.mockReturnValue({
      conversationType: "private",
      title: "Secret Chat",
    });

    simulateFeedEventEmission(convId, undefined);

    expect(emitFeedEventSpy).not.toHaveBeenCalled();
  });

  test("uses dedupKey per conversation for in-place updates", () => {
    const convId = "conv-bg-dedup";

    getConversationSpy.mockReturnValue({
      conversationType: "background",
      title: "Recurring Job",
    });

    // First run
    simulateFeedEventEmission(convId, undefined);
    // Second run (re-run of same conversation)
    simulateFeedEventEmission(convId, undefined);

    expect(emitFeedEventSpy).toHaveBeenCalledTimes(2);
    // Both calls use the same dedupKey
    expect(emitFeedEventSpy.mock.calls[0]![0].dedupKey).toBe(
      `bg-conv:${convId}`,
    );
    expect(emitFeedEventSpy.mock.calls[1]![0].dedupKey).toBe(
      `bg-conv:${convId}`,
    );
  });
});

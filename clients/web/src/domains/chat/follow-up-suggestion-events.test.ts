/**
 * Tests for the follow-up chip telemetry.
 *
 * Three things are worth pinning. That no event carries a chip's text, because
 * the whole reason the click event ships a length is that the words are the
 * user's. That the impression's id is derived from the message id, because
 * that is what stops a reload counting a second impression. And that an
 * opted-out client sends nothing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// The emitters post through the generated client, the same transport the
// onboarding funnel uses; mock the sdk function and assert on the request body.
const ingestMock = mock(
  async (_options: { body: unknown; keepalive?: boolean }) => ({
    data: { accepted: 1, persisted: 1, dropped: {} },
    error: undefined,
    response: { ok: true, status: 200 } as Response,
  }),
);
mock.module("@/generated/api/sdk.gen", () => ({
  telemetryIngestCreate: ingestMock,
}));

// Consent is a `lib/` decision the emitters read; drive it directly rather
// than through the onboarding store the chat domain must not import.
let analyticsConsent = true;
mock.module("@/lib/telemetry/consent", () => ({
  readAnalyticsConsent: () => analyticsConsent,
}));

const {
  __resetFollowUpSuggestionEventsForTests,
  buildFollowUpSuggestionClickEvent,
  buildFollowUpSuggestionImpressionEvent,
  emitFollowUpSuggestionClick,
  emitFollowUpSuggestionImpression,
  followUpSuggestionImpressionEventId,
  FOLLOW_UP_SUGGESTION_CLICK_EVENT,
  FOLLOW_UP_SUGGESTION_IMPRESSION_EVENT,
} = await import("@/domains/chat/follow-up-suggestion-events");

const CONTEXT = {
  assistantId: "assistant-1",
  conversationId: "conv-xyz",
  messageId: "msg-123",
  ghostTextSuppressed: true,
};

const SUGGESTION = "Compare the two options";

function sentEvents(callIndex: number): Array<Record<string, unknown>> {
  const options = ingestMock.mock.calls[callIndex]?.[0] as
    | { body: { events: Array<Record<string, unknown>> } }
    | undefined;
  if (!options) {
    throw new Error(`No ingest call at index ${callIndex}`);
  }
  return options.body.events;
}

beforeEach(() => {
  analyticsConsent = true;
  __resetFollowUpSuggestionEventsForTests();
  ingestMock.mockClear();
});

describe("buildFollowUpSuggestionImpressionEvent", () => {
  test("carries the reply's identity, the count, and the rendered positions", () => {
    const event = buildFollowUpSuggestionImpressionEvent(CONTEXT, [0, 1]);

    expect(event).toMatchObject({
      type: FOLLOW_UP_SUGGESTION_IMPRESSION_EVENT,
      daemon_event_id: "follow_up_suggestion:impression:msg-123",
      assistant_id: "assistant-1",
      conversation_id: "conv-xyz",
      message_id: "msg-123",
      ghost_text_suppressed: true,
      suggestion_count: 2,
      suggestion_indexes: [0, 1],
    });
    expect(typeof event.recorded_at).toBe("number");
  });

  test("collapses onto the same id for the same message", () => {
    expect(followUpSuggestionImpressionEventId("msg-123")).toBe(
      buildFollowUpSuggestionImpressionEvent(CONTEXT, [0]).daemon_event_id,
    );
  });

  test("copies the positions rather than aliasing the caller's array", () => {
    const indexes = [0, 1];
    const event = buildFollowUpSuggestionImpressionEvent(CONTEXT, indexes);
    indexes.push(2);

    expect(event.suggestion_indexes).toEqual([0, 1]);
  });
});

describe("buildFollowUpSuggestionClickEvent", () => {
  test("records the picked chip's length and never its text", () => {
    const event = buildFollowUpSuggestionClickEvent(CONTEXT, {
      index: 1,
      suggestion: SUGGESTION,
    });

    expect(event).toMatchObject({
      type: FOLLOW_UP_SUGGESTION_CLICK_EVENT,
      message_id: "msg-123",
      suggestion_index: 1,
      suggestion_length: SUGGESTION.length,
    });
    expect(JSON.stringify(event)).not.toContain(SUGGESTION);
  });

  test("takes a fresh id per click, so two presses are two rows", () => {
    const first = buildFollowUpSuggestionClickEvent(CONTEXT, {
      index: 0,
      suggestion: SUGGESTION,
    });
    const second = buildFollowUpSuggestionClickEvent(CONTEXT, {
      index: 0,
      suggestion: SUGGESTION,
    });

    expect(first.daemon_event_id).not.toBe(second.daemon_event_id);
  });
});

describe("emitFollowUpSuggestionImpression", () => {
  test("sends one event the first time a reply's chips are reported", () => {
    emitFollowUpSuggestionImpression(CONTEXT, [0, 1]);

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(sentEvents(0)).toEqual([
      expect.objectContaining({
        type: FOLLOW_UP_SUGGESTION_IMPRESSION_EVENT,
        message_id: "msg-123",
        suggestion_count: 2,
      }),
    ]);
  });

  test("stays silent on a repeat report for the same message", () => {
    emitFollowUpSuggestionImpression(CONTEXT, [0, 1]);
    emitFollowUpSuggestionImpression(CONTEXT, [0, 1]);

    expect(ingestMock).toHaveBeenCalledTimes(1);
  });

  test("reports the next reply", () => {
    emitFollowUpSuggestionImpression(CONTEXT, [0, 1]);
    emitFollowUpSuggestionImpression({ ...CONTEXT, messageId: "msg-456" }, [0]);

    expect(ingestMock).toHaveBeenCalledTimes(2);
  });

  test("sends nothing when no chip rendered", () => {
    emitFollowUpSuggestionImpression(CONTEXT, []);

    expect(ingestMock).not.toHaveBeenCalled();
  });

  test("sends nothing for an opted-out client, and leaves the reply unclaimed", () => {
    analyticsConsent = false;
    emitFollowUpSuggestionImpression(CONTEXT, [0, 1]);
    expect(ingestMock).not.toHaveBeenCalled();

    analyticsConsent = true;
    emitFollowUpSuggestionImpression(CONTEXT, [0, 1]);
    expect(ingestMock).toHaveBeenCalledTimes(1);
  });
});

describe("emitFollowUpSuggestionClick", () => {
  test("sends one event per press", () => {
    emitFollowUpSuggestionClick(CONTEXT, { index: 0, suggestion: SUGGESTION });
    emitFollowUpSuggestionClick(CONTEXT, { index: 0, suggestion: SUGGESTION });

    expect(ingestMock).toHaveBeenCalledTimes(2);
    expect(sentEvents(1)).toEqual([
      expect.objectContaining({
        type: FOLLOW_UP_SUGGESTION_CLICK_EVENT,
        suggestion_index: 0,
        suggestion_length: SUGGESTION.length,
      }),
    ]);
  });

  test("sends nothing for an opted-out client", () => {
    analyticsConsent = false;
    emitFollowUpSuggestionClick(CONTEXT, { index: 0, suggestion: SUGGESTION });

    expect(ingestMock).not.toHaveBeenCalled();
  });
});

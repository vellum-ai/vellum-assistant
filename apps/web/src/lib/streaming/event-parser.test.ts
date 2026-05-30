import { describe, expect, test } from "bun:test";

import { parseAssistantEvent } from "@/lib/streaming/event-parser";
import { SYNC_TAGS } from "@/lib/sync/types";

describe("parseAssistantEvent", () => {
  // ---------------------------------------------------------------------
  // assistant_text_delta (schema-validated)
  // ---------------------------------------------------------------------

  test("parses assistant_text_delta with messageId and conversationId", () => {
    const event = parseAssistantEvent({
      type: "assistant_text_delta",
      text: "Hello",
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "Hello",
      messageId: "msg-1",
      conversationId: "conv-1",
    });
  });

  test("parses assistant_text_delta with only required text field", () => {
    const event = parseAssistantEvent({
      type: "assistant_text_delta",
      text: "",
    });
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "",
    });
  });

  test("returns unknown assistant_text_delta event when text field is missing", () => {
    const data = { type: "assistant_text_delta", conversationId: "conv-1" };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_text_delta",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown assistant_text_delta event when an unknown field is present", () => {
    // Strict schema rejects forward-compat extras — the daemon and the
    // canonical schema must move in lockstep.
    const data = { type: "assistant_text_delta", text: "Hi", legacyField: "x" };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_text_delta",
      data,
      conversationId: undefined,
    });
  });

  // ---------------------------------------------------------------------
  // message_complete (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_complete with messageId and conversationId", () => {
    const event = parseAssistantEvent({
      type: "message_complete",
      messageId: "msg-1",
      conversationId: "conversation-1",
    });
    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-1",
      conversationId: "conversation-1",
    });
  });

  test("parses message_complete with no fields", () => {
    const event = parseAssistantEvent({ type: "message_complete" });
    expect(event).toEqual({ type: "message_complete" });
  });

  test("parses message_complete with attachments", () => {
    const event = parseAssistantEvent({
      type: "message_complete",
      messageId: "msg-1",
      attachments: [
        {
          id: "att-1",
          filename: "screenshot.png",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
          sourceType: "sandbox_file",
        },
      ],
    });
    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-1",
      attachments: [
        {
          id: "att-1",
          filename: "screenshot.png",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
          sourceType: "sandbox_file",
        },
      ],
    });
  });

  test("parses message_complete with source aux", () => {
    const event = parseAssistantEvent({
      type: "message_complete",
      conversationId: "conv-1",
      messageId: "msg-aux",
      source: "aux",
    });
    expect(event).toEqual({
      type: "message_complete",
      conversationId: "conv-1",
      messageId: "msg-aux",
      source: "aux",
    });
  });

  test("parses message_complete with attachmentWarnings", () => {
    const event = parseAssistantEvent({
      type: "message_complete",
      messageId: "msg-1",
      attachmentWarnings: ["truncated to 4MB"],
    });
    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-1",
      attachmentWarnings: ["truncated to 4MB"],
    });
  });

  test("returns unknown message_complete event when an attachment is malformed", () => {
    // Strict sub-schema: every attachment must have `filename`, `mimeType`,
    // and `data`. A malformed entry rejects the whole event.
    const data = {
      type: "message_complete",
      conversationId: "conv-1",
      attachments: [{ filename: "missing-mime.txt" }],
    };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "message_complete",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown message_complete event when source has an invalid value", () => {
    const data = {
      type: "message_complete",
      conversationId: "conv-1",
      source: "unexpected",
    };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "message_complete",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // generation_handoff (schema-validated)
  // ---------------------------------------------------------------------

  test("parses generation_handoff with required queuedCount", () => {
    const event = parseAssistantEvent({
      type: "generation_handoff",
      conversationId: "conv-1",
      queuedCount: 2,
      requestId: "req-99",
      messageId: "msg-1",
    });
    expect(event).toEqual({
      type: "generation_handoff",
      conversationId: "conv-1",
      queuedCount: 2,
      requestId: "req-99",
      messageId: "msg-1",
    });
  });

  test("returns unknown generation_handoff event when queuedCount is missing", () => {
    const data = {
      type: "generation_handoff",
      conversationId: "conv-1",
      messageId: "msg-1",
    };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "generation_handoff",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // generation_cancelled (schema-validated)
  // ---------------------------------------------------------------------

  test("parses generation_cancelled with conversationId", () => {
    const event = parseAssistantEvent({
      type: "generation_cancelled",
      conversationId: "conv-1",
    });
    expect(event).toEqual({
      type: "generation_cancelled",
      conversationId: "conv-1",
    });
  });

  test("parses generation_cancelled without conversationId", () => {
    const event = parseAssistantEvent({ type: "generation_cancelled" });
    expect(event).toEqual({ type: "generation_cancelled" });
  });

  // ---------------------------------------------------------------------
  // document_comment_created (schema-validated)
  // ---------------------------------------------------------------------

  test("parses document_comment_created with full comment payload", () => {
    const event = parseAssistantEvent({
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      comment: {
        id: "c-1",
        surfaceId: "surface-1",
        author: "user",
        content: "looks good",
        anchorStart: 12,
        anchorEnd: 24,
        anchorText: "the section",
        parentCommentId: "c-0",
        status: "open",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_500,
      },
    });
    expect(event).toEqual({
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      comment: {
        id: "c-1",
        surfaceId: "surface-1",
        author: "user",
        content: "looks good",
        anchorStart: 12,
        anchorEnd: 24,
        anchorText: "the section",
        parentCommentId: "c-0",
        status: "open",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_500,
      },
    });
  });

  test("parses document_comment_created without optional anchor/thread fields", () => {
    const event = parseAssistantEvent({
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      comment: {
        id: "c-1",
        surfaceId: "surface-1",
        author: "assistant",
        content: "",
        status: "open",
        createdAt: 0,
        updatedAt: 0,
      },
    });
    expect(event).toEqual({
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      comment: {
        id: "c-1",
        surfaceId: "surface-1",
        author: "assistant",
        content: "",
        status: "open",
        createdAt: 0,
        updatedAt: 0,
      },
    });
  });

  test("returns unknown document_comment_created event when comment is missing", () => {
    const data = {
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "surface-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_created",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown document_comment_created event when surfaceId is missing", () => {
    const data = {
      type: "document_comment_created",
      conversationId: "conv-1",
      comment: {
        id: "c-1",
        surfaceId: "surface-1",
        author: "user",
        content: "x",
        status: "open",
        createdAt: 0,
        updatedAt: 0,
      },
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_created",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown document_comment_created event when an unknown field is present", () => {
    // Strict schema rejects forward-compat extras — the daemon and the
    // canonical schema must move in lockstep.
    const data = {
      type: "document_comment_created",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      comment: {
        id: "c-1",
        surfaceId: "surface-1",
        author: "user",
        content: "x",
        status: "open",
        createdAt: 0,
        updatedAt: 0,
      },
      legacyField: "x",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_created",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // document_comment_resolved (schema-validated)
  // ---------------------------------------------------------------------

  test("parses document_comment_resolved with all required fields", () => {
    const event = parseAssistantEvent({
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      resolvedBy: "user-alice",
    });
    expect(event).toEqual({
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      resolvedBy: "user-alice",
    });
  });

  test("returns unknown document_comment_resolved event when resolvedBy is missing", () => {
    const data = {
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_resolved",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown document_comment_resolved event when an unknown field is present", () => {
    const data = {
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      resolvedBy: "user-alice",
      legacyField: "x",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_resolved",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // document_comment_reopened (schema-validated)
  // ---------------------------------------------------------------------

  test("parses document_comment_reopened with all required fields", () => {
    const event = parseAssistantEvent({
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
    });
    expect(event).toEqual({
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
    });
  });

  test("returns unknown document_comment_reopened event when commentId is missing", () => {
    const data = {
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "surface-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_reopened",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown document_comment_reopened event when an unknown field is present", () => {
    const data = {
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      legacyField: "x",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_reopened",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // document_comment_deleted (schema-validated)
  // ---------------------------------------------------------------------

  test("parses document_comment_deleted with all required fields", () => {
    const event = parseAssistantEvent({
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
    });
    expect(event).toEqual({
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
    });
  });

  test("returns unknown document_comment_deleted event when surfaceId is missing", () => {
    const data = {
      type: "document_comment_deleted",
      conversationId: "conv-1",
      commentId: "c-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_deleted",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown document_comment_deleted event when an unknown field is present", () => {
    const data = {
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      legacyField: "x",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_deleted",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // message_queued (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_queued with all required fields", () => {
    const event = parseAssistantEvent({
      type: "message_queued",
      conversationId: "conv-1",
      requestId: "req-1",
      position: 2,
    });
    expect(event).toEqual({
      type: "message_queued",
      conversationId: "conv-1",
      requestId: "req-1",
      position: 2,
    });
  });

  test("returns unknown message_queued event when position is missing", () => {
    const data = {
      type: "message_queued",
      conversationId: "conv-1",
      requestId: "req-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_queued",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown message_queued event when an unknown field is present", () => {
    const data = {
      type: "message_queued",
      conversationId: "conv-1",
      requestId: "req-1",
      position: 0,
      legacyField: "x",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_queued",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // message_dequeued (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_dequeued with all required fields", () => {
    const event = parseAssistantEvent({
      type: "message_dequeued",
      conversationId: "conv-1",
      requestId: "req-1",
    });
    expect(event).toEqual({
      type: "message_dequeued",
      conversationId: "conv-1",
      requestId: "req-1",
    });
  });

  test("returns unknown message_dequeued event when conversationId is missing", () => {
    const data = {
      type: "message_dequeued",
      requestId: "req-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_dequeued",
      data,
      conversationId: undefined,
    });
  });

  test("returns unknown message_dequeued event when an unknown field is present", () => {
    const data = {
      type: "message_dequeued",
      conversationId: "conv-1",
      requestId: "req-1",
      stale: true,
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_dequeued",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // message_queued_deleted (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_queued_deleted with all required fields", () => {
    const event = parseAssistantEvent({
      type: "message_queued_deleted",
      conversationId: "conv-1",
      requestId: "req-1",
    });
    expect(event).toEqual({
      type: "message_queued_deleted",
      conversationId: "conv-1",
      requestId: "req-1",
    });
  });

  test("returns unknown message_queued_deleted event when requestId is missing", () => {
    const data = {
      type: "message_queued_deleted",
      conversationId: "conv-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_queued_deleted",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown message_queued_deleted event when an unknown field is present", () => {
    const data = {
      type: "message_queued_deleted",
      conversationId: "conv-1",
      requestId: "req-1",
      legacyReason: "user_cancel",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_queued_deleted",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // message_request_complete (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_request_complete with required fields and runStillActive", () => {
    const event = parseAssistantEvent({
      type: "message_request_complete",
      conversationId: "conv-1",
      requestId: "req-1",
      runStillActive: true,
    });
    expect(event).toEqual({
      type: "message_request_complete",
      conversationId: "conv-1",
      requestId: "req-1",
      runStillActive: true,
    });
  });

  test("parses message_request_complete without optional runStillActive", () => {
    const event = parseAssistantEvent({
      type: "message_request_complete",
      conversationId: "conv-1",
      requestId: "req-1",
    });
    expect(event).toEqual({
      type: "message_request_complete",
      conversationId: "conv-1",
      requestId: "req-1",
    });
  });

  test("returns unknown message_request_complete event when requestId is missing", () => {
    const data = {
      type: "message_request_complete",
      conversationId: "conv-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_request_complete",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown message_request_complete event when an unknown field is present", () => {
    const data = {
      type: "message_request_complete",
      conversationId: "conv-1",
      requestId: "req-1",
      runStillActive: false,
      legacyField: "x",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_request_complete",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // compaction_circuit_open / compaction_circuit_closed (schema-validated)
  // ---------------------------------------------------------------------

  test("parses compaction_circuit_open with all required fields", () => {
    const event = parseAssistantEvent({
      type: "compaction_circuit_open",
      conversationId: "conv-1",
      reason: "3_consecutive_failures",
      openUntil: 1_700_000_000_000,
    });
    expect(event).toEqual({
      type: "compaction_circuit_open",
      conversationId: "conv-1",
      reason: "3_consecutive_failures",
      openUntil: 1_700_000_000_000,
    });
  });

  test("returns unknown compaction_circuit_open when reason is not the recognized literal", () => {
    const data = {
      type: "compaction_circuit_open",
      conversationId: "conv-1",
      reason: "unexplained",
      openUntil: 1_700_000_000_000,
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "compaction_circuit_open",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown compaction_circuit_open when openUntil is missing", () => {
    const data = {
      type: "compaction_circuit_open",
      conversationId: "conv-1",
      reason: "3_consecutive_failures",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "compaction_circuit_open",
      data,
      conversationId: "conv-1",
    });
  });

  test("parses compaction_circuit_closed with required fields", () => {
    const event = parseAssistantEvent({
      type: "compaction_circuit_closed",
      conversationId: "conv-1",
    });
    expect(event).toEqual({
      type: "compaction_circuit_closed",
      conversationId: "conv-1",
    });
  });

  test("returns unknown compaction_circuit_closed when conversationId is missing", () => {
    const data = { type: "compaction_circuit_closed" };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "compaction_circuit_closed",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // home_feed_updated (schema-validated)
  // ---------------------------------------------------------------------

  test("parses home_feed_updated with all required fields", () => {
    const event = parseAssistantEvent({
      type: "home_feed_updated",
      updatedAt: "2026-05-29T15:00:00.000Z",
      newItemCount: 3,
    });
    expect(event).toEqual({
      type: "home_feed_updated",
      updatedAt: "2026-05-29T15:00:00.000Z",
      newItemCount: 3,
    });
  });

  test("returns unknown home_feed_updated when updatedAt is missing", () => {
    const data = { type: "home_feed_updated", newItemCount: 3 };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "home_feed_updated",
      data,
    });
  });

  test("returns unknown home_feed_updated when newItemCount has wrong type", () => {
    const data = {
      type: "home_feed_updated",
      updatedAt: "2026-05-29T15:00:00.000Z",
      newItemCount: "many",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "home_feed_updated",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // interaction_resolved (schema-validated; legacy tests above still cover
  // happy path + invalid state + missing requestId)
  // ---------------------------------------------------------------------

  test("returns unknown interaction_resolved when conversationId is missing", () => {
    const data = {
      type: "interaction_resolved",
      requestId: "req-1",
      state: "approved",
      kind: "confirmation",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "interaction_resolved",
      data,
    });
  });

  test("returns unknown interaction_resolved when an unknown field is present", () => {
    const data = {
      type: "interaction_resolved",
      requestId: "req-1",
      conversationId: "conv-1",
      state: "approved",
      kind: "confirmation",
      legacyField: "x",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "interaction_resolved",
      data,
      conversationId: "conv-1",
    });
  });

  test("parses error with code and message", () => {
    const event = parseAssistantEvent({
      type: "error",
      code: "rate_limit_exceeded",
      message: "Too many requests",
    });
    expect(event).toEqual({
      type: "error",
      code: "rate_limit_exceeded",
      message: "Too many requests",
    });
  });

  test("preserves categorized stream error metadata", () => {
    const event = parseAssistantEvent({
      type: "error",
      code: "PROVIDER_BILLING",
      errorCategory: "credits_exhausted",
      message: "Your balance has run out",
    });
    expect(event).toEqual({
      type: "error",
      code: "PROVIDER_BILLING",
      errorCategory: "credits_exhausted",
      message: "Your balance has run out",
    });
  });

  test("defaults error message to 'Unknown error' when missing", () => {
    const event = parseAssistantEvent({ type: "error" });
    expect(event).toEqual({
      type: "error",
      code: undefined,
      message: "Unknown error",
    });
  });

  test("parses interaction_resolved with explicit conversationId", () => {
    const event = parseAssistantEvent({
      type: "interaction_resolved",
      requestId: "req-1",
      conversationId: "conv-1",
      state: "approved",
      kind: "confirmation",
    });
    expect(event).toEqual({
      type: "interaction_resolved",
      requestId: "req-1",
      conversationId: "conv-1",
      state: "approved",
      kind: "confirmation",
    });
  });

  test("interaction_resolved with an invalid state degrades to unknown", () => {
    const event = parseAssistantEvent({
      type: "interaction_resolved",
      requestId: "req-3",
      conversationId: "conv-3",
      state: "exploded",
      kind: "confirmation",
    });
    expect(event.type).toBe("unknown");
  });

  test("interaction_resolved without a requestId degrades to unknown", () => {
    const event = parseAssistantEvent({
      type: "interaction_resolved",
      conversationId: "conv-4",
      state: "cancelled",
    });
    expect(event.type).toBe("unknown");
  });

  test("returns unknown event for unrecognized type", () => {
    const data = { type: "some_future_event", foo: "bar" };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "some_future_event",
      data,
    });
  });

  test("parses sync_changed tags", () => {
    const event = parseAssistantEvent({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.assistantAvatar,
        "conversation:conversation-1:metadata",
        "future:resource",
      ],
    });
    expect(event).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.assistantAvatar,
        "conversation:conversation-1:metadata",
        "future:resource",
      ],
    });
  });

  test("returns unknown for sync_changed without a tags array", () => {
    const data = { type: "sync_changed", tag: SYNC_TAGS.assistantAvatar };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "sync_changed",
      data,
    });
  });

  test("returns unknown for sync_changed with non-string tags", () => {
    const data = {
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar, 42],
    };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "sync_changed",
      data,
    });
  });

  test("parses sync_changed with originClientId", () => {
    const event = parseAssistantEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-abc",
    });
    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-abc",
    });
  });

  test("omits originClientId from sync_changed when absent", () => {
    const event = parseAssistantEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    });
    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    });
    expect("originClientId" in event).toBe(false);
  });

  test("ignores blank or non-string originClientId on sync_changed", () => {
    const blank = parseAssistantEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "   ",
    });
    expect("originClientId" in blank).toBe(false);

    const nonString = parseAssistantEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: 42,
    });
    expect("originClientId" in nonString).toBe(false);

    const trimmed = parseAssistantEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "  client-xyz  ",
    });
    expect(trimmed).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-xyz",
    });
  });

  test("parses assistant_activity_state idle", () => {
    const event = parseAssistantEvent({
      type: "assistant_activity_state",
      conversationId: "conv-1",
      activityVersion: 7,
      phase: "idle",
      anchor: "global",
      reason: "message_complete",
      requestId: "req-abc",
    });
    expect(event).toEqual({
      type: "assistant_activity_state",
      activityVersion: 7,
      phase: "idle",
      anchor: "global",
      reason: "message_complete",
      requestId: "req-abc",
      conversationId: "conv-1",
    });
  });

  test("parses assistant_activity_state thinking with statusText", () => {
    const event = parseAssistantEvent({
      type: "assistant_activity_state",
      conversationId: "conv-1",
      activityVersion: 3,
      phase: "thinking",
      anchor: "assistant_turn",
      reason: "thinking_delta",
      statusText: "Reading file…",
    });
    expect(event).toEqual({
      type: "assistant_activity_state",
      activityVersion: 3,
      phase: "thinking",
      anchor: "assistant_turn",
      reason: "thinking_delta",
      statusText: "Reading file…",
      conversationId: "conv-1",
    });
  });

  test("parses assistant_activity_state idle with error_terminal reason", () => {
    // Disk-pressure block path emits idle with error_terminal but no
    // follow-up message_complete. The web handler must treat this as
    // terminal so the loading indicator clears.
    const event = parseAssistantEvent({
      type: "assistant_activity_state",
      conversationId: "conv-1",
      activityVersion: 1,
      phase: "idle",
      anchor: "global",
      reason: "error_terminal",
    });
    expect(event).toEqual({
      type: "assistant_activity_state",
      activityVersion: 1,
      phase: "idle",
      anchor: "global",
      reason: "error_terminal",
      conversationId: "conv-1",
    });
  });

  test("returns unknown for assistant_activity_state with invalid phase", () => {
    const data = {
      type: "assistant_activity_state",
      conversationId: "conv-1",
      activityVersion: 1,
      phase: "definitely_not_a_phase",
      anchor: "global",
      reason: "message_complete",
    };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_activity_state",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown for assistant_activity_state with invalid reason", () => {
    const data = {
      type: "assistant_activity_state",
      conversationId: "conv-1",
      activityVersion: 1,
      phase: "idle",
      anchor: "global",
      reason: "made_up_reason",
    };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_activity_state",
      data,
      conversationId: "conv-1",
    });
  });

  test("parses open_url", () => {
    const event = parseAssistantEvent({
      type: "open_url",
      url: "https://example.com/oauth",
      title: "Connect Google",
      conversationId: "conv-1",
    });
    expect(event).toEqual({
      type: "open_url",
      url: "https://example.com/oauth",
      title: "Connect Google",
      conversationId: "conv-1",
    });
  });

  test("returns unknown open_url event when url is missing", () => {
    const data = {
      type: "open_url",
      title: "Connect Google",
      conversationId: "conv-1",
    };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "open_url",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown open_url event when url is empty string", () => {
    const data = { type: "open_url", url: "", conversationId: "conv-1" };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "open_url",
      data,
      conversationId: "conv-1",
    });
  });

  test("parses navigate_settings", () => {
    const event = parseAssistantEvent({
      type: "navigate_settings",
      tab: "Integrations",
    });
    expect(event).toEqual({
      type: "navigate_settings",
      tab: "Integrations",
    });
  });

  test("returns unknown navigate_settings event when tab is missing", () => {
    const data = { type: "navigate_settings" };
    const event = parseAssistantEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "navigate_settings",
      data,
    });
  });

  test("parses disk_pressure_status_changed", () => {
    const event = parseAssistantEvent({
      type: "disk_pressure_status_changed",
      status: {
        enabled: true,
        state: "critical",
        locked: true,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: true,
        lockId: "lock-123",
        usagePercent: 94.3,
        thresholdPercent: 90,
        path: "/workspace",
        lastCheckedAt: "2026-05-05T12:00:00.000Z",
        blockedCapabilities: [
          "agent-turns",
          "background-work",
          "remote-ingress",
          "unknown-capability",
        ],
        error: null,
      },
    });

    expect(event).toEqual({
      type: "disk_pressure_status_changed",
      status: {
        enabled: true,
        state: "critical",
        locked: true,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: true,
        lockId: "lock-123",
        usagePercent: 94.3,
        thresholdPercent: 90,
        path: "/workspace",
        lastCheckedAt: "2026-05-05T12:00:00.000Z",
        blockedCapabilities: [
          "agent-turns",
          "background-work",
          "remote-ingress",
        ],
        error: null,
      },
      conversationId: undefined,
    });
  });

  test("parses flat disk_pressure_status_changed payloads", () => {
    const event = parseAssistantEvent({
      type: "disk_pressure_status_changed",
      enabled: true,
      state: "critical",
      locked: true,
      acknowledged: false,
      overrideActive: false,
      effectivelyLocked: true,
      lockId: "lock-flat",
      usagePercent: 96,
      thresholdPercent: 90,
      path: "/workspace",
      lastCheckedAt: "2026-05-05T12:05:00.000Z",
      blockedCapabilities: ["background-work", "remote-ingress"],
      error: null,
      conversationId: "conversation-123",
    });

    expect(event).toEqual({
      type: "disk_pressure_status_changed",
      status: {
        enabled: true,
        state: "critical",
        locked: true,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: true,
        lockId: "lock-flat",
        usagePercent: 96,
        thresholdPercent: 90,
        path: "/workspace",
        lastCheckedAt: "2026-05-05T12:05:00.000Z",
        blockedCapabilities: ["background-work", "remote-ingress"],
        error: null,
      },
      conversationId: "conversation-123",
    });
  });

  test("parses disk_pressure_status_changed disabled status", () => {
    const event = parseAssistantEvent({
      type: "disk_pressure_status_changed",
      status: {
        enabled: false,
        state: "disabled",
        locked: false,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: false,
        lockId: null,
        usagePercent: null,
        thresholdPercent: 90,
        path: null,
        lastCheckedAt: null,
        blockedCapabilities: [],
        error: null,
      },
    });

    expect(event).toEqual({
      type: "disk_pressure_status_changed",
      status: {
        enabled: false,
        state: "disabled",
        locked: false,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: false,
        lockId: null,
        usagePercent: null,
        thresholdPercent: 90,
        path: null,
        lastCheckedAt: null,
        blockedCapabilities: [],
        error: null,
      },
      conversationId: undefined,
    });
  });

  describe("tool_result", () => {
    test("maps riskAllowlistOptions → allowlistOptions (Minimatch save-path) and riskDirectoryScopeOptions → directoryScopeOptions", () => {
      const event = parseAssistantEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
        riskLevel: "medium",
        riskAllowlistOptions: [
          {
            pattern: "ls -la",
            label: "Just this command",
            description: "Allow only `ls -la`",
          },
          {
            pattern: "action:ls",
            label: "All ls commands",
            description: "Allow any `ls …` invocation",
          },
        ],
        riskDirectoryScopeOptions: [
          { scope: "/home/user/project", label: "Project directory" },
        ],
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.allowlistOptions).toEqual([
          {
            pattern: "ls -la",
            label: "Just this command",
            description: "Allow only `ls -la`",
          },
          {
            pattern: "action:ls",
            label: "All ls commands",
            description: "Allow any `ls …` invocation",
          },
        ]);
        expect(event.directoryScopeOptions).toEqual([
          { scope: "/home/user/project", label: "Project directory" },
        ]);
      }
    });

    test("does NOT promote riskScopeOptions into allowlistOptions (display-only ladder is not save-path)", () => {
      // riskScopeOptions can carry regex-flavored descriptors that are NOT
      // valid Minimatch trust rule patterns. Saving them would produce a
      // rule that never matches future calls. This test guards against
      // regression of the pre-PR-29826 conflation bug where the deserializer
      // cast `riskScopeOptions` into `allowlistOptions`.
      const event = parseAssistantEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
        riskScopeOptions: [
          { pattern: "^bash\\(ls.*\\)$", label: "All ls commands" },
        ],
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.allowlistOptions).toBeUndefined();
        expect(event.directoryScopeOptions).toBeUndefined();
      }
    });

    test("returns undefined allowlistOptions when riskAllowlistOptions is missing", () => {
      const event = parseAssistantEvent({
        type: "tool_result",
        toolName: "remember",
        result: "saved",
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.allowlistOptions).toBeUndefined();
        expect(event.directoryScopeOptions).toBeUndefined();
      }
    });

    test("does not read top-level allowlistOptions on tool_result (wire field is riskAllowlistOptions)", () => {
      // The daemon sends `riskAllowlistOptions` on tool_result, not the
      // un-prefixed `allowlistOptions` (that field is reserved for
      // confirmation_request). Guard against regression to a wrong-field read.
      const event = parseAssistantEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
        allowlistOptions: [{ pattern: "bash(*)", label: "All bash" }],
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.allowlistOptions).toBeUndefined();
      }
    });

    test("propagates messageId (anchor protocol)", () => {
      const event = parseAssistantEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
        toolUseId: "toolu_01",
        messageId: "asst-msg-42",
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.messageId).toBe("asst-msg-42");
      }
    });

    test("messageId is undefined when absent (legacy daemon stream)", () => {
      const event = parseAssistantEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.messageId).toBeUndefined();
      }
    });

    test("ignores non-string messageId", () => {
      const event = parseAssistantEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
        messageId: 42,
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.messageId).toBeUndefined();
      }
    });
  });

  describe("tool_use_start", () => {
    test("propagates messageId (anchor protocol)", () => {
      const event = parseAssistantEvent({
        type: "tool_use_start",
        toolName: "bash",
        input: { command: "ls" },
        toolUseId: "toolu_01",
        messageId: "asst-msg-42",
      });
      expect(event.type).toBe("tool_use_start");
      if (event.type === "tool_use_start") {
        expect(event.messageId).toBe("asst-msg-42");
        expect(event.toolUseId).toBe("toolu_01");
      }
    });

    test("messageId is undefined when absent (legacy daemon stream)", () => {
      const event = parseAssistantEvent({
        type: "tool_use_start",
        toolName: "bash",
        input: {},
      });
      expect(event.type).toBe("tool_use_start");
      if (event.type === "tool_use_start") {
        expect(event.messageId).toBeUndefined();
      }
    });
  });

  describe("assistant_turn_start", () => {
    test("parses with required messageId", () => {
      const event = parseAssistantEvent({
        type: "assistant_turn_start",
        messageId: "asst-msg-42",
        conversationId: "conv-1",
      });
      expect(event).toEqual({
        type: "assistant_turn_start",
        messageId: "asst-msg-42",
        conversationId: "conv-1",
      });
    });

    test("conversationId is optional", () => {
      const event = parseAssistantEvent({
        type: "assistant_turn_start",
        messageId: "asst-msg-42",
      });
      expect(event.type).toBe("assistant_turn_start");
      if (event.type === "assistant_turn_start") {
        expect(event.messageId).toBe("asst-msg-42");
        expect(event.conversationId).toBeUndefined();
      }
    });

    test("drops to unknown when messageId is missing — the anchor id is the entire payload", () => {
      // `assistant_turn_start` exists solely to communicate the
      // pre-allocated row id. Without it, the event carries no information
      // worth surfacing to the reducer. Falling back to `unknown` keeps the
      // chat reducer's "saw an event we didn't know how to handle" branch
      // visible in dev mode rather than silently producing a no-op event.
      const event = parseAssistantEvent({
        type: "assistant_turn_start",
      });
      expect(event.type).toBe("unknown");
    });

    test("drops to unknown when messageId is non-string", () => {
      const event = parseAssistantEvent({
        type: "assistant_turn_start",
        messageId: 42,
      });
      expect(event.type).toBe("unknown");
    });
  });

  // ---------------------------------------------------------------------
  // ui_surface_show (schema-validated)
  // ---------------------------------------------------------------------

  test("parses ui_surface_show with all fields", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_show",
      conversationId: "conv-1",
      surfaceId: "s-1",
      surfaceType: "card",
      title: "Status",
      data: { title: "Hello", body: "World" },
      actions: [
        { id: "ok", label: "OK", style: "primary" },
        { id: "cancel", label: "Cancel", style: "secondary" },
      ],
      display: "inline",
      messageId: "m-1",
      persistent: true,
    });
    expect(event).toEqual({
      type: "ui_surface_show",
      conversationId: "conv-1",
      surfaceId: "s-1",
      surfaceType: "card",
      title: "Status",
      data: { title: "Hello", body: "World" },
      actions: [
        { id: "ok", label: "OK", style: "primary" },
        { id: "cancel", label: "Cancel", style: "secondary" },
      ],
      display: "inline",
      messageId: "m-1",
      persistent: true,
    });
  });

  test("parses ui_surface_show with required fields only", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_show",
      conversationId: "conv-2",
      surfaceId: "s-2",
      surfaceType: "form",
      data: {},
    });
    expect(event).toEqual({
      type: "ui_surface_show",
      conversationId: "conv-2",
      surfaceId: "s-2",
      surfaceType: "form",
      data: {},
    });
  });

  test("returns unknown ui_surface_show when conversationId is missing", () => {
    const data = {
      type: "ui_surface_show",
      surfaceId: "s-3",
      surfaceType: "card",
      data: {},
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_show",
      data,
    });
  });

  test("returns unknown ui_surface_show when extra field is present", () => {
    const data = {
      type: "ui_surface_show",
      conversationId: "conv-4",
      surfaceId: "s-4",
      surfaceType: "card",
      data: {},
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_show",
      data,
      conversationId: "conv-4",
    });
  });

  // ---------------------------------------------------------------------
  // ui_surface_update (schema-validated)
  // ---------------------------------------------------------------------

  test("parses ui_surface_update with all fields", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_update",
      conversationId: "conv-1",
      surfaceId: "s-1",
      data: { html: "<p>updated</p>" },
    });
    expect(event).toEqual({
      type: "ui_surface_update",
      conversationId: "conv-1",
      surfaceId: "s-1",
      data: { html: "<p>updated</p>" },
    });
  });

  test("returns unknown ui_surface_update when data is missing", () => {
    const data = {
      type: "ui_surface_update",
      conversationId: "conv-1",
      surfaceId: "s-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_update",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown ui_surface_update when extra field is present", () => {
    const data = {
      type: "ui_surface_update",
      conversationId: "conv-1",
      surfaceId: "s-1",
      data: {},
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_update",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // ui_surface_dismiss (schema-validated)
  // ---------------------------------------------------------------------

  test("parses ui_surface_dismiss with all fields", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_dismiss",
      conversationId: "conv-1",
      surfaceId: "s-1",
    });
    expect(event).toEqual({
      type: "ui_surface_dismiss",
      conversationId: "conv-1",
      surfaceId: "s-1",
    });
  });

  test("returns unknown ui_surface_dismiss when surfaceId is missing", () => {
    const data = {
      type: "ui_surface_dismiss",
      conversationId: "conv-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_dismiss",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown ui_surface_dismiss when extra field is present", () => {
    const data = {
      type: "ui_surface_dismiss",
      conversationId: "conv-1",
      surfaceId: "s-1",
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_dismiss",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // ui_surface_complete (schema-validated)
  // ---------------------------------------------------------------------

  test("parses ui_surface_complete with all fields", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_complete",
      conversationId: "conv-1",
      surfaceId: "s-1",
      summary: "Form submitted",
      submittedData: { name: "Ada" },
    });
    expect(event).toEqual({
      type: "ui_surface_complete",
      conversationId: "conv-1",
      surfaceId: "s-1",
      summary: "Form submitted",
      submittedData: { name: "Ada" },
    });
  });

  test("parses ui_surface_complete with required fields only", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_complete",
      conversationId: "conv-1",
      surfaceId: "s-1",
      summary: "Done",
    });
    expect(event).toEqual({
      type: "ui_surface_complete",
      conversationId: "conv-1",
      surfaceId: "s-1",
      summary: "Done",
    });
  });

  test("returns unknown ui_surface_complete when summary is missing", () => {
    const data = {
      type: "ui_surface_complete",
      conversationId: "conv-1",
      surfaceId: "s-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_complete",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown ui_surface_complete when extra field is present", () => {
    const data = {
      type: "ui_surface_complete",
      conversationId: "conv-1",
      surfaceId: "s-1",
      summary: "Done",
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_complete",
      data,
      conversationId: "conv-1",
    });
  });

  test("parses notification_intent with deep-link metadata", () => {
    const event = parseAssistantEvent({
      type: "notification_intent",
      deliveryId: "del-1",
      sourceEventName: "chat.assistant_turn_complete",
      title: "New message",
      body: "Hello world",
      deepLinkMetadata: { conversationId: "conv-42" },
    });
    expect(event).toEqual({
      type: "notification_intent",
      deliveryId: "del-1",
      sourceEventName: "chat.assistant_turn_complete",
      title: "New message",
      body: "Hello world",
      deepLinkMetadata: { conversationId: "conv-42" },
      targetGuardianPrincipalId: undefined,
    });
  });

  test("notification_intent preserves targetGuardianPrincipalId", () => {
    const event = parseAssistantEvent({
      type: "notification_intent",
      sourceEventName: "guardian.question",
      title: "Guardian check-in",
      body: "Approve this request?",
      targetGuardianPrincipalId: "guardian-7",
    });
    expect(event.type).toBe("notification_intent");
    if (event.type === "notification_intent") {
      expect(event.targetGuardianPrincipalId).toBe("guardian-7");
    }
  });

  test("notification_intent without title falls through to unknown", () => {
    const event = parseAssistantEvent({
      type: "notification_intent",
      sourceEventName: "chat.assistant_turn_complete",
      body: "missing title",
    });
    expect(event.type).toBe("unknown");
  });

  test("notification_intent with non-object deepLinkMetadata is ignored", () => {
    const event = parseAssistantEvent({
      type: "notification_intent",
      sourceEventName: "chat.assistant_turn_complete",
      title: "Hello",
      body: "Body",
      deepLinkMetadata: "not-an-object",
    });
    expect(event.type).toBe("notification_intent");
    if (event.type === "notification_intent") {
      expect(event.deepLinkMetadata).toBeUndefined();
    }
  });

  // ---------------------------------------------------------------------
  // identity_changed (schema-validated)
  // ---------------------------------------------------------------------

  test("parses identity_changed with all required fields", () => {
    const event = parseAssistantEvent({
      type: "identity_changed",
      name: "ApolloBot",
      role: "sidekick",
      personality: "cosmic",
      emoji: "🦖",
      home: "kubernetes",
    });
    expect(event).toEqual({
      type: "identity_changed",
      name: "ApolloBot",
      role: "sidekick",
      personality: "cosmic",
      emoji: "🦖",
      home: "kubernetes",
    });
  });

  test("returns unknown identity_changed when a required field is missing", () => {
    const data = {
      type: "identity_changed",
      name: "ApolloBot",
      role: "sidekick",
      personality: "cosmic",
      // emoji omitted
      home: "kubernetes",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "identity_changed",
      data,
    });
  });

  test("returns unknown identity_changed when a field has wrong type", () => {
    const data = {
      type: "identity_changed",
      name: 42,
      role: "sidekick",
      personality: "cosmic",
      emoji: "🦖",
      home: "kubernetes",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "identity_changed",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // avatar_updated (schema-validated)
  // ---------------------------------------------------------------------

  test("parses avatar_updated with avatarPath", () => {
    const event = parseAssistantEvent({
      type: "avatar_updated",
      avatarPath: "/home/.vellum/avatar.png",
    });
    expect(event).toEqual({
      type: "avatar_updated",
      avatarPath: "/home/.vellum/avatar.png",
    });
  });

  test("returns unknown avatar_updated when avatarPath is missing", () => {
    const data = { type: "avatar_updated" };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "avatar_updated",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // conversation_list_invalidated (schema-validated)
  // ---------------------------------------------------------------------

  test("parses conversation_list_invalidated with each valid reason", () => {
    for (const reason of [
      "created",
      "renamed",
      "deleted",
      "reordered",
      "seen_changed",
    ] as const) {
      const event = parseAssistantEvent({
        type: "conversation_list_invalidated",
        reason,
      });
      expect(event).toEqual({ type: "conversation_list_invalidated", reason });
    }
  });

  test("returns unknown conversation_list_invalidated when reason is missing", () => {
    const data = { type: "conversation_list_invalidated" };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "conversation_list_invalidated",
      data,
    });
  });

  test("returns unknown conversation_list_invalidated when reason is not a recognized enum value", () => {
    const data = {
      type: "conversation_list_invalidated",
      reason: "evicted",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "conversation_list_invalidated",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // conversation_title_updated (schema-validated)
  // ---------------------------------------------------------------------

  test("parses conversation_title_updated with conversationId and title", () => {
    const event = parseAssistantEvent({
      type: "conversation_title_updated",
      conversationId: "conv-1",
      title: "New Title",
    });
    expect(event).toEqual({
      type: "conversation_title_updated",
      conversationId: "conv-1",
      title: "New Title",
    });
  });

  test("returns unknown conversation_title_updated when conversationId is missing", () => {
    const data = {
      type: "conversation_title_updated",
      title: "Orphan title",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "conversation_title_updated",
      data,
    });
  });

  test("returns unknown conversation_title_updated when title is missing", () => {
    const data = {
      type: "conversation_title_updated",
      conversationId: "conv-1",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "conversation_title_updated",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // secret_request (schema-validated)
  // ---------------------------------------------------------------------

  test("parses secret_request with all fields", () => {
    const event = parseAssistantEvent({
      type: "secret_request",
      requestId: "sr-1",
      service: "github",
      field: "token",
      label: "GitHub Token",
      description: "Personal access token",
      placeholder: "ghp_...",
      conversationId: "conv-1",
      purpose: "push",
      allowedTools: ["bash"],
      allowedDomains: ["github.com"],
      allowOneTimeSend: true,
    });
    expect(event).toEqual({
      type: "secret_request",
      requestId: "sr-1",
      service: "github",
      field: "token",
      label: "GitHub Token",
      description: "Personal access token",
      placeholder: "ghp_...",
      conversationId: "conv-1",
      purpose: "push",
      allowedTools: ["bash"],
      allowedDomains: ["github.com"],
      allowOneTimeSend: true,
    });
  });

  test("parses secret_request with required fields only", () => {
    const event = parseAssistantEvent({
      type: "secret_request",
      requestId: "sr-2",
      service: "openai",
      field: "api_key",
      label: "OpenAI API Key",
    });
    expect(event).toEqual({
      type: "secret_request",
      requestId: "sr-2",
      service: "openai",
      field: "api_key",
      label: "OpenAI API Key",
    });
  });

  test("returns unknown secret_request when service is missing", () => {
    const data = {
      type: "secret_request",
      requestId: "sr-3",
      field: "api_key",
      label: "Missing service",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "secret_request",
      data,
    });
  });

  test("returns unknown secret_request when extra field is present", () => {
    const data = {
      type: "secret_request",
      requestId: "sr-4",
      service: "openai",
      field: "api_key",
      label: "Extra",
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "secret_request",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // confirmation_request (schema-validated)
  // ---------------------------------------------------------------------

  test("parses confirmation_request with all fields", () => {
    const event = parseAssistantEvent({
      type: "confirmation_request",
      requestId: "cr-1",
      toolName: "bash",
      input: { command: "ls -la" },
      riskLevel: "medium",
      riskReason: "Filesystem read",
      isContainerized: false,
      executionTarget: "sandbox",
      allowlistOptions: [
        {
          label: "Allow all bash",
          description: "All commands",
          pattern: "Bash(*)",
        },
      ],
      scopeOptions: [{ label: "This workspace", scope: "workspace" }],
      directoryScopeOptions: [{ label: "/src", scope: "/src" }],
      diff: {
        filePath: "/tmp/x",
        oldContent: "a",
        newContent: "b",
        isNewFile: false,
      },
      conversationId: "conv-1",
      persistentDecisionsAllowed: true,
      toolUseId: "tu-1",
      acpToolKind: "fs",
      acpOptions: [{ optionId: "o1", name: "Allow once", kind: "allow_once" }],
    });
    expect(event).toEqual({
      type: "confirmation_request",
      requestId: "cr-1",
      toolName: "bash",
      input: { command: "ls -la" },
      riskLevel: "medium",
      riskReason: "Filesystem read",
      isContainerized: false,
      executionTarget: "sandbox",
      allowlistOptions: [
        {
          label: "Allow all bash",
          description: "All commands",
          pattern: "Bash(*)",
        },
      ],
      scopeOptions: [{ label: "This workspace", scope: "workspace" }],
      directoryScopeOptions: [{ label: "/src", scope: "/src" }],
      diff: {
        filePath: "/tmp/x",
        oldContent: "a",
        newContent: "b",
        isNewFile: false,
      },
      conversationId: "conv-1",
      persistentDecisionsAllowed: true,
      toolUseId: "tu-1",
      acpToolKind: "fs",
      acpOptions: [{ optionId: "o1", name: "Allow once", kind: "allow_once" }],
    });
  });

  test("parses confirmation_request with required fields only", () => {
    const event = parseAssistantEvent({
      type: "confirmation_request",
      requestId: "cr-2",
      toolName: "write_file",
      input: { path: "/tmp/y" },
      riskLevel: "low",
      allowlistOptions: [],
      scopeOptions: [],
    });
    expect(event).toEqual({
      type: "confirmation_request",
      requestId: "cr-2",
      toolName: "write_file",
      input: { path: "/tmp/y" },
      riskLevel: "low",
      allowlistOptions: [],
      scopeOptions: [],
    });
  });

  test("returns unknown confirmation_request when toolName is missing", () => {
    const data = {
      type: "confirmation_request",
      requestId: "cr-3",
      input: {},
      riskLevel: "low",
      allowlistOptions: [],
      scopeOptions: [],
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "confirmation_request",
      data,
    });
  });

  test("returns unknown confirmation_request when extra field is present", () => {
    const data = {
      type: "confirmation_request",
      requestId: "cr-4",
      toolName: "bash",
      input: {},
      riskLevel: "low",
      allowlistOptions: [],
      scopeOptions: [],
      title: "Allow?",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "confirmation_request",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // contact_request (schema-validated)
  // ---------------------------------------------------------------------

  test("parses contact_request with all fields", () => {
    const event = parseAssistantEvent({
      type: "contact_request",
      requestId: "ctc-1",
      channel: "email",
      placeholder: "you@example.com",
      label: "Email",
      description: "How can we reach you?",
      role: "primary",
    });
    expect(event).toEqual({
      type: "contact_request",
      requestId: "ctc-1",
      channel: "email",
      placeholder: "you@example.com",
      label: "Email",
      description: "How can we reach you?",
      role: "primary",
    });
  });

  test("parses contact_request with required fields only", () => {
    const event = parseAssistantEvent({
      type: "contact_request",
      requestId: "ctc-2",
    });
    expect(event).toEqual({
      type: "contact_request",
      requestId: "ctc-2",
    });
  });

  test("returns unknown contact_request when requestId is missing", () => {
    const data = { type: "contact_request", channel: "email" };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "contact_request",
      data,
    });
  });

  test("returns unknown contact_request when extra field is present", () => {
    const data = {
      type: "contact_request",
      requestId: "ctc-3",
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "contact_request",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // question_request (schema-validated)
  // ---------------------------------------------------------------------

  test("parses question_request with all fields", () => {
    const event = parseAssistantEvent({
      type: "question_request",
      requestId: "qr-1",
      questions: [
        {
          id: "q1",
          question: "Pick one",
          description: "Choose carefully",
          options: [{ id: "a", label: "A", description: "first" }],
          freeTextPlaceholder: "or type",
        },
      ],
      question: "Pick one",
      description: "Choose carefully",
      options: [{ id: "a", label: "A", description: "first" }],
      freeTextPlaceholder: "or type",
      conversationId: "conv-1",
      toolUseId: "tu-1",
    });
    expect(event).toEqual({
      type: "question_request",
      requestId: "qr-1",
      questions: [
        {
          id: "q1",
          question: "Pick one",
          description: "Choose carefully",
          options: [{ id: "a", label: "A", description: "first" }],
          freeTextPlaceholder: "or type",
        },
      ],
      question: "Pick one",
      description: "Choose carefully",
      options: [{ id: "a", label: "A", description: "first" }],
      freeTextPlaceholder: "or type",
      conversationId: "conv-1",
      toolUseId: "tu-1",
    });
  });

  test("parses question_request with required fields only", () => {
    const event = parseAssistantEvent({
      type: "question_request",
      requestId: "qr-2",
      questions: [{ id: "q1", question: "Continue?", options: [] }],
      question: "Continue?",
      options: [],
    });
    expect(event).toEqual({
      type: "question_request",
      requestId: "qr-2",
      questions: [{ id: "q1", question: "Continue?", options: [] }],
      question: "Continue?",
      options: [],
    });
  });

  test("returns unknown question_request when questions array is missing", () => {
    const data = {
      type: "question_request",
      requestId: "qr-3",
      question: "Continue?",
      options: [],
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "question_request",
      data,
    });
  });

  test("returns unknown question_request when extra field is present", () => {
    const data = {
      type: "question_request",
      requestId: "qr-4",
      questions: [{ id: "q1", question: "?", options: [] }],
      question: "?",
      options: [],
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "question_request",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // subagent_spawned (schema-validated)
  // ---------------------------------------------------------------------

  test("parses subagent_spawned with all fields", () => {
    const event = parseAssistantEvent({
      type: "subagent_spawned",
      subagentId: "sa-1",
      parentConversationId: "conv-1",
      label: "Research",
      objective: "Find weather data",
      isFork: false,
      parentToolUseId: "tu-1",
    });
    expect(event).toEqual({
      type: "subagent_spawned",
      subagentId: "sa-1",
      parentConversationId: "conv-1",
      label: "Research",
      objective: "Find weather data",
      isFork: false,
      parentToolUseId: "tu-1",
    });
  });

  test("parses subagent_spawned with required fields only", () => {
    const event = parseAssistantEvent({
      type: "subagent_spawned",
      subagentId: "sa-2",
      parentConversationId: "conv-2",
      label: "Research",
      objective: "Find weather data",
    });
    expect(event).toEqual({
      type: "subagent_spawned",
      subagentId: "sa-2",
      parentConversationId: "conv-2",
      label: "Research",
      objective: "Find weather data",
    });
  });

  test("returns unknown subagent_spawned when parentConversationId is missing", () => {
    const data = {
      type: "subagent_spawned",
      subagentId: "sa-3",
      label: "Research",
      objective: "Find weather data",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_spawned",
      data,
    });
  });

  test("returns unknown subagent_spawned when extra field is present", () => {
    const data = {
      type: "subagent_spawned",
      subagentId: "sa-4",
      parentConversationId: "conv-4",
      label: "Research",
      objective: "Find weather data",
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_spawned",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // subagent_status_changed (schema-validated)
  // ---------------------------------------------------------------------

  test("parses subagent_status_changed with all fields", () => {
    const event = parseAssistantEvent({
      type: "subagent_status_changed",
      subagentId: "sa-1",
      status: "completed",
      error: undefined,
      usage: { inputTokens: 100, outputTokens: 50, estimatedCost: 0.012 },
    });
    expect(event).toEqual({
      type: "subagent_status_changed",
      subagentId: "sa-1",
      status: "completed",
      usage: { inputTokens: 100, outputTokens: 50, estimatedCost: 0.012 },
    });
  });

  test("parses subagent_status_changed with required fields only", () => {
    const event = parseAssistantEvent({
      type: "subagent_status_changed",
      subagentId: "sa-2",
      status: "running",
    });
    expect(event).toEqual({
      type: "subagent_status_changed",
      subagentId: "sa-2",
      status: "running",
    });
  });

  test("accepts subagent_status_changed with `aborted` terminal status", () => {
    const event = parseAssistantEvent({
      type: "subagent_status_changed",
      subagentId: "sa-3",
      status: "aborted",
    });
    expect(event).toEqual({
      type: "subagent_status_changed",
      subagentId: "sa-3",
      status: "aborted",
    });
  });

  test("returns unknown subagent_status_changed when status is invalid", () => {
    const data = {
      type: "subagent_status_changed",
      subagentId: "sa-4",
      status: "bogus",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_status_changed",
      data,
    });
  });

  test("returns unknown subagent_status_changed when extra field is present", () => {
    const data = {
      type: "subagent_status_changed",
      subagentId: "sa-5",
      status: "running",
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_status_changed",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // subagent_event (schema-validated)
  // ---------------------------------------------------------------------

  test("parses subagent_event wrapping an inner event", () => {
    const event = parseAssistantEvent({
      type: "subagent_event",
      conversationId: "conv-1",
      subagentId: "sa-1",
      event: {
        type: "assistant_text_delta",
        text: "hello",
      },
    });
    expect(event).toEqual({
      type: "subagent_event",
      conversationId: "conv-1",
      subagentId: "sa-1",
      event: {
        type: "assistant_text_delta",
        text: "hello",
      },
    });
  });

  test("parses subagent_event with an inner tool_use_start envelope", () => {
    const event = parseAssistantEvent({
      type: "subagent_event",
      conversationId: "conv-2",
      subagentId: "sa-2",
      event: {
        type: "tool_use_start",
        toolName: "bash",
        toolUseId: "tu-1",
        input: { command: "ls" },
      },
    });
    expect(event).toEqual({
      type: "subagent_event",
      conversationId: "conv-2",
      subagentId: "sa-2",
      event: {
        type: "tool_use_start",
        toolName: "bash",
        toolUseId: "tu-1",
        input: { command: "ls" },
      },
    });
  });

  test("returns unknown subagent_event when conversationId is missing", () => {
    const data = {
      type: "subagent_event",
      subagentId: "sa-3",
      event: { type: "assistant_text_delta", text: "hi" },
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_event",
      data,
    });
  });

  test("returns unknown subagent_event when extra field is present", () => {
    const data = {
      type: "subagent_event",
      conversationId: "conv-4",
      subagentId: "sa-4",
      event: { type: "assistant_text_delta", text: "hi" },
      surpriseField: "boom",
    };
    expect(parseAssistantEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_event",
      data,
      conversationId: "conv-4",
    });
  });
});

describe("envelope format parsing", () => {
  test("flat payloads pass through unchanged", () => {
    const event = parseAssistantEvent({
      type: "assistant_text_delta",
      text: "Hello from envelope",
      messageId: "msg-env-1",
    });
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "Hello from envelope",
      messageId: "msg-env-1",
    });
  });

  test("envelope shape uses message.type over top-level type", () => {
    const event = parseAssistantEvent({
      type: "wrapper",
      message: {
        type: "assistant_text_delta",
        text: "nested",
        messageId: "msg-nested",
      },
    });

    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "nested",
      messageId: "msg-nested",
    });
  });

  test("envelope shape supports sync_changed", () => {
    const event = parseAssistantEvent({
      type: "wrapper",
      message: {
        type: "sync_changed",
        tags: [
          SYNC_TAGS.assistantIdentity,
          "conversation:conversation-1:messages",
        ],
      },
    });

    expect(event).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.assistantIdentity,
        "conversation:conversation-1:messages",
      ],
    });
  });

  test("flat message_complete works when no envelope message field is present", () => {
    const event = parseAssistantEvent({
      type: "message_complete",
      messageId: "msg-flat",
    });

    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-flat",
    });
  });

  test("flat sync_changed works when no envelope message field is present", () => {
    const event = parseAssistantEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantSounds],
    });

    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantSounds],
    });
  });

  test("non-object message field is ignored (falls back to flat)", () => {
    const event = parseAssistantEvent({
      type: "error",
      message: "This is a string, not an envelope",
      code: "test_error",
    });

    expect(event).toEqual({
      type: "error",
      code: "test_error",
      message: "This is a string, not an envelope",
    });
  });

  test("envelope-level conversationId is stamped onto legacy conversation-scoped events", () => {
    // Legacy fallback path: events not yet migrated to AssistantEventSchema
    // (here: `error`) read the envelope-level conversationId via
    // `mergeEnvelopeConversationId`. This codepath disappears as each
    // legacy case migrates to a strict schema.
    const event = parseAssistantEvent({
      conversationId: "conv-from-envelope",
      message: {
        type: "error",
        message: "boom",
      },
    });
    expect(event).toEqual({
      type: "error",
      code: undefined,
      message: "boom",
      conversationId: "conv-from-envelope",
    });
  });

  test("envelope-level conversationId does NOT override an event-supplied conversationId", () => {
    // Same legacy fallback path — when the inner message carries its own
    // conversationId, it wins over the envelope-level routing key.
    const event = parseAssistantEvent({
      conversationId: "envelope-conv",
      message: {
        type: "error",
        message: "boom",
        conversationId: "event-conv",
      },
    });
    if (event.type !== "error") throw new Error("expected error");
    expect(event.conversationId).toBe("event-conv");
  });

  test("envelope-level conversationId is NOT stamped onto strict-schema events", () => {
    // relationship_state_updated is a global event whose strict wire schema
    // doesn't declare conversationId. Stamping the envelope-derived value
    // onto it is the drift `@vellumai/assistant-api` exists to prevent.
    const event = parseAssistantEvent({
      conversationId: "should-be-ignored",
      message: {
        type: "relationship_state_updated",
        updatedAt: "2026-05-26T00:00:00Z",
      },
    });
    expect(event).toEqual({
      type: "relationship_state_updated",
      updatedAt: "2026-05-26T00:00:00Z",
    });
    expect("conversationId" in event).toBe(false);
  });

  test("schema-parsed events: envelope conversationId is NOT grafted onto the typed event", () => {
    // open_url declares `conversationId` as an OPTIONAL field on the
    // inner message. When the emit site omits it (CLI signal-file
    // broadcasts, global flows), the schema still validates and the
    // typed event simply has no conversationId — the parser never
    // grafts the envelope-level routing key onto schema-parsed events.
    // Drift between envelope and typed event is exactly what
    // `@vellumai/assistant-api` exists to prevent. Downstream routing
    // that needs conversation scope reads the envelope at the SSE
    // pipe, not from the typed event.
    const event = parseAssistantEvent({
      conversationId: "conv-from-envelope",
      message: {
        type: "open_url",
        url: "https://example.com/oauth",
        title: "Connect Google",
      },
    });
    if (event.type !== "open_url") throw new Error("expected open_url");
    expect(event.url).toBe("https://example.com/oauth");
    expect(event.title).toBe("Connect Google");
    expect(event.conversationId).toBeUndefined();
  });

  test("schema-parsed events: inner-declared conversationId is preserved verbatim", () => {
    // Happy path for conversation-scoped emit sites: the emit site
    // sets conversationId on the inner message, the schema validates,
    // and the typed event carries it through. The envelope value plays
    // no role.
    const event = parseAssistantEvent({
      conversationId: "envelope-conv",
      message: {
        type: "open_url",
        url: "https://example.com/oauth",
        conversationId: "inner-conv",
      },
    });
    if (event.type !== "open_url") throw new Error("expected open_url");
    expect(event.conversationId).toBe("inner-conv");
  });
});

// ---------------------------------------------------------------------------
// RuntimeMessage metadata preservation
// ---------------------------------------------------------------------------

describe("RuntimeMessage metadata types", () => {
  test("RuntimeMessage interface accepts optional metadata fields", () => {
    // Type-level test: ensure RuntimeMessage can carry metadata
    const msg: import("@/domains/chat/api/messages").RuntimeMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello",
      surfaces: [
        {
          surfaceId: "s-1",
          surfaceType: "card",
          data: { title: "Test" },
        },
      ],
      textSegments: [{ type: "text", content: "Hello" }],
      contentOrder: [
        { type: "text", id: "seg-1" },
        { type: "surface", id: "s-1" },
      ],
      metadata: { custom: true },
    };
    expect(msg.surfaces).toHaveLength(1);
    expect(msg.textSegments).toHaveLength(1);
    expect(msg.contentOrder).toHaveLength(2);
    expect(msg.metadata).toEqual({ custom: true });
  });

  test("RuntimeMessage works without metadata fields", () => {
    const msg: import("@/domains/chat/api/messages").RuntimeMessage = {
      id: "msg-2",
      role: "user",
      content: "Hi",
    };
    expect(msg.surfaces).toBeUndefined();
    expect(msg.textSegments).toBeUndefined();
    expect(msg.contentOrder).toBeUndefined();
    expect(msg.metadata).toBeUndefined();
  });

  test("ChatMessage interface accepts optional metadata fields", () => {
    const msg: import("@/domains/chat/api/event-types").ChatMessage = {
      id: "msg-3",
      role: "assistant",
      content: "With metadata",
      surfaces: [{ surfaceId: "s-2", surfaceType: "form", data: {} }],
      textSegments: [{ type: "markdown", content: "# Header" }],
      contentOrder: [{ type: "surface", id: "s-2" }],
      metadata: { source: "test" },
    };
    expect(msg.surfaces).toHaveLength(1);
    expect(msg.metadata).toEqual({ source: "test" });
  });
});

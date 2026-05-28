import { describe, expect, test } from "bun:test";

import {
  parseAssistantEvent,
  toDisplayAttachments,
} from "@/domains/chat/api/event-parser";
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

  test("parses secret_request with all fields", () => {
    const event = parseAssistantEvent({
      type: "secret_request",
      requestId: "req-1",
      service: "github",
      field: "token",
      label: "GitHub Token",
      description: "Enter your personal access token",
      placeholder: "ghp_...",
      allowOneTimeSend: true,
    });
    expect(event).toEqual({
      type: "secret_request",
      requestId: "req-1",
      service: "github",
      field: "token",
      label: "GitHub Token",
      description: "Enter your personal access token",
      placeholder: "ghp_...",
      allowOneTimeSend: true,
    });
  });

  test("defaults secret_request requestId to empty string", () => {
    const event = parseAssistantEvent({ type: "secret_request" });
    expect(event).toEqual({
      type: "secret_request",
      requestId: "",
      service: undefined,
      field: undefined,
      label: undefined,
      description: undefined,
      placeholder: undefined,
      allowOneTimeSend: undefined,
    });
  });

  describe("confirmation_request", () => {
    test("parses confirmation_request with toolUseId", () => {
      const event = parseAssistantEvent({
        type: "confirmation_request",
        requestId: "req-1",
        title: "Allow file write?",
        toolName: "write_file",
        toolUseId: "tool-use-42",
        riskLevel: "high",
      });
      expect(event).toEqual({
        type: "confirmation_request",
        requestId: "req-1",
        title: "Allow file write?",
        description: undefined,
        confirmLabel: undefined,
        denyLabel: undefined,
        toolName: "write_file",
        executionTarget: undefined,
        riskLevel: "high",
        riskReason: undefined,
        allowlistOptions: undefined,
        scopeOptions: undefined,
        directoryScopeOptions: undefined,
        persistentDecisionsAllowed: undefined,
        input: undefined,
        toolUseId: "tool-use-42",
      });
    });

    test("parses confirmation_request without toolUseId", () => {
      const event = parseAssistantEvent({
        type: "confirmation_request",
        requestId: "req-2",
        title: "Allow shell command?",
        toolName: "bash",
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.requestId).toBe("req-2");
        expect(event.toolUseId).toBeUndefined();
      }
    });

    test("ignores non-string toolUseId", () => {
      const event = parseAssistantEvent({
        type: "confirmation_request",
        requestId: "req-3",
        toolUseId: 12345,
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.toolUseId).toBeUndefined();
      }
    });

    test("parses full confirmation_request with allowlist and scope options", () => {
      const event = parseAssistantEvent({
        type: "confirmation_request",
        requestId: "req-full",
        title: "Allow bash command?",
        description: "ls -la /tmp",
        confirmLabel: "Allow",
        denyLabel: "Deny",
        toolName: "bash",
        executionTarget: "sandbox",
        riskLevel: "medium",
        riskReason: "Filesystem access",
        toolUseId: "tool-use-99",
        allowlistOptions: [
          { pattern: "Bash(*)", label: "Allow all bash commands" },
        ],
        scopeOptions: [{ scope: "workspace", label: "Current workspace" }],
        directoryScopeOptions: [{ scope: "/src", label: "Source directory" }],
        persistentDecisionsAllowed: true,
        input: { command: "ls -la /tmp" },
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.requestId).toBe("req-full");
        expect(event.toolUseId).toBe("tool-use-99");
        expect(event.allowlistOptions).toEqual([
          { pattern: "Bash(*)", label: "Allow all bash commands" },
        ]);
        expect(event.scopeOptions).toEqual([
          { scope: "workspace", label: "Current workspace" },
        ]);
        expect(event.directoryScopeOptions).toEqual([
          { scope: "/src", label: "Source directory" },
        ]);
        expect(event.persistentDecisionsAllowed).toBe(true);
        expect(event.input).toEqual({ command: "ls -la /tmp" });
      }
    });

    test("defaults requestId to empty string when missing", () => {
      const event = parseAssistantEvent({
        type: "confirmation_request",
        title: "Confirm?",
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.requestId).toBe("");
      }
    });

    test("ignores non-array allowlistOptions and non-boolean persistentDecisionsAllowed", () => {
      const event = parseAssistantEvent({
        type: "confirmation_request",
        requestId: "req-invalid",
        allowlistOptions: "not-an-array",
        persistentDecisionsAllowed: "yes",
        input: [1, 2, 3],
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.allowlistOptions).toBeUndefined();
        expect(event.persistentDecisionsAllowed).toBeUndefined();
        expect(event.input).toBeUndefined();
      }
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

  test("preserves surfaceType verbatim without coercion", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_show",
      surfaceId: "s-1",
      surfaceType: "custom_widget",
      data: { key: "value" },
    });
    expect(event).toEqual({
      type: "ui_surface_show",
      surfaceId: "s-1",
      surfaceType: "custom_widget",
      title: undefined,
      data: { key: "value" },
      actions: undefined,
      display: undefined,
      messageId: undefined,
    });
  });

  test("preserves known surfaceType values as-is", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_show",
      surfaceId: "s-2",
      surfaceType: "form",
      data: {},
    });
    expect(event.type).toBe("ui_surface_show");
    if (event.type === "ui_surface_show") {
      expect(event.surfaceType).toBe("form");
    }
  });

  test("defaults surfaceType to 'card' when not a string", () => {
    const event = parseAssistantEvent({
      type: "ui_surface_show",
      surfaceId: "s-3",
      surfaceType: 42,
      data: {},
    });
    expect(event.type).toBe("ui_surface_show");
    if (event.type === "ui_surface_show") {
      expect(event.surfaceType).toBe("card");
    }
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

  describe("identity_changed", () => {
    test("parses to a typed invalidation signal regardless of payload", () => {
      // Arbitrary payload — handler treats this as an invalidation-only signal
      // and refetches identity from the canonical endpoint.
      const event = parseAssistantEvent({
        type: "identity_changed",
        name: "Pax",
        role: "assistant",
      });
      expect(event.type).toBe("identity_changed");
    });

    test("empty payload still produces IdentityChangedEvent (not UnknownEvent)", () => {
      const event = parseAssistantEvent({ type: "identity_changed" });
      expect(event.type).toBe("identity_changed");
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
    const msg: import("./messages").RuntimeMessage = {
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
    const msg: import("./messages").RuntimeMessage = {
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
    const msg: import("./event-types").ChatMessage = {
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

describe("toDisplayAttachments", () => {
  test("returns undefined for empty/missing input", () => {
    expect(toDisplayAttachments(undefined)).toBeUndefined();
    expect(toDisplayAttachments([])).toBeUndefined();
  });

  test("converts image attachment with data-URI previewUrl", () => {
    const result = toDisplayAttachments([
      {
        id: "att-1",
        filename: "photo.png",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-1",
        filename: "photo.png",
        mimeType: "image/png",
        sizeBytes: expect.any(Number),
        previewUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    ]);
  });

  test("creates data-URI previewUrl for non-image types with inline data", () => {
    const result = toDisplayAttachments([
      {
        id: "att-2",
        filename: "report.pdf",
        mimeType: "application/pdf",
        data: "JVBERi0xLjQ=",
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-2",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: expect.any(Number),
        previewUrl: "data:application/pdf;base64,JVBERi0xLjQ=",
      },
    ]);
  });

  test("uses thumbnailData when data is empty", () => {
    const result = toDisplayAttachments([
      {
        id: "att-3",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        data: "",
        thumbnailData: "thumb123",
        fileBacked: true,
        sizeBytes: 1024,
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-3",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1024,
        previewUrl: "data:image/jpeg;base64,thumb123",
      },
    ]);
  });

  test("falls back to filename for id when id is missing", () => {
    const result = toDisplayAttachments([
      {
        filename: "noId.txt",
        mimeType: "text/plain",
        data: "aGVsbG8=",
      },
    ]);
    expect(result?.[0]?.id).toBe("noId.txt");
  });
});

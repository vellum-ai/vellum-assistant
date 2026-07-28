import { describe, expect, test } from "bun:test";

import type { DiskPressureStatus } from "@vellumai/assistant-api";

import type { AssistantEvent } from "@/types/event-types";
import { parseAssistantEvent } from "@/lib/streaming/event-parser";
import { SYNC_TAGS } from "@/lib/sync/types";

/**
 * Convenience wrapper: extracts the inner event from the envelope
 * returned by `parseAssistantEvent`. Most tests only care about the
 * inner event, not the envelope metadata.
 */
function parseEvent(data: Record<string, unknown>): AssistantEvent {
  return parseAssistantEvent(data).message as AssistantEvent;
}

describe("parseAssistantEvent", () => {
  // ---------------------------------------------------------------------
  // assistant_text_delta (schema-validated)
  // ---------------------------------------------------------------------

  test("parses assistant_text_delta with messageId and conversationId", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_text_delta",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from assistant_text_delta", () => {
    const event = parseEvent({
      type: "assistant_text_delta",
      text: "Hi",
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "Hi",
    });
  });

  // ---------------------------------------------------------------------
  // assistant_thinking_delta (schema-validated)
  // ---------------------------------------------------------------------

  test("parses assistant_thinking_delta with messageId and conversationId", () => {
    // GIVEN a streaming reasoning chunk stamped with its anchor ids
    // WHEN it is parsed
    const event = parseEvent({
      type: "assistant_thinking_delta",
      thinking: "let me think",
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    // THEN it is recognized (not coerced to `unknown`) with fields preserved
    expect(event).toEqual({
      type: "assistant_thinking_delta",
      thinking: "let me think",
      messageId: "msg-1",
      conversationId: "conv-1",
    });
  });

  test("parses assistant_thinking_delta preserving the emission timestamp", () => {
    // GIVEN a streaming reasoning chunk stamped with its daemon emission time
    // WHEN it is parsed
    const event = parseEvent({
      type: "assistant_thinking_delta",
      thinking: "let me think",
      messageId: "msg-1",
      conversationId: "conv-1",
      timestampMs: 1_700_000_000_000,
    });
    // THEN the epoch-ms timestamp survives parsing so timing is observable
    expect(event).toEqual({
      type: "assistant_thinking_delta",
      thinking: "let me think",
      messageId: "msg-1",
      conversationId: "conv-1",
      timestampMs: 1_700_000_000_000,
    });
  });

  test("parses assistant_thinking_delta with only the required thinking field", () => {
    // GIVEN a delta from an older daemon that doesn't stamp anchor ids
    // WHEN it is parsed
    const event = parseEvent({
      type: "assistant_thinking_delta",
      thinking: "",
    });
    // THEN it still parses as the canonical event
    expect(event).toEqual({
      type: "assistant_thinking_delta",
      thinking: "",
    });
  });

  test("returns unknown assistant_thinking_delta event when thinking field is missing", () => {
    // GIVEN a malformed delta lacking the required reasoning text
    const data = {
      type: "assistant_thinking_delta",
      conversationId: "conv-1",
    };
    // WHEN it is parsed
    const event = parseEvent(data);
    // THEN it falls back to the unknown envelope rather than throwing
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_thinking_delta",
      data,
      conversationId: "conv-1",
    });
  });

  // ---------------------------------------------------------------------
  // message_complete (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_complete with messageId and conversationId", () => {
    const event = parseEvent({
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
    const event = parseEvent({ type: "message_complete" });
    expect(event).toEqual({ type: "message_complete" });
  });

  test("parses message_complete with attachments", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent(data);
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
    const event = parseEvent(data);
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
    const event = parseEvent({
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
    const event = parseEvent(data);
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
    const event = parseEvent({
      type: "generation_cancelled",
      conversationId: "conv-1",
    });
    expect(event).toEqual({
      type: "generation_cancelled",
      conversationId: "conv-1",
    });
  });

  test("parses generation_cancelled without conversationId", () => {
    const event = parseEvent({ type: "generation_cancelled" });
    expect(event).toEqual({ type: "generation_cancelled" });
  });

  // ---------------------------------------------------------------------
  // document_comment_created (schema-validated)
  // ---------------------------------------------------------------------

  test("parses document_comment_created with full comment payload", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_created",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from document_comment_created", () => {
    const event = parseEvent({
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
    });
    expect(event).toEqual({
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
    });
  });

  // ---------------------------------------------------------------------
  // document_comment_resolved (schema-validated)
  // ---------------------------------------------------------------------

  test("parses document_comment_resolved with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_resolved",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from document_comment_resolved", () => {
    const event = parseEvent({
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      resolvedBy: "user-alice",
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "document_comment_resolved",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      resolvedBy: "user-alice",
    });
  });

  // ---------------------------------------------------------------------
  // document_comment_reopened (schema-validated)
  // ---------------------------------------------------------------------

  test("parses document_comment_reopened with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_reopened",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from document_comment_reopened", () => {
    const event = parseEvent({
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "document_comment_reopened",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
    });
  });

  // ---------------------------------------------------------------------
  // document_comment_deleted (schema-validated)
  // ---------------------------------------------------------------------

  test("parses document_comment_deleted with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "document_comment_deleted",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from document_comment_deleted", () => {
    const event = parseEvent({
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "document_comment_deleted",
      conversationId: "conv-1",
      surfaceId: "surface-1",
      commentId: "c-1",
    });
  });

  // ---------------------------------------------------------------------
  // message_queued (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_queued with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_queued",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from message_queued", () => {
    const event = parseEvent({
      type: "message_queued",
      conversationId: "conv-1",
      requestId: "req-1",
      position: 0,
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "message_queued",
      conversationId: "conv-1",
      requestId: "req-1",
      position: 0,
    });
  });

  // ---------------------------------------------------------------------
  // message_dequeued (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_dequeued with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_dequeued",
      data,
      conversationId: undefined,
    });
  });

  test("strips unknown fields from message_dequeued", () => {
    const event = parseEvent({
      type: "message_dequeued",
      conversationId: "conv-1",
      requestId: "req-1",
      stale: true,
    });
    expect(event).toEqual({
      type: "message_dequeued",
      conversationId: "conv-1",
      requestId: "req-1",
    });
  });

  // ---------------------------------------------------------------------
  // message_queued_deleted (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_queued_deleted with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_queued_deleted",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from message_queued_deleted", () => {
    const event = parseEvent({
      type: "message_queued_deleted",
      conversationId: "conv-1",
      requestId: "req-1",
      legacyReason: "user_cancel",
    });
    expect(event).toEqual({
      type: "message_queued_deleted",
      conversationId: "conv-1",
      requestId: "req-1",
    });
  });

  // ---------------------------------------------------------------------
  // message_request_complete (schema-validated)
  // ---------------------------------------------------------------------

  test("parses message_request_complete with required fields and runStillActive", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "message_request_complete",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from message_request_complete", () => {
    const event = parseEvent({
      type: "message_request_complete",
      conversationId: "conv-1",
      requestId: "req-1",
      runStillActive: false,
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "message_request_complete",
      conversationId: "conv-1",
      requestId: "req-1",
      runStillActive: false,
    });
  });

  // ---------------------------------------------------------------------
  // compaction_circuit_open / compaction_circuit_closed (schema-validated)
  // ---------------------------------------------------------------------

  test("parses compaction_circuit_open with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "compaction_circuit_open",
      data,
      conversationId: "conv-1",
    });
  });

  test("parses compaction_circuit_closed with required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "compaction_circuit_closed",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // home_feed_updated (schema-validated)
  // ---------------------------------------------------------------------

  test("parses home_feed_updated with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "interaction_resolved",
      data,
    });
  });

  test("strips unknown fields from interaction_resolved", () => {
    const event = parseEvent({
      type: "interaction_resolved",
      requestId: "req-1",
      conversationId: "conv-1",
      state: "approved",
      kind: "confirmation",
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "interaction_resolved",
      requestId: "req-1",
      conversationId: "conv-1",
      state: "approved",
      kind: "confirmation",
    });
  });

  // ---------------------------------------------------------------------
  // error (schema-validated)
  // ---------------------------------------------------------------------

  test("parses error with all fields", () => {
    const event = parseEvent({
      type: "error",
      message: "Your balance has run out",
      code: "PROVIDER_BILLING",
      category: "secret_blocked",
      errorCategory: "credits_exhausted",
      requestId: "req-1",
      conversationId: "conv-1",
    });
    expect(event).toEqual({
      type: "error",
      message: "Your balance has run out",
      code: "PROVIDER_BILLING",
      category: "secret_blocked",
      errorCategory: "credits_exhausted",
      requestId: "req-1",
      conversationId: "conv-1",
    });
  });

  test("parses error with required fields only", () => {
    const event = parseEvent({
      type: "error",
      message: "Too many requests",
    });
    expect(event).toEqual({
      type: "error",
      message: "Too many requests",
    });
  });

  test("returns unknown error when message is missing", () => {
    const data = { type: "error", code: "rate_limit_exceeded" };
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "error",
      data,
    });
  });

  test("strips unknown fields from error", () => {
    const event = parseEvent({
      type: "error",
      message: "boom",
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "error",
      message: "boom",
    });
  });

  // ---------------------------------------------------------------------
  // conversation_error (schema-validated)
  // ---------------------------------------------------------------------

  test("parses conversation_error with all fields", () => {
    const event = parseEvent({
      type: "conversation_error",
      conversationId: "conv-1",
      code: "PROVIDER_INVALID_KEY",
      userMessage: "Your API key is invalid",
      retryable: false,
      debugDetails: "401 from provider",
      errorCategory: "auth",
      connectionName: "My OpenAI",
      profileName: "Default",
    });
    expect(event).toEqual({
      type: "conversation_error",
      conversationId: "conv-1",
      code: "PROVIDER_INVALID_KEY",
      userMessage: "Your API key is invalid",
      retryable: false,
      debugDetails: "401 from provider",
      errorCategory: "auth",
      connectionName: "My OpenAI",
      profileName: "Default",
    });
  });

  test("parses conversation_error with required fields only", () => {
    const event = parseEvent({
      type: "conversation_error",
      conversationId: "conv-2",
      code: "PROVIDER_RATE_LIMIT",
      userMessage: "Rate limited",
      retryable: true,
    });
    expect(event).toEqual({
      type: "conversation_error",
      conversationId: "conv-2",
      code: "PROVIDER_RATE_LIMIT",
      userMessage: "Rate limited",
      retryable: true,
    });
  });

  test("returns unknown conversation_error when retryable is missing", () => {
    const data = {
      type: "conversation_error",
      conversationId: "conv-3",
      code: "UNKNOWN",
      userMessage: "Something went wrong.",
    };
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "conversation_error",
      data,
      conversationId: "conv-3",
    });
  });

  test("returns unknown conversation_error when code is not a known enum", () => {
    const data = {
      type: "conversation_error",
      conversationId: "conv-4",
      code: "rate_limit",
      userMessage: "Rate limited",
      retryable: true,
    };
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "conversation_error",
      data,
      conversationId: "conv-4",
    });
  });

  test("strips unknown fields from conversation_error", () => {
    const event = parseEvent({
      type: "conversation_error",
      conversationId: "conv-5",
      code: "UNKNOWN",
      userMessage: "Something went wrong.",
      retryable: false,
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "conversation_error",
      conversationId: "conv-5",
      code: "UNKNOWN",
      userMessage: "Something went wrong.",
      retryable: false,
    });
  });

  // ---------------------------------------------------------------------
  // conversation_notice (schema-validated)
  // ---------------------------------------------------------------------

  test("parses conversation_notice with billing fields", () => {
    const event = parseEvent({
      type: "conversation_notice",
      conversationId: "conv-1",
      source: "memory_v3",
      code: "PROVIDER_BILLING",
      userMessage: "You've run out of credits.",
      errorCategory: "credits_exhausted",
    });
    expect(event).toEqual({
      type: "conversation_notice",
      conversationId: "conv-1",
      source: "memory_v3",
      code: "PROVIDER_BILLING",
      userMessage: "You've run out of credits.",
      errorCategory: "credits_exhausted",
    });
  });

  test("parses interaction_resolved with explicit conversationId", () => {
    const event = parseEvent({
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
    const event = parseEvent({
      type: "interaction_resolved",
      requestId: "req-3",
      conversationId: "conv-3",
      state: "exploded",
      kind: "confirmation",
    });
    expect(event.type).toBe("unknown");
  });

  test("interaction_resolved without a requestId degrades to unknown", () => {
    const event = parseEvent({
      type: "interaction_resolved",
      conversationId: "conv-4",
      state: "cancelled",
    });
    expect(event.type).toBe("unknown");
  });

  test("returns unknown event for unrecognized type", () => {
    const data = { type: "some_future_event", foo: "bar" };
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "some_future_event",
      data,
    });
  });

  test("parses sync_changed tags", () => {
    const event = parseEvent({
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
    const event = parseEvent(data);
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
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "sync_changed",
      data,
    });
  });

  test("parses sync_changed with originClientId", () => {
    const event = parseEvent({
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
    const event = parseEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    });
    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    });
    expect("originClientId" in event).toBe(false);
  });

  test("preserves originClientId verbatim and rejects invalid values", () => {
    // GIVEN a non-empty originClientId — the canonical schema keeps it
    // verbatim; the daemon stamps a clean header value, so no trimming.
    const verbatim = parseEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-xyz",
    });
    expect(verbatim).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-xyz",
    });

    // AND an empty originClientId fails the schema's min-length guard, so
    // the whole event falls through to unknown rather than being parsed.
    const empty = parseEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "",
    });
    expect(empty.type).toBe("unknown");

    // AND a non-string originClientId likewise fails validation.
    const nonString = parseEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: 42,
    });
    expect(nonString.type).toBe("unknown");
  });

  test("parses assistant_activity_state idle", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent(data);
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
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_activity_state",
      data,
      conversationId: "conv-1",
    });
  });

  test("parses open_url", () => {
    const event = parseEvent({
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
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "open_url",
      data,
      conversationId: "conv-1",
    });
  });

  test("returns unknown open_url event when url is empty string", () => {
    const data = { type: "open_url", url: "", conversationId: "conv-1" };
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "open_url",
      data,
      conversationId: "conv-1",
    });
  });

  test("parses navigate_settings", () => {
    const event = parseEvent({
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
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "navigate_settings",
      data,
    });
  });

  test("parses open_conversation with all fields (not unknown)", () => {
    const event = parseEvent({
      type: "open_conversation",
      conversationId: "conv-1",
      title: "New conversation",
      anchorMessageId: "msg-42",
      focus: true,
    });
    expect(event).toEqual({
      type: "open_conversation",
      conversationId: "conv-1",
      title: "New conversation",
      anchorMessageId: "msg-42",
      focus: true,
    });
  });

  test("parses open_conversation with only the required conversationId", () => {
    const event = parseEvent({
      type: "open_conversation",
      conversationId: "conv-1",
    });
    expect(event).toEqual({
      type: "open_conversation",
      conversationId: "conv-1",
    });
  });

  test("returns unknown open_conversation event when conversationId is missing", () => {
    const data = { type: "open_conversation", focus: true };
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "open_conversation",
      data,
    });
  });

  describe("disk_pressure_status_changed", () => {
    const criticalStatus: DiskPressureStatus = {
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
      blockedCapabilities: ["agent-turns", "background-work", "remote-ingress"],
      error: null,
    };

    test("parses a critical status verbatim with no conversationId", () => {
      // GIVEN a fully-populated critical disk-pressure snapshot
      // WHEN parsed
      const event = parseEvent({
        type: "disk_pressure_status_changed",
        status: criticalStatus,
      });
      // THEN the nested status round-trips and the global event carries
      // no conversationId (the daemon broadcasts it workspace-wide).
      expect(event).toEqual({
        type: "disk_pressure_status_changed",
        status: criticalStatus,
      });
      expect("conversationId" in event).toBe(false);
    });

    test("parses the warning state (added by canonicalization)", () => {
      // GIVEN a snapshot in the `warning` state — a value the legacy web
      // type omitted but the daemon contract has always emitted.
      const event = parseEvent({
        type: "disk_pressure_status_changed",
        status: { ...criticalStatus, state: "warning" },
      });
      if (event.type !== "disk_pressure_status_changed") {
        throw new Error("expected disk_pressure_status_changed");
      }
      expect(event.status.state).toBe("warning");
    });

    test("parses a disabled status", () => {
      const status: DiskPressureStatus = {
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
      };
      const event = parseEvent({
        type: "disk_pressure_status_changed",
        status,
      });
      expect(event).toEqual({
        type: "disk_pressure_status_changed",
        status,
      });
    });

    test("strips unknown fields (strip-mode) on the event and status", () => {
      // GIVEN unknown fields on both the event and the nested status
      const event = parseEvent({
        type: "disk_pressure_status_changed",
        conversationId: "conv-should-be-stripped",
        status: { ...criticalStatus, futureField: "ignored" },
      });
      // THEN unknown fields are discarded, leaving the canonical shape.
      expect(event).toEqual({
        type: "disk_pressure_status_changed",
        status: criticalStatus,
      });
    });

    test("falls through to unknown for an unrecognised blocked capability", () => {
      // GIVEN a blockedCapabilities entry outside the canonical enum
      const data = {
        type: "disk_pressure_status_changed",
        status: {
          ...criticalStatus,
          blockedCapabilities: ["agent-turns", "unknown-capability"],
        },
      };
      // THEN the schema rejects it and the parser yields an unknown event.
      const event = parseEvent(data);
      expect(event.type).toBe("unknown");
    });

    test("falls through to unknown for a flat (statusless) payload", () => {
      // GIVEN a flat payload with status fields hoisted to the top level —
      // a shape the daemon never emits (it always nests under `status`).
      const event = parseEvent({
        type: "disk_pressure_status_changed",
        ...criticalStatus,
      });
      // THEN the missing `status` object means it parses as unknown.
      expect(event.type).toBe("unknown");
    });
  });

  describe("document_editor_update", () => {
    test("parses a conversation-scoped editor update", () => {
      // GIVEN an inner message carrying its own conversationId
      const event = parseEvent({
        type: "document_editor_update",
        conversationId: "conv-1",
        surfaceId: "surface-1",
        markdown: "# Hello",
        mode: "replace",
      });
      // THEN every field round-trips unchanged
      expect(event).toEqual({
        type: "document_editor_update",
        conversationId: "conv-1",
        surfaceId: "surface-1",
        markdown: "# Hello",
        mode: "replace",
      });
    });

    test("strips unknown fields (strip-mode)", () => {
      const event = parseEvent({
        type: "document_editor_update",
        conversationId: "conv-1",
        surfaceId: "surface-1",
        markdown: "body",
        mode: "append",
        futureField: "ignored",
      });
      expect(event).toEqual({
        type: "document_editor_update",
        conversationId: "conv-1",
        surfaceId: "surface-1",
        markdown: "body",
        mode: "append",
      });
    });

    test("falls through to unknown when conversationId is missing", () => {
      // GIVEN a payload lacking the required conversationId — the parser
      // never grafts the envelope routing key onto a canonical event.
      const event = parseEvent({
        type: "document_editor_update",
        surfaceId: "surface-1",
        markdown: "body",
        mode: "replace",
      });
      expect(event.type).toBe("unknown");
    });
  });

  describe("tool_result", () => {
    test("keeps daemon risk* option names (canonical schema does not rename)", () => {
      const event = parseEvent({
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
        expect(event.riskAllowlistOptions).toEqual([
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
        expect(event.riskDirectoryScopeOptions).toEqual([
          { scope: "/home/user/project", label: "Project directory" },
        ]);
      }
    });

    test("preserves riskScopeOptions (display-only ladder) distinct from the save-path options", () => {
      // riskScopeOptions can carry regex-flavored descriptors that are NOT
      // valid Minimatch trust rule patterns. The consumer deliberately does
      // not feed them into the save path; the schema keeps them as a
      // separate field so that distinction survives on the wire.
      const event = parseEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
        riskScopeOptions: [
          { pattern: "^bash\\(ls.*\\)$", label: "All ls commands" },
        ],
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.riskScopeOptions).toEqual([
          { pattern: "^bash\\(ls.*\\)$", label: "All ls commands" },
        ]);
        expect(event.riskAllowlistOptions).toBeUndefined();
        expect(event.riskDirectoryScopeOptions).toBeUndefined();
      }
    });

    test("leaves risk option fields undefined when absent", () => {
      const event = parseEvent({
        type: "tool_result",
        toolName: "remember",
        result: "saved",
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.riskAllowlistOptions).toBeUndefined();
        expect(event.riskScopeOptions).toBeUndefined();
        expect(event.riskDirectoryScopeOptions).toBeUndefined();
      }
    });

    test("strips unknown top-level fields (e.g. un-prefixed allowlistOptions)", () => {
      // The daemon emits `riskAllowlistOptions`, not the un-prefixed
      // `allowlistOptions` (that field is reserved for confirmation_request).
      // An unknown key is silently dropped by the strip-mode schema.
      const event = parseEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
        allowlistOptions: [{ pattern: "bash(*)", label: "All bash" }],
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.riskAllowlistOptions).toBeUndefined();
        expect(event).not.toHaveProperty("allowlistOptions");
      }
    });

    test("propagates messageId (anchor protocol)", () => {
      const event = parseEvent({
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
      const event = parseEvent({
        type: "tool_result",
        toolName: "bash",
        result: "ok",
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.messageId).toBeUndefined();
      }
    });

    test("returns unknown when a known field has the wrong type", () => {
      const data = {
        type: "tool_result",
        toolName: "bash",
        result: "ok",
        messageId: 42,
      };
      const event = parseEvent(data);
      expect(event).toEqual({
        type: "unknown",
        rawType: "tool_result",
        data,
      });
    });
  });

  describe("tool_use_start", () => {
    test("propagates messageId (anchor protocol)", () => {
      const event = parseEvent({
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
      const event = parseEvent({
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
      const event = parseEvent({
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
      const event = parseEvent({
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
      const event = parseEvent({
        type: "assistant_turn_start",
      });
      expect(event.type).toBe("unknown");
    });

    test("drops to unknown when messageId is non-string", () => {
      const event = parseEvent({
        type: "assistant_turn_start",
        messageId: 42,
      });
      expect(event.type).toBe("unknown");
    });
  });

  describe("user_message_echo", () => {
    test("parses with all fields", () => {
      // GIVEN a user_message_echo carrying the full optional set
      // WHEN parsed
      const event = parseEvent({
        type: "user_message_echo",
        text: "hello",
        conversationId: "conv-1",
        messageId: "msg-1",
        requestId: "req-1",
        clientMessageId: "client-1",
      });
      // THEN every field round-trips through the canonical schema
      expect(event).toEqual({
        type: "user_message_echo",
        text: "hello",
        conversationId: "conv-1",
        messageId: "msg-1",
        requestId: "req-1",
        clientMessageId: "client-1",
      });
    });

    test("parses with only the required text — synthetic echo shape", () => {
      // GIVEN a synthetic echo (surface-action prompt) with no ids
      // WHEN parsed
      const event = parseEvent({
        type: "user_message_echo",
        text: "do the thing",
      });
      // THEN text is preserved and the optional ids are absent
      expect(event.type).toBe("user_message_echo");
      if (event.type === "user_message_echo") {
        expect(event.text).toBe("do the thing");
        expect(event.messageId).toBeUndefined();
        expect(event.conversationId).toBeUndefined();
      }
    });

    test("drops to unknown when text is missing — text is the payload", () => {
      // GIVEN an echo missing its required `text`
      // WHEN parsed
      const event = parseEvent({
        type: "user_message_echo",
        conversationId: "conv-1",
      });
      // THEN it falls back to unknown rather than rendering an empty turn
      expect(event.type).toBe("unknown");
    });

    test("drops to unknown when an unexpected field is present", () => {
      // GIVEN an echo with an extra field the strict schema rejects
      // WHEN parsed
      const event = parseEvent({
        type: "user_message_echo",
        text: "hi",
        unexpected: true,
      });
      // THEN the strict canonical schema declines and it drops to unknown
      expect(event.type).toBe("unknown");
    });
  });

  // ---------------------------------------------------------------------
  // ui_surface_show (schema-validated)
  // ---------------------------------------------------------------------

  test("parses ui_surface_show with all fields", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_show",
      data,
    });
  });

  test("strips unknown fields from ui_surface_show", () => {
    const event = parseEvent({
      type: "ui_surface_show",
      conversationId: "conv-4",
      surfaceId: "s-4",
      surfaceType: "card",
      data: {},
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "ui_surface_show",
      conversationId: "conv-4",
      surfaceId: "s-4",
      surfaceType: "card",
      data: {},
    });
  });

  // ---------------------------------------------------------------------
  // ui_surface_update (schema-validated)
  // ---------------------------------------------------------------------

  test("parses ui_surface_update with all fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_update",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from ui_surface_update", () => {
    const event = parseEvent({
      type: "ui_surface_update",
      conversationId: "conv-1",
      surfaceId: "s-1",
      data: {},
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "ui_surface_update",
      conversationId: "conv-1",
      surfaceId: "s-1",
      data: {},
    });
  });

  // ---------------------------------------------------------------------
  // ui_surface_dismiss (schema-validated)
  // ---------------------------------------------------------------------

  test("parses ui_surface_dismiss with all fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_dismiss",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from ui_surface_dismiss", () => {
    const event = parseEvent({
      type: "ui_surface_dismiss",
      conversationId: "conv-1",
      surfaceId: "s-1",
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "ui_surface_dismiss",
      conversationId: "conv-1",
      surfaceId: "s-1",
    });
  });

  // ---------------------------------------------------------------------
  // ui_surface_complete (schema-validated)
  // ---------------------------------------------------------------------

  test("parses ui_surface_complete with all fields", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "ui_surface_complete",
      data,
      conversationId: "conv-1",
    });
  });

  test("strips unknown fields from ui_surface_complete", () => {
    const event = parseEvent({
      type: "ui_surface_complete",
      conversationId: "conv-1",
      surfaceId: "s-1",
      summary: "Done",
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "ui_surface_complete",
      conversationId: "conv-1",
      surfaceId: "s-1",
      summary: "Done",
    });
  });

  test("parses notification_intent with deep-link metadata", () => {
    const event = parseEvent({
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
    });
  });

  test("notification_intent preserves targetGuardianPrincipalId and silent", () => {
    const event = parseEvent({
      type: "notification_intent",
      sourceEventName: "guardian.question",
      title: "Guardian check-in",
      body: "Approve this request?",
      targetGuardianPrincipalId: "guardian-7",
      silent: true,
    });
    expect(event.type).toBe("notification_intent");
    if (event.type === "notification_intent") {
      expect(event.targetGuardianPrincipalId).toBe("guardian-7");
      expect(event.silent).toBe(true);
    }
  });

  test("notification_intent without title falls through to unknown", () => {
    const event = parseEvent({
      type: "notification_intent",
      sourceEventName: "chat.assistant_turn_complete",
      body: "missing title",
    });
    expect(event.type).toBe("unknown");
  });

  test("notification_intent with non-object deepLinkMetadata falls through to unknown", () => {
    // The strict schema rejects a non-record deepLinkMetadata rather than
    // silently coercing it away, so a malformed payload never reaches the
    // notification handler with broken routing.
    const data = {
      type: "notification_intent",
      sourceEventName: "chat.assistant_turn_complete",
      title: "Hello",
      body: "Body",
      deepLinkMetadata: "not-an-object",
    };
    const event = parseEvent(data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "notification_intent",
      data,
    });
  });

  test("notification_intent strips unknown top-level fields", () => {
    const event = parseEvent({
      type: "notification_intent",
      sourceEventName: "chat.assistant_turn_complete",
      title: "Hello",
      body: "Body",
      unexpectedField: "ignored",
    });
    expect(event).toEqual({
      type: "notification_intent",
      sourceEventName: "chat.assistant_turn_complete",
      title: "Hello",
      body: "Body",
    });
  });

  describe("usage_update", () => {
    test("parses usage_update with all required fields", () => {
      const event = parseEvent({
        type: "usage_update",
        conversationId: "conv-1",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 60,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        estimatedCost: 0.0021,
        model: "claude-sonnet-4",
        contextWindowTokens: 1200,
        contextWindowMaxTokens: 200000,
      });
      expect(event).toEqual({
        type: "usage_update",
        conversationId: "conv-1",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 60,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        estimatedCost: 0.0021,
        model: "claude-sonnet-4",
        contextWindowTokens: 1200,
        contextWindowMaxTokens: 200000,
      });
    });

    test("returns unknown when a required field is missing", () => {
      const data = {
        type: "usage_update",
        conversationId: "conv-1",
        inputTokens: 100,
        outputTokens: 50,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        estimatedCost: 0.0021,
      };
      const event = parseEvent(data);
      expect(event).toEqual({
        type: "unknown",
        rawType: "usage_update",
        data,
        conversationId: "conv-1",
      });
    });

    test("strips unknown top-level fields (e.g. legacy cachedInputTokens) while keeping known cache fields", () => {
      const event = parseEvent({
        type: "usage_update",
        conversationId: "conv-1",
        inputTokens: 100,
        outputTokens: 50,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        estimatedCost: 0.0021,
        model: "claude-sonnet-4",
        cachedInputTokens: 10,
        cacheCreationInputTokens: 5,
      });
      expect(event).toEqual({
        type: "usage_update",
        conversationId: "conv-1",
        inputTokens: 100,
        outputTokens: 50,
        // Part of the canonical schema since the daemon began exposing
        // per-call cache counts — passes through, unlike the legacy
        // cachedInputTokens field above.
        cacheCreationInputTokens: 5,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        estimatedCost: 0.0021,
        model: "claude-sonnet-4",
      });
    });
  });

  describe("usage_progress", () => {
    test("parses usage_progress with all required fields", () => {
      const event = parseEvent({
        type: "usage_progress",
        conversationId: "conv-1",
        inputTokens: 100,
        outputTokens: 50,
        estimatedCost: 0.0021,
        model: "claude-sonnet-4",
      });
      expect(event).toEqual({
        type: "usage_progress",
        conversationId: "conv-1",
        inputTokens: 100,
        outputTokens: 50,
        estimatedCost: 0.0021,
        model: "claude-sonnet-4",
      });
    });

    test("returns unknown when a required field is missing", () => {
      const data = {
        type: "usage_progress",
        conversationId: "conv-1",
        inputTokens: 100,
        outputTokens: 50,
      };
      const event = parseEvent(data);
      expect(event).toEqual({
        type: "unknown",
        rawType: "usage_progress",
        data,
        conversationId: "conv-1",
      });
    });
  });

  // ---------------------------------------------------------------------
  // identity_changed (schema-validated)
  // ---------------------------------------------------------------------

  test("parses identity_changed with all required fields", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "identity_changed",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // avatar_updated (schema-validated)
  // ---------------------------------------------------------------------

  test("parses avatar_updated with avatarPath", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
      const event = parseEvent({
        type: "conversation_list_invalidated",
        reason,
      });
      expect(event).toEqual({ type: "conversation_list_invalidated", reason });
    }
  });

  test("returns unknown conversation_list_invalidated when reason is missing", () => {
    const data = { type: "conversation_list_invalidated" };
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "conversation_list_invalidated",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // conversation_title_updated (schema-validated)
  // ---------------------------------------------------------------------

  test("parses conversation_title_updated with conversationId and title", () => {
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
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
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "secret_request",
      data,
    });
  });

  test("strips unknown fields from secret_request", () => {
    const event = parseEvent({
      type: "secret_request",
      requestId: "sr-4",
      service: "openai",
      field: "api_key",
      label: "Extra",
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "secret_request",
      requestId: "sr-4",
      service: "openai",
      field: "api_key",
      label: "Extra",
    });
  });

  // ---------------------------------------------------------------------
  // confirmation_request (schema-validated)
  // ---------------------------------------------------------------------

  test("parses confirmation_request with all fields", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "confirmation_request",
      data,
    });
  });

  test("strips unknown fields from confirmation_request", () => {
    const event = parseEvent({
      type: "confirmation_request",
      requestId: "cr-4",
      toolName: "bash",
      input: {},
      riskLevel: "low",
      allowlistOptions: [],
      scopeOptions: [],
      title: "Allow?",
    });
    expect(event).toEqual({
      type: "confirmation_request",
      requestId: "cr-4",
      toolName: "bash",
      input: {},
      riskLevel: "low",
      allowlistOptions: [],
      scopeOptions: [],
    });
  });

  // ---------------------------------------------------------------------
  // contact_request (schema-validated)
  // ---------------------------------------------------------------------

  test("parses contact_request with all fields", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "contact_request",
      data,
    });
  });

  test("strips unknown fields from contact_request", () => {
    const event = parseEvent({
      type: "contact_request",
      requestId: "ctc-3",
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "contact_request",
      requestId: "ctc-3",
    });
  });

  // ---------------------------------------------------------------------
  // question_request (schema-validated)
  // ---------------------------------------------------------------------

  test("parses question_request with all fields", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "question_request",
      data,
    });
  });

  test("strips unknown fields from question_request", () => {
    const event = parseEvent({
      type: "question_request",
      requestId: "qr-4",
      questions: [{ id: "q1", question: "?", options: [] }],
      question: "?",
      options: [],
      surpriseField: "boom",
    });
    expect(event).toEqual({
      type: "question_request",
      requestId: "qr-4",
      questions: [{ id: "q1", question: "?", options: [] }],
      question: "?",
      options: [],
    });
  });

  // ---------------------------------------------------------------------
  // subagent_spawned (schema-validated)
  // ---------------------------------------------------------------------

  test("parses subagent_spawned with all fields", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_spawned",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // subagent_status_changed (schema-validated)
  // ---------------------------------------------------------------------

  test("parses subagent_status_changed with all fields", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_status_changed",
      data,
    });
  });

  // ---------------------------------------------------------------------
  // subagent_event (schema-validated)
  // ---------------------------------------------------------------------

  test("parses subagent_event wrapping an inner event", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    expect(parseEvent(data)).toEqual({
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
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "subagent_event",
      data,
      conversationId: "conv-4",
    });
  });
});

describe("tool_use_preview_start (schema-validated)", () => {
  test("parses tool_use_preview_start with all fields", () => {
    const event = parseEvent({
      type: "tool_use_preview_start",
      toolUseId: "toolu_01",
      toolName: "bash",
      conversationId: "conv-1",
      messageId: "asst-msg-1",
    });
    expect(event).toEqual({
      type: "tool_use_preview_start",
      toolUseId: "toolu_01",
      toolName: "bash",
      conversationId: "conv-1",
      messageId: "asst-msg-1",
    });
  });

  test("parses tool_use_preview_start with only required fields", () => {
    const event = parseEvent({
      type: "tool_use_preview_start",
      toolUseId: "toolu_02",
      toolName: "bash",
    });
    expect(event).toEqual({
      type: "tool_use_preview_start",
      toolUseId: "toolu_02",
      toolName: "bash",
    });
  });

  test("returns unknown tool_use_preview_start when toolName is missing", () => {
    const data = {
      type: "tool_use_preview_start",
      toolUseId: "toolu_03",
      conversationId: "conv-3",
    };
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "tool_use_preview_start",
      data,
      conversationId: "conv-3",
    });
  });

  test("strips unknown fields from tool_use_preview_start", () => {
    const event = parseEvent({
      type: "tool_use_preview_start",
      toolUseId: "toolu_04",
      toolName: "bash",
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "tool_use_preview_start",
      toolUseId: "toolu_04",
      toolName: "bash",
    });
  });
});

describe("tool_output_chunk (schema-validated)", () => {
  test("parses tool_output_chunk with all fields", () => {
    const event = parseEvent({
      type: "tool_output_chunk",
      chunk: "stdout line\n",
      conversationId: "conv-1",
      toolUseId: "toolu_01",
      subType: "tool_start",
      subToolName: "grep",
      subToolInput: "pattern",
      subToolIsError: false,
      subToolId: "sub-1",
      messageId: "asst-msg-1",
    });
    expect(event).toEqual({
      type: "tool_output_chunk",
      chunk: "stdout line\n",
      conversationId: "conv-1",
      toolUseId: "toolu_01",
      subType: "tool_start",
      subToolName: "grep",
      subToolInput: "pattern",
      subToolIsError: false,
      subToolId: "sub-1",
      messageId: "asst-msg-1",
    });
  });

  test("parses tool_output_chunk with only required fields", () => {
    const event = parseEvent({
      type: "tool_output_chunk",
      chunk: "partial output",
    });
    expect(event).toEqual({
      type: "tool_output_chunk",
      chunk: "partial output",
    });
  });

  test("returns unknown tool_output_chunk when chunk is missing", () => {
    const data = {
      type: "tool_output_chunk",
      conversationId: "conv-3",
      toolUseId: "toolu_03",
    };
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "tool_output_chunk",
      data,
      conversationId: "conv-3",
    });
  });

  test("returns unknown tool_output_chunk when subType is not a known value", () => {
    const data = {
      type: "tool_output_chunk",
      chunk: "x",
      conversationId: "conv-4",
      subType: "not_a_real_subtype",
    };
    expect(parseEvent(data)).toEqual({
      type: "unknown",
      rawType: "tool_output_chunk",
      data,
      conversationId: "conv-4",
    });
  });

  test("strips unknown fields from tool_output_chunk", () => {
    const event = parseEvent({
      type: "tool_output_chunk",
      chunk: "y",
      legacyField: "x",
    });
    expect(event).toEqual({
      type: "tool_output_chunk",
      chunk: "y",
    });
  });
});

describe("envelope format parsing", () => {
  test("flat payloads pass through unchanged", () => {
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent({
      type: "message_complete",
      messageId: "msg-flat",
    });

    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-flat",
    });
  });

  test("flat sync_changed works when no envelope message field is present", () => {
    const event = parseEvent({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantSounds],
    });

    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantSounds],
    });
  });

  test("non-object message field is ignored (falls back to flat)", () => {
    const event = parseEvent({
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

  test("envelope conversationId is NOT grafted onto a conversation-scoped canonical event", () => {
    // `document_editor_update` declares `conversationId` as required on the
    // inner message. When the inner omits it, the parser does NOT rescue the
    // event with the envelope-level routing key — it falls through to unknown.
    // This is the drift `@vellumai/assistant-api` exists to prevent.
    const event = parseEvent({
      conversationId: "conv-from-envelope",
      message: {
        type: "document_editor_update",
        surfaceId: "surface-1",
        markdown: "# Hello",
        mode: "replace",
      },
    });
    expect(event.type).toBe("unknown");
  });

  test("a conversation-scoped event reads its own inner conversationId", () => {
    // When the inner message carries its own conversationId, the canonical
    // schema reads it directly; the envelope-level routing key is never used.
    const event = parseEvent({
      conversationId: "envelope-conv",
      message: {
        type: "document_editor_update",
        surfaceId: "surface-1",
        markdown: "# Hello",
        mode: "replace",
        conversationId: "event-conv",
      },
    });
    if (event.type !== "document_editor_update") {
      throw new Error("expected document_editor_update");
    }
    expect(event.conversationId).toBe("event-conv");
  });

  test("envelope-level conversationId is NOT stamped onto strict-schema events", () => {
    // relationship_state_updated is a global event whose strict wire schema
    // doesn't declare conversationId. Stamping the envelope-derived value
    // onto it is the drift `@vellumai/assistant-api` exists to prevent.
    const event = parseEvent({
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
    const event = parseEvent({
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
    const event = parseEvent({
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
// ConversationMessage wire shape
// ---------------------------------------------------------------------------

describe("ConversationMessage wire shape", () => {
  test("ConversationMessage carries wire-shape content fields", () => {
    // Type-level test: the canonical wire contract encodes textSegments as
    // plain strings and contentOrder as positional "<type>:<index>" strings.
    const msg: import("@vellumai/assistant-api").ConversationMessage = {
      id: "msg-1",
      role: "assistant",
      timestamp: "2024-01-01T00:00:00.000Z",
      attachments: [],
      surfaces: [
        {
          surfaceId: "s-1",
          surfaceType: "card",
          data: { title: "Test" },
        },
      ],
      textSegments: ["Hello"],
      contentOrder: ["text:0", "surface:0"],
    };
    expect(msg.surfaces).toHaveLength(1);
    expect(msg.textSegments).toHaveLength(1);
    expect(msg.contentOrder).toHaveLength(2);
  });

  test("ConversationMessage works with only the required fields", () => {
    const msg: import("@vellumai/assistant-api").ConversationMessage = {
      id: "msg-2",
      role: "user",
      timestamp: "2024-01-01T00:00:00.000Z",
      attachments: [],
    };
    expect(msg.surfaces).toBeUndefined();
    expect(msg.textSegments).toBeUndefined();
    expect(msg.contentOrder).toBeUndefined();
  });
});

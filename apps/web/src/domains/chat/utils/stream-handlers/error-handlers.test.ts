import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleStreamError,
  handleConversationErrorEvent,
} from "@/domains/chat/utils/stream-handlers/error-handlers";

describe("handleStreamError", () => {
  it("ends the turn with reason=error, sets error, cancels stream", () => {
    const ctx = makeCtx();
    handleStreamError({ type: "error", message: "Something went wrong." }, ctx);
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-1",
      reason: "error",
    });
    expect(ctx.setError).toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).toHaveBeenCalled();
  });

  it("removes orphaned preview tool calls before tearing down the stream", () => {
    // The teardown below kills the SSE connection before the daemon's idle
    // activity event arrives, so the idle-time preview cleanup never runs.
    const ctx = makeCtx();
    handleStreamError({ type: "error", message: "boom" }, ctx);

    const updater = (
      ctx.setMessages as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0]![0] as (
      prev: Array<{
        role: string;
        toolCalls?: Array<{ id: string; isPreview?: boolean }>;
      }>,
    ) => Array<{ toolCalls?: Array<{ id: string }> }>;
    const next = updater([
      {
        role: "assistant",
        toolCalls: [
          { id: "tc-real" },
          { id: "tc-preview", isPreview: true },
        ],
      },
    ]);
    expect(next[0]!.toolCalls!.map((tc) => tc.id)).toEqual(["tc-real"]);
  });
});

describe("handleConversationErrorEvent", () => {
  it("ends the turn with reason=error and sets the error notice", () => {
    const ctx = makeCtx();
    handleConversationErrorEvent(
      {
        type: "conversation_error",
        conversationId: "conv-1",
        code: "PROVIDER_RATE_LIMIT",
        userMessage: "Rate limited",
        retryable: true,
      },
      ctx,
    );
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-1",
      reason: "error",
    });
    expect(ctx.setError).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("prefers event.conversationId over streamContext when both differ", () => {
    // Mirror of the same guarantee in `handleMessageComplete` and
    // `handleGenerationCancelled`: a stream teardown that races the
    // error event can clear streamContext, but the event itself
    // carries the canonical id and must drive the cleanup.
    const ctx = makeCtx({
      streamContext: null,
    });
    handleConversationErrorEvent(
      {
        type: "conversation_error",
        conversationId: "conv-from-event",
        code: "PROVIDER_RATE_LIMIT",
        userMessage: "Rate limited",
        retryable: true,
      },
      ctx,
    );
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-from-event",
      reason: "error",
    });
  });
});

import { describe, expect, it, mock } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleStreamError,
  handleConversationErrorEvent,
} from "@/domains/chat/utils/stream-handlers/error-handlers";

describe("handleStreamError", () => {
  it("ends the turn with reason=error, sets error, cancels stream", () => {
    const cancelFn = mock(() => {});
    const ctx = makeCtx({
      streamRef: { current: { cancel: cancelFn } as never },
    });
    handleStreamError(
      { type: "error", message: "Something went wrong." },
      ctx,
    );
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-1",
      reason: "error",
    });
    expect(ctx.setError).toHaveBeenCalled();
    expect(cancelFn).toHaveBeenCalled();
    expect(ctx.streamRef.current).toBeNull();
  });
});

describe("handleConversationErrorEvent", () => {
  it("ends the turn with reason=error and sets the error notice", () => {
    const ctx = makeCtx();
    handleConversationErrorEvent(
      {
        type: "conversation_error",
        conversationId: "conv-1",
        code: "rate_limit",
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

  it("prefers event.conversationId over streamContextRef when both differ", () => {
    // Mirror of the same guarantee in `handleMessageComplete` and
    // `handleGenerationCancelled`: a stream teardown that races the
    // error event can clear `streamContextRef.current`, but the event
    // itself carries the canonical id and must drive the cleanup.
    const ctx = makeCtx({
      streamContextRef: { current: null },
    });
    handleConversationErrorEvent(
      {
        type: "conversation_error",
        conversationId: "conv-from-event",
        code: "rate_limit",
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

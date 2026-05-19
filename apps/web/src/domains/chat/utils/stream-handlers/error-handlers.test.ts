import { describe, expect, it, mock } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers.js";
import {
  handleStreamError,
  handleConversationErrorEvent,
} from "@/domains/chat/utils/stream-handlers/error-handlers.js";

describe("handleStreamError", () => {
  it("sets error, cancels stream, and clears processing", () => {
    const cancelFn = mock(() => {});
    const ctx = makeCtx({
      streamRef: { current: { cancel: cancelFn } as never },
    });
    handleStreamError(
      { type: "error", message: "Something went wrong." },
      ctx,
    );
    expect(ctx.dispatchTurn).toHaveBeenCalledWith({
      type: "STREAM_ERROR",
    });
    expect(ctx.clearProcessingKey).toHaveBeenCalledWith("conv-1");
    expect(ctx.setError).toHaveBeenCalled();
    expect(cancelFn).toHaveBeenCalled();
    expect(ctx.streamRef.current).toBeNull();
  });
});

describe("handleConversationErrorEvent", () => {
  it("sets error and dispatches STREAM_ERROR", () => {
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
    expect(ctx.dispatchTurn).toHaveBeenCalledWith({
      type: "STREAM_ERROR",
    });
    expect(ctx.setError).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });
});

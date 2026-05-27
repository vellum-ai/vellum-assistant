import { describe, expect, it, mock } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleStreamError,
  handleConversationErrorEvent,
} from "@/domains/chat/utils/stream-handlers/error-handlers";

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
    expect(ctx.turnActions.onStreamError).toHaveBeenCalled();
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
    expect(ctx.turnActions.onStreamError).toHaveBeenCalled();
    expect(ctx.setError).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });
});

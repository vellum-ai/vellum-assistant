import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleStreamError,
  handleConversationErrorEvent,
  handleConversationNoticeEvent,
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

describe("handleConversationNoticeEvent", () => {
  it("sets a non-terminal notice without ending the turn", () => {
    const ctx = makeCtx();
    handleConversationNoticeEvent(
      {
        type: "conversation_notice",
        conversationId: "conv-1",
        source: "memory_v3",
        code: "PROVIDER_BILLING",
        userMessage: "You've run out of credits.",
        errorCategory: "credits_exhausted",
      },
      ctx,
    );

    expect(ctx.setNotice).toHaveBeenCalledWith({
      message: "You've run out of credits.",
      code: "PROVIDER_BILLING",
      errorCategory: "credits_exhausted",
    });
    expect(ctx.endTurn).not.toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).not.toHaveBeenCalled();
    expect(ctx.setError).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import type { DisplayMessage } from "@/domains/chat/types/types";
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

  it("recovers the send a full queue refused without ending the turn", () => {
    // A full queue refusing a send the daemon had already accepted is a
    // delivery failure for one message, not a turn ending: the conversation may
    // still be running the turn this send tried to interrupt.
    const ctx = makeCtx({
      requestIdToMessageId: new Map([["req-1", "cmid-1"]]),
    });

    handleStreamError(
      {
        type: "error",
        code: "QUEUE_FULL",
        requestId: "req-1",
        message: "The assistant couldn't take your message.",
      },
      ctx,
    );

    // Not a turn ending, so none of the terminal-error teardown runs.
    expect(ctx.endTurn).not.toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).not.toHaveBeenCalled();
    expect(ctx.setError).toHaveBeenCalled();

    // The optimistic row is dropped so nothing dangles unsent.
    expect(ctx.setOptimisticSends).toHaveBeenCalled();
    const updater = ((ctx.setOptimisticSends as unknown) as ReturnType<
      typeof Object
    >).mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];
    const remaining = updater([
      { id: "cmid-1", role: "user", textSegments: ["hello"] } as DisplayMessage,
      { id: "other", role: "user" } as DisplayMessage,
    ]);
    expect(remaining.map((m) => m.id)).toEqual(["other"]);
  });

  it("leaves a generic error on its terminal path", () => {
    // Only the correlated delivery failure takes the recovery path; anything
    // else still ends the turn.
    const ctx = makeCtx();
    handleStreamError(
      { type: "error", code: "QUEUE_FULL", message: "no request id" },
      ctx,
    );
    expect(ctx.endTurn).toHaveBeenCalled();
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

  it("keeps the stream alive for a daily-limit billing error (banner only)", () => {
    const ctx = makeCtx();
    handleConversationErrorEvent(
      {
        type: "conversation_error",
        conversationId: "conv-1",
        code: "PROVIDER_BILLING",
        errorCategory: "daily_limit_reached",
        userMessage: "Daily credit limit reached",
        retryable: false,
      },
      ctx,
    );
    expect(ctx.setError).toHaveBeenCalledWith({
      message: "Daily credit limit reached",
      code: "PROVIDER_BILLING",
      errorCategory: "daily_limit_reached",
    });
    // Billing banner errors are surfaced inline without tearing down the stream.
    expect(ctx.cancelAndClearStream).not.toHaveBeenCalled();
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

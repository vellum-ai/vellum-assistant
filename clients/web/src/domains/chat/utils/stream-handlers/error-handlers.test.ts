import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
} from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { ChatError } from "@/domains/chat/types";
import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";
import {
  handleStreamError,
  handleConversationErrorEvent,
  handleConversationNoticeEvent,
} from "@/domains/chat/utils/stream-handlers/error-handlers";
import { conversationListQueryKey } from "@/utils/conversation-list-keys";
import { findConversation } from "@/utils/conversation-cache";
import { listPage } from "@/utils/conversation-list.test-helper";

describe("handleStreamError", () => {
  const optimisticSend: DisplayMessage = {
    id: "client-1",
    clientMessageId: "client-1",
    isOptimistic: true,
    role: "user",
    contentBlocks: [{ type: "text", text: "the batched send" }],
  };
  const failedAttachment: DisplayAttachment = {
    id: "att-1",
    filename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    previewUrl: null,
  };
  const optimisticSendWithAttachment: DisplayMessage = {
    ...optimisticSend,
    attachments: [failedAttachment],
  };

  // The message-scoped branch reads the real chat-session store to find the
  // row the failing nonce belongs to. Reset it around each case.
  beforeEach(() => {
    useChatSessionStore.setState({ optimisticSends: [] });
  });
  afterEach(() => {
    useChatSessionStore.setState({ optimisticSends: [] });
  });

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

  it("clears the cached isProcessing flag when the error names no message", () => {
    const ctx = makeCtx();
    ctx.queryClient.setQueryData(
      conversationListQueryKey("ast-1"),
      listPage([{ conversationId: "conv-1", isProcessing: true }]),
    );

    handleStreamError({ type: "error", message: "Something went wrong." }, ctx);

    expect(
      findConversation(ctx.queryClient, "ast-1", "conv-1")?.isProcessing,
    ).toBe(false);
  });

  it("stays terminal for an error scoped to the turn", () => {
    const ctx = makeCtx();
    ctx.queryClient.setQueryData(
      conversationListQueryKey("ast-1"),
      listPage([{ conversationId: "conv-1", isProcessing: true }]),
    );

    handleStreamError(
      { type: "error", message: "Something went wrong.", scope: "turn" },
      ctx,
    );

    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-1",
      reason: "error",
    });
    expect(ctx.setError).toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).toHaveBeenCalled();
    expect(
      findConversation(ctx.queryClient, "ast-1", "conv-1")?.isProcessing,
    ).toBe(false);
  });

  it("marks only the named send failed and leaves the running turn alone", () => {
    // GIVEN a queued batch member this tab still renders as an optimistic row,
    // holding the only client-side copy of what it was sent with
    useChatSessionStore.setState({
      optimisticSends: [optimisticSendWithAttachment],
    });
    const ctx = makeCtx();
    ctx.queryClient.setQueryData(
      conversationListQueryKey("ast-1"),
      listPage([{ conversationId: "conv-1", isProcessing: true }]),
    );

    // WHEN the daemon reports it could not persist that one message
    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-1",
      },
      ctx,
    );

    // THEN the row comes out of the transcript with its text and attachments
    // offered back
    expect(ctx.setOptimisticSends).toHaveBeenCalled();
    const updater = (
      ctx.setOptimisticSends as unknown as ReturnType<typeof Object>
    ).mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];
    expect(updater([optimisticSendWithAttachment])).toEqual([]);
    expect(ctx.setError).toHaveBeenCalledWith({
      message: "Failed to persist message.",
      code: undefined,
      errorCategory: undefined,
      displayAs: "modal",
      restoreContent: "the batched send",
      restoreAttachments: [failedAttachment],
    });

    // AND the reply the batch is still generating keeps streaming
    expect(ctx.endTurn).not.toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).not.toHaveBeenCalled();
    expect(
      findConversation(ctx.queryClient, "ast-1", "conv-1")?.isProcessing,
    ).toBe(true);
  });

  it("offers no attachments back for a send that carried none", () => {
    useChatSessionStore.setState({ optimisticSends: [optimisticSend] });
    const ctx = makeCtx();

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-1",
      },
      ctx,
    );

    const setErrorArg = (
      ctx.setError as unknown as Mock<(error: ChatError) => void>
    ).mock.calls[0][0];
    expect(setErrorArg.restoreContent).toBe("the batched send");
    expect(setErrorArg).not.toHaveProperty("restoreAttachments");
  });

  it("treats a nonce with no scope as the message's, not the turn's", () => {
    // A daemon that correlates by nonce alone still gets the message-scoped
    // path: the nonce names the one send that failed.
    useChatSessionStore.setState({ optimisticSends: [optimisticSend] });
    const ctx = makeCtx();

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        clientMessageId: "client-1",
      },
      ctx,
    );

    expect(ctx.setOptimisticSends).toHaveBeenCalled();
    expect(ctx.setError).toHaveBeenCalledWith({
      message: "Failed to persist message.",
      code: undefined,
      errorCategory: undefined,
      displayAs: "modal",
      restoreContent: "the batched send",
    });
    expect(ctx.endTurn).not.toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).not.toHaveBeenCalled();
  });

  it("keeps the turn alive for a message-scoped error that carries no nonce", () => {
    // A sender that omits `clientMessageId` leaves nothing to correlate with,
    // so the scope alone has to keep the failure off the terminal path.
    useChatSessionStore.setState({ optimisticSends: [optimisticSend] });
    const ctx = makeCtx();
    ctx.queryClient.setQueryData(
      conversationListQueryKey("ast-1"),
      listPage([{ conversationId: "conv-1", isProcessing: true }]),
    );

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
      },
      ctx,
    );

    expect(ctx.setNotice).toHaveBeenCalledWith({
      message: "Failed to persist message.",
      code: undefined,
      errorCategory: undefined,
    });
    expect(ctx.setError).not.toHaveBeenCalled();
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
    expect(ctx.endTurn).not.toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).not.toHaveBeenCalled();
    expect(
      findConversation(ctx.queryClient, "ast-1", "conv-1")?.isProcessing,
    ).toBe(true);
  });

  it("surfaces a notice and nothing else for a message this tab has no row for", () => {
    // Another client's queued send failed to persist: nothing local to roll
    // back, and the turn on screen is not this message's.
    const ctx = makeCtx();
    ctx.queryClient.setQueryData(
      conversationListQueryKey("ast-1"),
      listPage([{ conversationId: "conv-1", isProcessing: true }]),
    );

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        clientMessageId: "client-elsewhere",
      },
      ctx,
    );

    expect(ctx.setNotice).toHaveBeenCalledWith({
      message: "Failed to persist message.",
      code: undefined,
      errorCategory: undefined,
    });
    expect(ctx.setError).not.toHaveBeenCalled();
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
    expect(ctx.endTurn).not.toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).not.toHaveBeenCalled();
    expect(
      findConversation(ctx.queryClient, "ast-1", "conv-1")?.isProcessing,
    ).toBe(true);
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

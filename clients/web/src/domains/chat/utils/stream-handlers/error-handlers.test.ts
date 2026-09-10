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
import { failedSendFor, useComposerStore } from "@/domains/chat/composer-store";
import type { ChatError } from "@/domains/chat/types";
import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";
import {
  handleMessageFailed,
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
  // row the failing nonce belongs to, and hands its message to the real
  // composer store. Reset both around each case.
  beforeEach(() => {
    useChatSessionStore.setState({ optimisticSends: [] });
    useComposerStore.setState({
      failedSendsByConversation: new Map(),
      queuedSends: new Map(),
    });
  });
  afterEach(() => {
    useChatSessionStore.setState({ optimisticSends: [] });
    useComposerStore.setState({
      failedSendsByConversation: new Map(),
      queuedSends: new Map(),
    });
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
    handleMessageFailed(
      {
        type: "message_failed",
        message: "Failed to persist message.",
        requestId: "request-1",
        clientMessageId: "client-1",
        conversationId: "conv-1",
      },
      ctx,
    );

    // THEN the row comes out of the transcript, its text and attachments held
    // for the conversation it was composed for, and the modal only tells the
    // user
    expect(ctx.setOptimisticSends).toHaveBeenCalled();
    const updater = (
      ctx.setOptimisticSends as unknown as ReturnType<typeof Object>
    ).mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];
    expect(updater([optimisticSendWithAttachment])).toEqual([]);
    expect(
      failedSendFor(useComposerStore.getState(), "ast-1", "conv-1"),
    ).toEqual({
      content: "the batched send",
      attachments: [failedAttachment],
    });
    expect(ctx.setError).toHaveBeenCalledWith({
      message: "Failed to persist message.",
      code: undefined,
      errorCategory: undefined,
      displayAs: "modal",
      conversationId: "conv-1",
    });

    // AND the reply the batch is still generating keeps streaming
    expect(ctx.endTurn).not.toHaveBeenCalled();
    expect(ctx.cancelAndClearStream).not.toHaveBeenCalled();
    expect(
      findConversation(ctx.queryClient, "ast-1", "conv-1")?.isProcessing,
    ).toBe(true);
  });

  it("holds the message for the conversation the failed send belonged to", () => {
    // The composer on screen when the failure lands can belong to another
    // thread, so the message goes to its own conversation rather than to
    // whichever composer is up.
    useChatSessionStore.setState({
      optimisticSends: [optimisticSendWithAttachment],
    });
    const ctx = makeCtx();

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-1",
        conversationId: "conv-batched",
      },
      ctx,
    );

    expect(
      failedSendFor(useComposerStore.getState(), "ast-1", "conv-batched"),
    ).toEqual({
      content: "the batched send",
      attachments: [failedAttachment],
    });
    expect(ctx.setError).toHaveBeenCalledWith({
      message: "Failed to persist message.",
      code: undefined,
      errorCategory: undefined,
      displayAs: "modal",
      conversationId: "conv-batched",
    });
  });

  it("keeps both messages when one dequeued batch fails two of its members", () => {
    // Both failures arrive before the user can answer the first modal, so
    // neither can be waiting on that answer to be handed over.
    useChatSessionStore.setState({
      optimisticSends: [
        optimisticSendWithAttachment,
        {
          id: "client-2",
          clientMessageId: "client-2",
          isOptimistic: true,
          role: "user",
          contentBlocks: [{ type: "text", text: "the second send" }],
        },
      ],
    });
    const ctx = makeCtx();

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-1",
        conversationId: "conv-batched",
      },
      ctx,
    );
    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-2",
        conversationId: "conv-batched",
      },
      ctx,
    );

    expect(
      failedSendFor(useComposerStore.getState(), "ast-1", "conv-batched"),
    ).toEqual({
      content: "the batched send\n\nthe second send",
      attachments: [failedAttachment],
    });
  });

  it("names no conversation when the event carries none", () => {
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
    expect(setErrorArg).not.toHaveProperty("conversationId");
    expect(useComposerStore.getState().failedSendsByConversation.size).toBe(0);
  });

  it("holds an empty attachment list for a send that carried none", () => {
    useChatSessionStore.setState({ optimisticSends: [optimisticSend] });
    const ctx = makeCtx();

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-1",
        conversationId: "conv-1",
      },
      ctx,
    );

    expect(
      failedSendFor(useComposerStore.getState(), "ast-1", "conv-1"),
    ).toEqual({ content: "the batched send", attachments: [] });
  });

  it("spends the queued copy of a send its row answered for", () => {
    useChatSessionStore.setState({
      optimisticSends: [optimisticSendWithAttachment],
    });
    useComposerStore.getState().recordQueuedSend("client-1", {
      assistantId: "assistant-1",
      conversationId: "conv-1",
      content: "the batched send",
      attachments: [failedAttachment],
    });
    const ctx = makeCtx();

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-1",
        conversationId: "conv-1",
      },
      ctx,
    );

    // Held once, from the row, and the copy that would have held it a second
    // time is gone.
    expect(
      failedSendFor(useComposerStore.getState(), "ast-1", "conv-1"),
    ).toEqual({
      content: "the batched send",
      attachments: [failedAttachment],
    });
    expect(useComposerStore.getState().queuedSends.has("client-1")).toBe(false);
  });

  it("falls back to the queued copy when no row is left to name the message", () => {
    // The row this tab painted is gone (a resync, or a switch that cleared the
    // transcript), so the copy `useSendMessage` kept is the message.
    useComposerStore.getState().recordQueuedSend("client-1", {
      assistantId: "assistant-1",
      conversationId: "conv-queued",
      content: "parked behind the running turn",
      attachments: [failedAttachment],
    });
    const ctx = makeCtx();

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-1",
        conversationId: "conv-queued",
      },
      ctx,
    );

    expect(
      failedSendFor(useComposerStore.getState(), "assistant-1", "conv-queued"),
    ).toEqual({
      content: "parked behind the running turn",
      attachments: [failedAttachment],
    });
    expect(useComposerStore.getState().queuedSends.has("client-1")).toBe(false);
    // The user is told, as they are for a failure with a row, rather than left
    // with the banner a send this tab knows nothing about gets.
    expect(ctx.setError).toHaveBeenCalledWith({
      message: "Failed to persist message.",
      code: undefined,
      errorCategory: undefined,
      displayAs: "modal",
      conversationId: "conv-queued",
    });
    expect(ctx.setNotice).not.toHaveBeenCalled();
    // No row means nothing to take out of the transcript.
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });

  it("puts no message back on the modal itself", () => {
    useChatSessionStore.setState({
      optimisticSends: [optimisticSendWithAttachment],
    });
    const ctx = makeCtx();

    handleStreamError(
      {
        type: "error",
        message: "Failed to persist message.",
        scope: "message",
        clientMessageId: "client-1",
        conversationId: "conv-1",
      },
      ctx,
    );

    const setErrorArg = (
      ctx.setError as unknown as Mock<(error: ChatError) => void>
    ).mock.calls[0][0];
    expect(setErrorArg).not.toHaveProperty("restoreContent");
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

  it("surfaces a notice and nothing else for a message this tab holds nothing for", () => {
    // Another client's queued send failed to persist: no row and no copy of
    // this tab's to roll back, and the turn on screen is not this message's.
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
    const updater = (
      ctx.setOptimisticSends as unknown as ReturnType<typeof Object>
    ).mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];
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

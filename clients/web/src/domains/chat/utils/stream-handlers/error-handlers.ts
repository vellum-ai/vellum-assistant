import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { ERROR_MESSAGES } from "@/domains/chat/utils/chat";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { messageMatchesKey } from "@/domains/chat/utils/message-identity";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { isMessageScopedError } from "@/domains/chat/utils/message-scoped-error";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import { patchConversation } from "@/utils/conversation-cache";
import { removeQueuedMessage } from "@/domains/chat/utils/stream-updaters/shared";
import { useComposerStore } from "@/domains/chat/composer-store";
import type {
  ConversationErrorEvent,
  ConversationNoticeEvent,
  ErrorEvent,
} from "@vellumai/assistant-api";

function resolveErrorDetail(event: ErrorEvent): string {
  return (
    (event.code && ERROR_MESSAGES[event.code]) ||
    event.message ||
    "Something went wrong."
  );
}

/**
 * `isMessageScopedError` is the one place that decides what an error belongs
 * to. A message-scoped error is one message's failure rather than the turn's:
 * a queued batch member the daemon could not persist while the batch it was
 * dequeued with runs on, so the turn on screen keeps streaming and only that
 * send is marked failed. Everything else is the turn's terminal error.
 */
export function handleStreamError(
  event: ErrorEvent,
  ctx: StreamHandlerContext,
): void {
  const { clientMessageId } = event;
  if (isMessageScopedError(event)) {
    handleMessageScopedError(event, clientMessageId, ctx);
    return;
  }
  const convId = ctx.streamContext?.conversationId;

  // A full queue refusing a send the daemon had already accepted. It is a
  // delivery failure for one message, not a turn ending: the conversation may
  // still be running the turn this send tried to interrupt, so this must not
  // clear `isProcessing` or end the turn the way a generation error does.
  // Recovery matches the request-path failure in `use-send-message`: drop the
  // optimistic row and put its text back in the composer, so the user has what
  // they typed and can send it again.
  if (event.code === "QUEUE_FULL" && event.requestId) {
    const messageId = ctx.popRequestIdMapping(event.requestId);
    if (messageId) {
      ctx.setOptimisticSends((prev) => {
        const failed = prev.find((message) =>
          messageMatchesKey(message, messageId),
        );
        const text = failed?.textSegments?.join("");
        if (text && ctx.assistantId && convId) {
          useComposerStore
            .getState()
            .restoreFailedDraft(ctx.assistantId, convId, text);
        }
        return removeQueuedMessage(prev, messageId);
      });
    }
    ctx.setError({
      message: event.message || "Something went wrong.",
      code: event.code,
      ...(event.errorCategory ? { errorCategory: event.errorCategory } : {}),
    });
    return;
  }

  if (convId) {
    // Mirrors the cache patch in `handleMessageComplete`: terminal
    // errors must also clear the cached `isProcessing: true` snapshot
    // so the OR derivation in chat-route-content can't latch.
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  ctx.endTurn({ conversationId: convId, reason: "error" });
  ctx.setError({
    message: resolveErrorDetail(event),
    code: event.code,
    errorCategory: event.errorCategory,
  });
  ctx.cancelAndClearStream();
}

/**
 * The one message's failure: no `endTurn`, no `isProcessing` patch, no stream
 * cancel, because the turn the batch is running is still generating a reply.
 * The rollback needs the nonce to know which optimistic row failed; without one
 * the failure is still the message's, it just has no local row to name.
 */
function handleMessageScopedError(
  event: ErrorEvent,
  clientMessageId: string | undefined,
  ctx: StreamHandlerContext,
): void {
  const detail = resolveErrorDetail(event);
  const failedSend = clientMessageId
    ? useChatSessionStore
        .getState()
        .optimisticSends.find((m) => messageMatchesKey(m, clientMessageId))
    : undefined;

  if (!clientMessageId || !failedSend) {
    // A send that carries no nonce, another client's send, or one this tab
    // holds no row for. There is nothing local to roll back, so the failure
    // goes to the non-terminal channel `handleConversationNoticeEvent` uses: a
    // warning banner in the composer area that leaves the turn and the stream
    // alone.
    ctx.setNotice({
      message: detail,
      code: event.code,
      errorCategory: event.errorCategory,
    });
    return;
  }

  // The daemon never persisted this message, so the optimistic row is the only
  // place it exists and it comes back out. `setError` with `displayAs: "modal"`
  // and `restoreContent` is the rejected-POST affordance from
  // `use-send-message`: the user is told the send failed and gets the text back
  // in the composer when they acknowledge. The row is also the only client-side
  // copy of the attachments it was sent with, so they ride along. The
  // conversation the send belonged to rides along too, so the message goes
  // back into that thread's composer rather than whichever one is on screen.
  // It sets state only, so the reply streaming behind it is untouched.
  const failedAttachments = failedSend.attachments;
  ctx.setOptimisticSends((prev) =>
    prev.filter((m) => !messageMatchesKey(m, clientMessageId)),
  );
  ctx.setError({
    message: detail,
    code: event.code,
    errorCategory: event.errorCategory,
    displayAs: "modal",
    restoreContent: messagePlainText(failedSend),
    ...(failedAttachments && failedAttachments.length > 0
      ? { restoreAttachments: failedAttachments }
      : {}),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
  });
}

export function handleConversationErrorEvent(
  event: ConversationErrorEvent,
  ctx: StreamHandlerContext,
): void {
  const isBannerError = shouldSuppressGenericChatErrorNotice(event);

  // `ConversationErrorEvent` carries `conversationId` as a required
  // field; prefer it over `streamContext?.conversationId` (which is
  // a mirror that may be cleared by a stream teardown racing the
  // error event) — same fallback shape as the other terminal handlers.
  const convId = event.conversationId ?? ctx.streamContext?.conversationId;
  if (convId) {
    // See `handleStreamError` for the stale-snapshot rationale.
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  ctx.endTurn({ conversationId: convId, reason: "error" });

  ctx.setError({
    message: event.userMessage,
    code: event.code,
    errorCategory: event.errorCategory,
  });

  if (!isBannerError) {
    ctx.cancelAndClearStream();
  }
}

export function handleConversationNoticeEvent(
  event: ConversationNoticeEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setNotice({
    message: event.userMessage,
    code: event.code,
    errorCategory: event.errorCategory,
  });
}

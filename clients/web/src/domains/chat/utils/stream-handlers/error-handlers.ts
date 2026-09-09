import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { ERROR_MESSAGES } from "@/domains/chat/utils/chat";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { messageMatchesKey } from "@/domains/chat/utils/message-identity";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import { patchConversation } from "@/utils/conversation-cache";
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
 * An `error` that names a `clientMessageId` is that one message's, not the
 * turn's: a queued batch member the daemon could not persist while the batch it
 * was dequeued with runs on. The turn on screen keeps streaming and only that
 * send is marked failed. An `error` that names no message is the turn's
 * terminal.
 */
export function handleStreamError(
  event: ErrorEvent,
  ctx: StreamHandlerContext,
): void {
  const { clientMessageId } = event;
  if (clientMessageId) {
    handleMessageScopedError(event, clientMessageId, ctx);
    return;
  }
  const convId = ctx.streamContext?.conversationId;
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
 */
function handleMessageScopedError(
  event: ErrorEvent,
  clientMessageId: string,
  ctx: StreamHandlerContext,
): void {
  const detail = resolveErrorDetail(event);
  const failedSend = useChatSessionStore
    .getState()
    .optimisticSends.find((m) => messageMatchesKey(m, clientMessageId));

  if (!failedSend) {
    // Another client's send, or one this tab holds no row for. There is
    // nothing local to roll back, so the failure goes to the non-terminal
    // channel `handleConversationNoticeEvent` uses: a warning banner in the
    // composer area that leaves the turn and the stream alone.
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
  // in the composer when they acknowledge. It sets state only, so the reply
  // streaming behind it is untouched.
  ctx.setOptimisticSends((prev) =>
    prev.filter((m) => !messageMatchesKey(m, clientMessageId)),
  );
  ctx.setError({
    message: detail,
    code: event.code,
    errorCategory: event.errorCategory,
    displayAs: "modal",
    restoreContent: messagePlainText(failedSend),
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

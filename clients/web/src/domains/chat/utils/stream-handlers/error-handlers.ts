import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { ERROR_MESSAGES } from "@/domains/chat/utils/chat";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import { patchConversation } from "@/utils/conversation-cache";
import { messageMatchesKey } from "@/domains/chat/utils/message-identity";
import { removeQueuedMessage } from "@/domains/chat/utils/stream-updaters/shared";
import { useComposerStore } from "@/domains/chat/composer-store";
import type {
  ConversationErrorEvent,
  ConversationNoticeEvent,
  ErrorEvent,
} from "@vellumai/assistant-api";

export function handleStreamError(
  event: ErrorEvent,
  ctx: StreamHandlerContext,
): void {
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
    // Mirrors the cache patch in `handleMessageComplete` — terminal
    // errors must also clear the cached `isProcessing: true` snapshot
    // so the OR derivation in chat-route-content can't latch.
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  ctx.endTurn({ conversationId: convId, reason: "error" });
  const detail =
    (event.code && ERROR_MESSAGES[event.code]) ||
    event.message ||
    "Something went wrong.";
  ctx.setError({
    message: detail,
    code: event.code,
    errorCategory: event.errorCategory,
  });
  ctx.cancelAndClearStream();
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

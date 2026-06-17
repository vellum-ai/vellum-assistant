import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { handleConversationError } from "@/domains/chat/utils/stream-updaters/message-updaters";
import { ERROR_MESSAGES } from "@/domains/chat/utils/chat";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import { patchConversation } from "@/utils/conversation-cache";
import type {
  ConversationErrorEvent,
  ErrorEvent,
} from "@vellumai/assistant-api";

export function handleStreamError(
  event: ErrorEvent,
  ctx: StreamHandlerContext,
): void {
  const convId = ctx.streamContext?.conversationId;
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
  const convId =
    event.conversationId ?? ctx.streamContext?.conversationId;
  if (convId) {
    // See `handleStreamError` for the stale-snapshot rationale.
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  ctx.endTurn({ conversationId: convId, reason: "error" });

  ctx.setMessages(handleConversationError);

  ctx.setError({
    message: event.userMessage,
    code: event.code,
    errorCategory: event.errorCategory,
  });

  if (!isBannerError) {
    ctx.cancelAndClearStream();
  }
}

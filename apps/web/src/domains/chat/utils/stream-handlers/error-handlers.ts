import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import {
  handleConversationError,
  stopStreaming,
} from "@/domains/chat/hooks/stream-message-updaters";
import { ERROR_MESSAGES } from "@/domains/chat/utils/chat";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { ConversationErrorEvent, StreamErrorEvent } from "@/types/event-types";


export function handleStreamError(
  event: StreamErrorEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.endTurn({
    conversationId: ctx.streamContextRef.current?.conversationId,
    reason: "error",
  });
  ctx.setMessages((prev) => stopStreaming(prev));
  const detail =
    (event.code && ERROR_MESSAGES[event.code]) ||
    event.message ||
    "Something went wrong.";
  ctx.setError({
    message: detail,
    code: event.code,
    errorCategory: event.errorCategory,
  });
  ctx.streamRef.current?.cancel();
  ctx.streamRef.current = null;
}

export function handleConversationErrorEvent(
  event: ConversationErrorEvent,
  ctx: StreamHandlerContext,
): void {
  const isBannerError = shouldSuppressGenericChatErrorNotice(event);

  // `ConversationErrorEvent` carries `conversationId` as a required
  // field; prefer it over `streamContextRef.current?.conversationId`
  // (which is a mirror that may be cleared by a stream teardown
  // racing the error event) — same fallback shape as the other
  // terminal handlers.
  ctx.endTurn({
    conversationId: event.conversationId ?? ctx.streamContextRef.current?.conversationId,
    reason: "error",
  });

  ctx.setMessages(handleConversationError);

  ctx.setError({
    message: event.userMessage,
    code: event.code,
    errorCategory: event.errorCategory,
  });

  if (!isBannerError) {
    ctx.streamRef.current?.cancel();
    ctx.streamRef.current = null;
  }
}

import type {
  ConversationErrorEvent,
  StreamErrorEvent,
} from "@/domains/chat/lib/api.js";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/lib/error-classification.js";
import {
  handleConversationError,
  stopStreaming,
} from "@/domains/chat/hooks/stream-message-updaters.js";
import { ERROR_MESSAGES } from "@/domains/chat/utils/chat-utils.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";

export function handleStreamError(
  event: StreamErrorEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.dispatchTurn({ type: "STREAM_ERROR" });
  const convKey = ctx.streamContextRef.current?.conversationKey;
  if (convKey) {
    ctx.clearProcessingKey(convKey);
  }
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

  ctx.dispatchTurn({ type: "STREAM_ERROR" });
  const convKey = ctx.streamContextRef.current?.conversationKey;
  if (convKey) {
    ctx.clearProcessingKey(convKey);
  }

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

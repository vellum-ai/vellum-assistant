import {
  clearQueueStatus,
  removeQueuedMessage,
  setQueuePosition,
} from "@/domains/chat/hooks/stream-message-updaters.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";
import type { MessageDequeuedEvent, MessageQueuedDeletedEvent, MessageQueuedEvent, MessageRequestCompleteEvent } from "@/domains/chat/api/event-types.js";
import { deleteQueuedMessage } from "@/domains/chat/api/messages.js";

export function handleMessageQueued(
  event: MessageQueuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.enqueueMessage();
  const { requestId, position } = event;
  const messageId = ctx.pendingQueuedMessageIdsRef.current.shift();
  if (!messageId) return;

  ctx.requestIdToMessageIdRef.current.set(requestId, messageId);

  if (ctx.pendingLocalDeletionsRef.current.has(messageId)) {
    ctx.pendingLocalDeletionsRef.current.delete(messageId);
    if (
      ctx.assistantIdRef.current &&
      ctx.activeConversationIdRef.current
    ) {
      void deleteQueuedMessage(
        ctx.assistantIdRef.current,
        ctx.activeConversationIdRef.current,
        requestId,
      );
    }
  } else {
    ctx.setMessages((prev) =>
      setQueuePosition(prev, messageId, position + 1),
    );
  }
}

export function handleMessageDequeued(
  event: MessageDequeuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.dequeueMessage();
  const dequeuedMessageId = ctx.requestIdToMessageIdRef.current.get(
    event.requestId,
  );
  ctx.requestIdToMessageIdRef.current.delete(event.requestId);
  if (dequeuedMessageId) {
    ctx.setMessages((prev) => clearQueueStatus(prev, dequeuedMessageId));
  }
}

export function handleMessageQueuedDeleted(
  event: MessageQueuedDeletedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.deleteQueuedMessage();
  const deletedMessageId = ctx.requestIdToMessageIdRef.current.get(
    event.requestId,
  );
  ctx.requestIdToMessageIdRef.current.delete(event.requestId);
  if (deletedMessageId) {
    ctx.setMessages((prev) => removeQueuedMessage(prev, deletedMessageId));
  }
}

export function handleMessageRequestComplete(
  _event: MessageRequestCompleteEvent,
  _ctx: StreamHandlerContext,
): void {
  // Intentional no-op — the request is fully acknowledged.
}

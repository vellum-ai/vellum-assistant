import {
  clearQueueStatus,
  removeQueuedMessage,
  setQueuePosition,
} from "@/domains/chat/utils/stream-updaters/shared";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  MessageDequeuedEvent,
  MessageQueuedDeletedEvent,
  MessageQueuedEvent,
  MessageRequestCompleteEvent,
} from "@vellumai/assistant-api";
import { deleteQueuedMessage } from "@/domains/chat/api/messages";
import { useConversationStore } from "@/stores/conversation-store";

export function handleMessageQueued(
  event: MessageQueuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.enqueueMessage();
  const { requestId, position } = event;
  const messageId = ctx.shiftPendingQueuedMessageId();
  if (!messageId) return;

  ctx.setRequestIdMapping(requestId, messageId);

  if (ctx.consumePendingLocalDeletion(messageId)) {
    const conversationId =
      useConversationStore.getState().activeConversationId;
    if (ctx.assistantId && conversationId) {
      void deleteQueuedMessage(
        ctx.assistantId,
        conversationId,
        requestId,
      );
    }
  } else {
    ctx.setMessages((prev) => setQueuePosition(prev, messageId, position + 1));
  }
}

export function handleMessageDequeued(
  event: MessageDequeuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.dequeueMessage();
  const dequeuedMessageId = ctx.popRequestIdMapping(event.requestId);
  if (dequeuedMessageId) {
    ctx.setMessages((prev) => clearQueueStatus(prev, dequeuedMessageId));
  }
}

export function handleMessageQueuedDeleted(
  event: MessageQueuedDeletedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.deleteQueuedMessage();
  const deletedMessageId = ctx.popRequestIdMapping(event.requestId);
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

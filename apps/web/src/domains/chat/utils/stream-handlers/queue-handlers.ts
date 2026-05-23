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
  const stableId = ctx.pendingQueuedStableIdsRef.current.shift();
  if (!stableId) return;

  ctx.requestIdToStableIdRef.current.set(requestId, stableId);

  if (ctx.pendingLocalDeletionsRef.current.has(stableId)) {
    ctx.pendingLocalDeletionsRef.current.delete(stableId);
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
      setQueuePosition(prev, stableId, position + 1),
    );
  }
}

export function handleMessageDequeued(
  event: MessageDequeuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.dequeueMessage();
  const dequeuedStableId = ctx.requestIdToStableIdRef.current.get(
    event.requestId,
  );
  ctx.requestIdToStableIdRef.current.delete(event.requestId);
  if (dequeuedStableId) {
    ctx.setMessages((prev) => clearQueueStatus(prev, dequeuedStableId));
  }
  ctx.needsNewBubbleRef.current = true;
}

export function handleMessageQueuedDeleted(
  event: MessageQueuedDeletedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.deleteQueuedMessage();
  const deletedStableId = ctx.requestIdToStableIdRef.current.get(
    event.requestId,
  );
  ctx.requestIdToStableIdRef.current.delete(event.requestId);
  if (deletedStableId) {
    ctx.setMessages((prev) => removeQueuedMessage(prev, deletedStableId));
  }
}

export function handleMessageRequestComplete(
  _event: MessageRequestCompleteEvent,
  _ctx: StreamHandlerContext,
): void {
  // Intentional no-op — the request is fully acknowledged.
}

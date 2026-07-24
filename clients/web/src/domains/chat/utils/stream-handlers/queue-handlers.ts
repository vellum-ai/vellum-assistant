import {
  applyQueuedMessageDequeue,
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
import { useConversationStore } from "@/stores/conversation-store";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import { confirmQueuedMessageDeletion } from "@/domains/chat/queue-cancellation";

export function handleMessageQueued(
  event: MessageQueuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.enqueueMessage();
  const { requestId, position } = event;
  const messageId = ctx.shiftPendingQueuedMessageId();
  if (!messageId) {
    return;
  }

  ctx.setRequestIdMapping(requestId, messageId);

  if (ctx.consumePendingLocalDeletion(messageId)) {
    const conversationId =
      useConversationStore.getState().activeConversationId;
    if (ctx.assistantId && conversationId) {
      void confirmQueuedMessageDeletion({
        assistantId: ctx.assistantId,
        conversationId,
        requestId,
        messageId,
        setOptimisticSends: ctx.setOptimisticSends,
        onDeleted: () => {
          ctx.popRequestIdMapping(requestId);
          ctx.turnActions.deleteQueuedMessage();
        },
      });
    }
  } else {
    ctx.setOptimisticSends((prev) => setQueuePosition(prev, messageId, position + 1));
  }
}

export function handleMessageDequeued(
  event: MessageDequeuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.dequeueMessage();
  const dequeuedMessageId = ctx.popRequestIdMapping(event.requestId);
  if (dequeuedMessageId) {
    ctx.setOptimisticSends((prev) =>
      applyQueuedMessageDequeue(prev, dequeuedMessageId),
    );
  }
  patchTranscriptMessages((prev) =>
    applyQueuedMessageDequeue(prev, dequeuedMessageId ?? event.requestId),
  );
}

export function handleMessageQueuedDeleted(
  event: MessageQueuedDeletedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.deleteQueuedMessage();
  const deletedMessageId = ctx.popRequestIdMapping(event.requestId);
  if (deletedMessageId) {
    ctx.setOptimisticSends((prev) => removeQueuedMessage(prev, deletedMessageId));
  }
  patchTranscriptMessages((prev) =>
    removeQueuedMessage(prev, deletedMessageId ?? event.requestId),
  );
}

export function handleMessageRequestComplete(
  _event: MessageRequestCompleteEvent,
  _ctx: StreamHandlerContext,
): void {
  // Intentional no-op — the request is fully acknowledged.
}

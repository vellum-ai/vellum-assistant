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
  const { requestId, position, clientMessageId } = event;
  // When the ack names its send, bind by identity: consume that exact
  // pending entry, and ignore acks for sends this client did not originate
  // (another tab's send or a daemon-internal enqueue must not touch local
  // rows). Events without a nonce (surface actions, older daemons) fall
  // back to the arrival-order FIFO shift.
  const messageId = clientMessageId
    ? ctx.takePendingQueuedMessageId(clientMessageId)
    : ctx.shiftPendingQueuedMessageId();
  if (!messageId) {
    // No local row owns this ack, so there is nothing for the queued counter
    // to describe. Counting it would leave the turn store reporting a pending
    // queued send the drawer can never show.
    return;
  }

  ctx.turnActions.enqueueMessage();
  ctx.setRequestIdMapping(requestId, messageId);

  if (ctx.consumePendingLocalDeletion(messageId)) {
    const conversationId = useConversationStore.getState().activeConversationId;
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
    // The wire position is already 1-based (it counts visible queue items,
    // matching the queued rows list-messages synthesizes on a cold load).
    ctx.setOptimisticSends((prev) =>
      setQueuePosition(prev, messageId, position),
    );
  }
}

export function handleMessageDequeued(
  event: MessageDequeuedEvent,
  ctx: StreamHandlerContext,
): void {
  const dequeuedMessageId = ctx.popRequestIdMapping(event.requestId);
  // The requestId mapping is the record of a queued send this client counted:
  // `handleMessageQueued` writes it in the same breath as `enqueueMessage()`,
  // and writes neither for an ack it could not bind to a local row. Decrement
  // only against that record, so a dequeue for another tab's send or a
  // daemon-internal enqueue cannot spend a slot this client never took.
  if (dequeuedMessageId) {
    ctx.turnActions.dequeueMessage();
    ctx.setOptimisticSends((prev) =>
      applyQueuedMessageDequeue(prev, dequeuedMessageId),
    );
  }
  // Row removal is unconditional: a queued row seeded from a `/messages`
  // reseed is keyed by requestId and never went through the counter, but it is
  // rendered and must stop reading as queued.
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
    ctx.setOptimisticSends((prev) =>
      removeQueuedMessage(prev, deletedMessageId),
    );
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

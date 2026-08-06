import {
  applyQueuedMessageDequeue,
  markMessageQueued,
  removeQueuedMessage,
  setQueuePosition,
} from "@/domains/chat/utils/stream-updaters/shared";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  MessageDequeuedEvent,
  MessageQueuedDeletedEvent,
  MessageQueuedEvent,
  MessageRequestCompleteEvent,
  MessageRequeuedEvent,
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
        // The daemon broadcasts the cancel before answering the DELETE, so
        // `handleMessageQueuedDeleted` can pop the mapping first. Whichever
        // path pops it spends the slot, so the pair never double-decrements.
        onDeleted: () => {
          if (ctx.popRequestIdMapping(requestId)) {
            ctx.turnActions.deleteQueuedMessage();
          }
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

/**
 * Corrective counterpart to `handleMessageDequeued`: the daemon announced the
 * dequeue, then had to put the message back (another turn took the processing
 * lock, or the drain threw before its turn started). Restore the pending row
 * this client already cleared instead of leaving it invisible until a later
 * drain.
 *
 * The dequeue consumed the requestId mapping, so re-register it from the
 * event's own correlation key. The queue updaters match a row by either its
 * local id or its `clientMessageId`, so either value works as the key.
 */
export function handleMessageRequeued(
  event: MessageRequeuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.enqueueMessage();
  const messageKey = event.clientMessageId ?? event.requestId;
  ctx.setRequestIdMapping(event.requestId, messageKey);
  ctx.setOptimisticSends((prev) =>
    markMessageQueued(prev, messageKey, event.position),
  );
  patchTranscriptMessages((prev) =>
    markMessageQueued(prev, messageKey, event.position),
  );
}

/**
 * The single decrement for a cancelled queued message, on every device that
 * counted the enqueue, including the one that issued the DELETE. The requestId
 * mapping is what pairs the two halves: `handleMessageQueued` writes it in the
 * same breath as its increment and writes neither when it cannot bind the ack
 * to a local row, so the decrement follows the same record rather than firing
 * for a queue entry this client never counted.
 */
export function handleMessageQueuedDeleted(
  event: MessageQueuedDeletedEvent,
  ctx: StreamHandlerContext,
): void {
  const deletedMessageId = ctx.popRequestIdMapping(event.requestId);
  // Same pairing rule as `handleMessageDequeued`: the requestId mapping is the
  // record of a queued send this client counted, and popping it is what spends
  // the slot. The daemon broadcasts the cancel to every subscriber, so this
  // also lands on the tab that issued it, where the local cancel path pops the
  // same mapping. Tying the decrement to the pop keeps that to exactly one
  // decrement per cancel whichever path observes it first, and none at all on
  // a tab that never counted the enqueue. Without the gate, a second decrement
  // retires the turn while a real message is still queued.
  if (deletedMessageId) {
    ctx.turnActions.deleteQueuedMessage();
    ctx.setOptimisticSends((prev) =>
      removeQueuedMessage(prev, deletedMessageId),
    );
  }
  // Row removal is unconditional: a queued row seeded from a `/messages`
  // reseed is keyed by requestId and never went through the counter, but it is
  // rendered and must stop reading as queued.
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

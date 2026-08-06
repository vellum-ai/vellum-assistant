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

/**
 * Counts every `message_queued` broadcast, then binds the ack to a local row
 * when this client owns one. The increment is unconditional because the
 * counter tracks the conversation's whole queue rather than this client's
 * share of it: a passive tab has to show the queued indicator for a send it
 * did not originate, and its decrement arrives on the matching broadcast.
 */
export function handleMessageQueued(
  event: MessageQueuedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.enqueueMessage();
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
    // Counted but unbound: no local pending send owns this ack, so there is no
    // row to position and no mapping to record.
    return;
  }

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
        // Mapping cleanup only. The counter moves on the daemon's
        // `message_queued_deleted` broadcast, which every client sees,
        // including this one, so decrementing here would double-count.
        onDeleted: () => {
          ctx.popRequestIdMapping(requestId);
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

/**
 * Symmetric counterpart to `handleMessageQueued`: the queue entry left the
 * queue to be processed, so the decrement is unconditional on every client
 * that counted the broadcast. Only the row bookkeeping is gated, on whether
 * this client holds a local row for the request.
 */
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
  // A queued row seeded from a `/messages` reseed is keyed by requestId and
  // has no mapping, but it is rendered and must stop reading as queued.
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
 * The single decrement for a cancelled queued message, on every device
 * including the one that issued the DELETE. It is unconditional to mirror
 * `handleMessageQueued`, which increments for every `message_queued` before it
 * knows whether this client originated the send: the count tracks the
 * conversation's queue, not this client's share of it, so gating either side
 * on a local mapping would desync passive devices. The cancelling tab must
 * therefore not decrement again in its own DELETE callback.
 */
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
  // A queued row seeded from a `/messages` reseed is keyed by requestId and
  // has no mapping, but it is rendered and must stop reading as queued.
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

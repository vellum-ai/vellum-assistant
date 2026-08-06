/**
 * `message_requeued` SSE event.
 *
 * The corrective counterpart to `message_dequeued`. A drain announces a
 * dequeue before the steps that can send the message back: another turn
 * takes the processing lock between the announcement and the persist, or
 * the drain dispatch throws before the turn takes over. In both cases the
 * message returns to the front of the per-conversation queue and runs on a
 * later drain.
 *
 * Without this event a client that cleared its pending indicator on the
 * `message_dequeued` has no way to learn the message is queued again, so
 * the row disappears until the next drain. Clients restore the pending
 * indicator for `requestId` at `position`, which uses the same 1-based
 * visible-item accounting as `message_queued`.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageRequeuedEventSchema = z.object({
  type: z.literal("message_requeued"),
  conversationId: z.string(),
  requestId: z.string(),
  /** 1-based position among the queue's visible items after the requeue. */
  position: z.number(),
  /** Sender-minted idempotency nonce from the originating POST, when the
   *  sender provided one. Lets the originating client bind this event to
   *  its local optimistic row by identity instead of arrival order. */
  clientMessageId: z.string().optional(),
});

export type MessageRequeuedEvent = z.infer<typeof MessageRequeuedEventSchema>;

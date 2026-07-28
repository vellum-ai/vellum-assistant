/**
 * `message_dequeued` SSE event.
 *
 * Emitted when a previously-queued user message is removed from the
 * per-conversation request queue because the runtime is about to start
 * a turn for it. Pairs with the prior `message_queued` for the same
 * `requestId`. Clients clear the pending indicator.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageDequeuedEventSchema = z.object({
  type: z.literal("message_dequeued"),
  conversationId: z.string(),
  requestId: z.string(),
  /** Sender-minted idempotency nonce from the originating POST, when the
   *  sender provided one. Lets the originating client bind this event to
   *  its local optimistic row by identity instead of arrival order. */
  clientMessageId: z.string().optional(),
});

export type MessageDequeuedEvent = z.infer<typeof MessageDequeuedEventSchema>;

/**
 * `message_queued_deleted` SSE event.
 *
 * Emitted when a queued user message is discarded before it ever runs
 * (e.g. the user cancels it from the queue UI). Clients drop the
 * pending indicator for `requestId`. Distinct from `message_dequeued`,
 * which signals normal promotion into a running turn.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageQueuedDeletedEventSchema = z.object({
  type: z.literal("message_queued_deleted"),
  conversationId: z.string(),
  requestId: z.string(),
});

export type MessageQueuedDeletedEvent = z.infer<
  typeof MessageQueuedDeletedEventSchema
>;

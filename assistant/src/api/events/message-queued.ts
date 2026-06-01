/**
 * `message_queued` SSE event.
 *
 * Emitted when a user message is accepted while an assistant turn is
 * still streaming, and the runtime holds it in the per-conversation
 * request queue rather than starting a new turn. Clients render a
 * pending indicator and use `position` to order multiple queued items.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageQueuedEventSchema = z.object({
  type: z.literal("message_queued"),
  conversationId: z.string(),
  requestId: z.string(),
  position: z.number(),
});

export type MessageQueuedEvent = z.infer<typeof MessageQueuedEventSchema>;

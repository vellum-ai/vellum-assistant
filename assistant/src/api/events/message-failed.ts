/**
 * `message_failed` SSE event.
 *
 * Reports that one accepted or queued user message could not be delivered or
 * persisted while the conversation's current turn may continue. Older clients
 * safely ignore this distinct discriminator instead of mistaking the failure
 * for a terminal turn error.
 */

import { z } from "zod";

export const MessageFailedEventSchema = z.object({
  type: z.literal("message_failed"),
  message: z.string(),
  conversationId: z.string(),
  requestId: z.string(),
  clientMessageId: z.string().optional(),
  code: z.string().optional(),
  category: z.string().optional(),
  errorCategory: z.string().optional(),
});

export type MessageFailedEvent = z.infer<typeof MessageFailedEventSchema>;

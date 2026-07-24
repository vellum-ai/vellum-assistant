/**
 * `schedule_conversation_created` SSE event.
 *
 * Server → client broadcast emitted when a schedule creates a
 * conversation, so clients can surface it. Carries the new
 * `conversationId`, the originating `scheduleJobId`, and the `title`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ScheduleConversationCreatedEventSchema = z.object({
  type: z.literal("schedule_conversation_created"),
  conversationId: z.string(),
  scheduleJobId: z.string(),
  title: z.string(),
});

export type ScheduleConversationCreatedEvent = z.infer<
  typeof ScheduleConversationCreatedEventSchema
>;

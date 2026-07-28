/**
 * `conversation_notice` SSE event.
 *
 * Non-terminal, conversation-scoped notice for actionable runtime conditions
 * that should not mark the turn as failed. The client may render CTA UI from
 * this event while preserving the current assistant response.
 */

import { z } from "zod";

import { ConversationErrorCodeSchema } from "./conversation-error.js";

export const ConversationNoticeSourceSchema = z.enum(["memory_v3"]);

export const ConversationNoticeEventSchema = z.object({
  type: z.literal("conversation_notice"),
  conversationId: z.string(),
  source: ConversationNoticeSourceSchema,
  code: ConversationErrorCodeSchema,
  userMessage: z.string(),
  errorCategory: z.string().optional(),
});

export type ConversationNoticeEvent = z.infer<
  typeof ConversationNoticeEventSchema
>;

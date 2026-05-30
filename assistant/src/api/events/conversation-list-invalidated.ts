/**
 * `conversation_list_invalidated` SSE event.
 *
 * Tells clients their sidebar conversation list is stale and should be
 * refetched. `reason` categorizes the underlying cause so clients can
 * pick narrower refresh strategies if they choose.
 *
 * Global event (no `conversationId`): the conversation list is per-user,
 * not per-conversation, and the daemon fans this out across every active
 * client of the user.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ConversationListInvalidatedReasonSchema = z.enum([
  "created",
  "renamed",
  "deleted",
  "reordered",
  "seen_changed",
]);

export type ConversationListInvalidatedReason = z.infer<
  typeof ConversationListInvalidatedReasonSchema
>;

export const ConversationListInvalidatedEventSchema = z.object({
  type: z.literal("conversation_list_invalidated"),
  /** Categorical cause of invalidation. */
  reason: ConversationListInvalidatedReasonSchema,
});

export type ConversationListInvalidatedEvent = z.infer<
  typeof ConversationListInvalidatedEventSchema
>;

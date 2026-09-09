/**
 * `conversation_title_updated` SSE event.
 *
 * Emitted when a conversation's title changes — typically right after
 * the auto-titling LLM pass completes, or on explicit rename. Clients
 * update sidebar entries in-place rather than refetching the full list.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ConversationTitleUpdatedEventSchema = z.object({
  type: z.literal("conversation_title_updated"),
  /** Conversation whose title changed. */
  conversationId: z.string(),
  /** New title. */
  title: z.string(),
});

export type ConversationTitleUpdatedEvent = z.infer<
  typeof ConversationTitleUpdatedEventSchema
>;

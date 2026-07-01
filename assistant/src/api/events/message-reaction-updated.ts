/**
 * `message_reaction_updated` SSE event.
 *
 * Emitted when the set of emoji reactions on a persisted message changes —
 * today, when the assistant reacts to a user message via the
 * `send_reaction` tool. Carries the full replacement reaction set so
 * clients patch the message row in place without refetching history.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { ConversationMessageReactionSchema } from "../responses/conversation-message.js";

export const MessageReactionUpdatedEventSchema = z.object({
  type: z.literal("message_reaction_updated"),
  /** Conversation the reacted-to message belongs to. */
  conversationId: z.string(),
  /** The message the reactions are attached to. */
  messageId: z.string(),
  /** Full replacement set of reactions on the message, newest last. */
  reactions: z.array(ConversationMessageReactionSchema),
});

export type MessageReactionUpdatedEvent = z.infer<
  typeof MessageReactionUpdatedEventSchema
>;

/**
 * `conversation_inference_profile_updated` SSE event.
 *
 * Broadcast to clients when a conversation's inference-profile override
 * changes. `profile` is the profile name (a key in `llm.profiles`) or
 * `null` when the override is cleared and the conversation falls back to
 * the workspace `llm.activeProfile` resolution.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ConversationInferenceProfileUpdatedEventSchema = z.object({
  type: z.literal("conversation_inference_profile_updated"),
  conversationId: z.string(),
  profile: z.string().nullable(),
  sessionId: z.string().nullable().optional(),
  expiresAt: z.number().nullable().optional(),
});

export type ConversationInferenceProfileUpdatedEvent = z.infer<
  typeof ConversationInferenceProfileUpdatedEventSchema
>;

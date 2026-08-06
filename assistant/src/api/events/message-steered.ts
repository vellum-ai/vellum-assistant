/**
 * `message_steered` SSE event.
 *
 * Server → client notification that an in-flight generation was steered
 * by a follow-up user message, so clients can reflect the mid-turn
 * redirect. Scoped by `conversationId` and `requestId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const MessageSteeredEventSchema = z.object({
  type: z.literal("message_steered"),
  conversationId: z.string(),
  requestId: z.string(),
});

export type MessageSteeredEvent = z.infer<typeof MessageSteeredEventSchema>;

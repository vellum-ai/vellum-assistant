/**
 * `heartbeat_conversation_created` SSE event.
 *
 * Server → client broadcast emitted when the heartbeat monitor creates
 * a conversation (e.g. to surface a finding), so clients can place it in
 * the sidebar. Carries the new `conversationId` and its `title`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const HeartbeatConversationCreatedEventSchema = z.object({
  type: z.literal("heartbeat_conversation_created"),
  conversationId: z.string(),
  title: z.string(),
});

export type HeartbeatConversationCreatedEvent = z.infer<
  typeof HeartbeatConversationCreatedEventSchema
>;

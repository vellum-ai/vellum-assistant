/**
 * `notification_conversation_created` SSE event.
 *
 * Server → client broadcast emitted when an incoming notification
 * creates a new vellum conversation. First-party clients ignore it; the
 * web client lists it as a no-op. A guardian-sensitive
 * conversation is announced only to connections authenticated as the
 * guardian named in `targetGuardianPrincipalId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const NotificationConversationCreatedEventSchema = z.object({
  type: z.literal("notification_conversation_created"),
  conversationId: z.string(),
  title: z.string(),
  sourceEventName: z.string(),
  /**
   * When set, this conversation was created for a guardian-sensitive
   * notification. The daemon delivers the event only to connections whose
   * verified principal is this guardian, so every client that receives it
   * is one it was meant for.
   */
  targetGuardianPrincipalId: z.string().optional(),
  /**
   * Conversation group identifier propagated from the signal producer:
   * the sidebar folder the conversation belongs in (e.g.
   * "system:scheduled" for schedule completion threads).
   */
  groupId: z.string().optional(),
  /**
   * Semantic source of the conversation (e.g. "schedule", "reminder"),
   * overriding the default "notification" source.
   */
  source: z.string().optional(),
  /**
   * Mirrors `NotificationIntent.silent`, which the server sets for
   * low- and medium-urgency signals. Clients act on the intent's copy.
   */
  silent: z.boolean().optional(),
});

export type NotificationConversationCreatedEvent = z.infer<
  typeof NotificationConversationCreatedEventSchema
>;

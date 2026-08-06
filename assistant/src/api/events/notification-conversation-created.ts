/**
 * `notification_conversation_created` SSE event.
 *
 * Server → client broadcast emitted when an incoming notification
 * creates a new vellum conversation. Clients use it to place the
 * conversation in the sidebar (`groupId`, `source`) and decide whether
 * to raise a fallback OS banner (`silent`). `targetGuardianPrincipalId`
 * scopes guardian-sensitive conversations to a bound identity.
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
   * notification and should only be surfaced by clients bound to this
   * guardian identity.
   */
  targetGuardianPrincipalId: z.string().optional(),
  /**
   * Conversation group identifier propagated from the signal producer.
   * Clients use this to place the conversation in the correct sidebar
   * folder (e.g. "system:scheduled" for schedule completion threads).
   */
  groupId: z.string().optional(),
  /**
   * Semantic source of the conversation (e.g. "schedule", "reminder").
   * Allows clients to override the default "notification" source so the
   * conversation is attributed correctly.
   */
  source: z.string().optional(),
  /**
   * Mirrors `NotificationIntent.silent`. When true the client must not
   * post a fallback OS banner for this conversation — the sidebar entry
   * still appears, but the always-on inbox is the only surfaced channel.
   * Derived from the originating signal's `attentionHints.urgency`.
   */
  silent: z.boolean().optional(),
});

export type NotificationConversationCreatedEvent = z.infer<
  typeof NotificationConversationCreatedEventSchema
>;

/**
 * `conversation_error` SSE event.
 *
 * Conversation-scoped error broadcast to every client subscribed to
 * the stream. Unlike the turn-terminal `error` event, this carries a
 * stable `code` enum and a `retryable` flag so the chat banner can
 * offer source-aware recovery (e.g. naming the provider connection or
 * profile that needs fixing).
 *
 * `conversationId` is required and carried on the event itself — the
 * broadcast reaches all subscribers, so without it a breaker trip in
 * one conversation would paint the error banner on every open chat.
 *
 * Canonical wire-contract source. Daemon code imports the type and the
 * `ConversationErrorCode` enum directly from this file; external
 * consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

/**
 * Stable machine-readable classification for conversation-scoped
 * errors. Drives client recovery UI (retry affordances, billing
 * banners, connection/profile callouts). `UNKNOWN` is the catch-all
 * for unclassified failures.
 */
export const ConversationErrorCodeSchema = z.enum([
  "PROVIDER_NETWORK",
  "PROVIDER_RATE_LIMIT",
  "MANAGED_USAGE_LIMIT",
  "PROVIDER_OVERLOADED",
  "PROVIDER_API",
  "IMAGE_TOO_LARGE",
  "PROVIDER_BILLING",
  "PROVIDER_ORDERING",
  "PROVIDER_WEB_SEARCH",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_INVALID_KEY",
  "MANAGED_KEY_INVALID",
  "CONTEXT_TOO_LARGE",
  "BUDGET_YIELD_UNRECOVERED",
  "MAX_TOKENS_REACHED",
  "CONVERSATION_ABORTED",
  "CONVERSATION_PROCESSING_FAILED",
  "DISK_SPACE_CRITICAL",
  "UNKNOWN",
]);

export type ConversationErrorCode = z.infer<typeof ConversationErrorCodeSchema>;

export const ConversationErrorEventSchema = z.object({
  type: z.literal("conversation_error"),
  conversationId: z.string(),
  code: ConversationErrorCodeSchema,
  userMessage: z.string(),
  retryable: z.boolean(),
  debugDetails: z.string().optional(),
  errorCategory: z.string().optional(),
  /**
   * Name of the `provider_connections` row in play when the error
   * occurred. Lets the chat banner point users at the connection to
   * fix (e.g. an invalid API key). Absent when the error fires before
   * a connection is resolved.
   */
  connectionName: z.string().optional(),
  /**
   * Name of the resolved profile (active or per-call override) in
   * play when the error occurred. Absent when the error fires before
   * a profile is resolved.
   */
  profileName: z.string().optional(),
});

export type ConversationErrorEvent = z.infer<
  typeof ConversationErrorEventSchema
>;

/**
 * `turn_profile_auto_routed` SSE event.
 *
 * Emitted when the query-complexity auto-router selects a non-default
 * inference profile for the current turn. Clients render a subtle
 * inline notification (e.g. "Using Quality for this response"). Only
 * fires when the router picks a profile — not when the user explicitly
 * pinned one.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const TurnProfileAutoRoutedEventSchema = z.object({
  type: z.literal("turn_profile_auto_routed"),
  conversationId: z.string(),
  /** Profile key (e.g. "quality-optimized"). */
  profile: z.string(),
  /** Human-readable label (e.g. "Quality"). */
  profileLabel: z.string(),
});

export type TurnProfileAutoRoutedEvent = z.infer<
  typeof TurnProfileAutoRoutedEventSchema
>;

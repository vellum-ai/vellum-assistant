/**
 * `home_feed_updated` SSE event.
 *
 * Emitted after a successful write to the home feed journal — clients
 * invalidate their cached feed view and refetch. Skipped when the
 * underlying write fails.
 *
 * Global event (no `conversationId`): the home feed is per-user, not
 * per-conversation, and the daemon fans this out across every active
 * client of the user.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const HomeFeedUpdatedEventSchema = z.object({
  type: z.literal("home_feed_updated"),
  /** ISO-8601 timestamp of when the feed was written. */
  updatedAt: z.string(),
  /** Count of items with `status === "new"` after this write. */
  newItemCount: z.number(),
});

export type HomeFeedUpdatedEvent = z.infer<typeof HomeFeedUpdatedEventSchema>;

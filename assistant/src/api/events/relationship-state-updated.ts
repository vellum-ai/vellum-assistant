/**
 * `relationship_state_updated` SSE event.
 *
 * Broadcast by the daemon after a successful write of
 * `relationship-state.json` to disk. The payload carries the new
 * `updatedAt` for cache-tag comparison; the web client treats the event
 * as a signal that the home feed is stale and refetches
 * `GET /v1/home/feed`.
 *
 * There is no longer a read endpoint for the state snapshot itself: the
 * Activity page was the only consumer of `GET /v1/home/state` and both
 * went away together.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const RelationshipStateUpdatedEventSchema = z.object({
  type: z.literal("relationship_state_updated"),
  updatedAt: z.string(),
});

export type RelationshipStateUpdatedEvent = z.infer<
  typeof RelationshipStateUpdatedEventSchema
>;

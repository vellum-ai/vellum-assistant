/**
 * `relationship_state_updated` SSE event.
 *
 * Broadcast by the daemon after a successful write of
 * `relationship-state.json` to disk. Subscribers refetch
 * `GET /v1/home/state` to read the new state — payload here just
 * carries the new `updatedAt` for cache-tag comparison.
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

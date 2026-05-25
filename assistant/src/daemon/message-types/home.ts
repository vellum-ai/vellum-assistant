/**
 * Home — server → client push messages for the macOS Home page.
 *
 * These messages are fire-and-forget notifications; the client reacts
 * by refetching the authoritative state from the HTTP route
 * (`GET /v1/home/state`). Payloads stay deliberately tiny — they carry
 * just enough metadata to invalidate a cache and trigger a refetch.
 *
 * `RelationshipStateUpdated` is the first event to migrate to the new
 * shared-wire-contract location at `assistant/src/events/sse/`. It is
 * re-exported here so existing daemon importers and the
 * `_HomeServerMessages` union composition keep working unchanged.
 */

export type { RelationshipStateUpdated } from "../../events/sse/relationship-state-updated.js";

import type { RelationshipStateUpdated } from "../../events/sse/relationship-state-updated.js";

/**
 * Broadcast after the daemon successfully writes a fresh home activity
 * feed snapshot. Subscribers (e.g. `HomeFeedStore` on the client) should
 * refetch the authoritative feed from its HTTP route.
 *
 * Only emitted on the success branch of the feed writer — if the
 * underlying write fails, this event is NOT published.
 */
export interface HomeFeedUpdated {
  type: "home_feed_updated";
  /** ISO-8601 timestamp of when the feed was written. */
  updatedAt: string;
  /** Count of items with `status === "new"` after this write. */
  newItemCount: number;
}

export type _HomeServerMessages = RelationshipStateUpdated | HomeFeedUpdated;

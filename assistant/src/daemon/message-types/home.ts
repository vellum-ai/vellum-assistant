/**
 * Home — server → client push messages for the macOS Home page.
 *
 * These messages are fire-and-forget notifications; the client reacts
 * by refetching the authoritative state from the HTTP route
 * (`GET /v1/home/state`). Payloads stay deliberately tiny — they carry
 * just enough metadata to invalidate a cache and trigger a refetch.
 */

import type { HomeFeedUpdatedEvent } from "../../api/events/home-feed-updated.js";
import type { RelationshipStateUpdatedEvent } from "../../api/events/relationship-state-updated.js";

export type _HomeServerMessages =
  | RelationshipStateUpdatedEvent
  | HomeFeedUpdatedEvent;

/**
 * Backwards-compat gate: server-side event-tail catch-up.
 *
 * Vellum Assistant 0.10.7 adds `GET /events/tail` — the request/response
 * twin of reconnecting the SSE stream with `lastSeenSeq`. It returns the
 * daemon's ring-buffered events for one conversation above a seq anchor,
 * so a recovery reconcile can pair a `/messages` snapshot with the exact
 * events the live connection never delivered, instead of relying on the
 * snapshot alone (which can honestly lag the stream by up to the daemon's
 * partial-persist debounce).
 *
 * Older daemons don't serve the route; callers skip the tail fetch and
 * keep the snapshot-only recovery behavior.
 *
 * Once 0.10.7 is the minimum supported assistant version, delete this
 * module and call the endpoint unconditionally.
 */
import { assistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.7";

/** Whether the active assistant serves `GET /events/tail`. */
export function supportsEventsTail(): boolean {
  return assistantSupports(MIN_VERSION);
}

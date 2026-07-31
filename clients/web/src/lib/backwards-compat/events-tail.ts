/**
 * Backwards-compat gate: server-side event-tail catch-up.
 *
 * The daemon build stamped in `MIN_VERSION` adds `GET /events/tail` — the
 * request/response twin of reconnecting the SSE stream with `lastSeenSeq`.
 * It returns the daemon's ring-buffered events for one conversation above
 * a seq anchor, so a recovery reconcile can pair a `/messages` snapshot
 * with the exact events the live connection never delivered, instead of
 * relying on the snapshot alone (which can honestly lag the stream by up
 * to the daemon's partial-persist debounce).
 *
 * This gate governs TWO behaviors, both of which depend on the endpoint:
 *   1. Whether recovery reconciles fetch and fold the event tail.
 *   2. Whether the reconciliation "loop" polls (below the floor) or runs
 *      a single tail-complete reconcile (at/above it). See
 *      `use-message-reconciliation.ts`.
 *
 * Below the floor the daemon doesn't serve the route, so callers skip the
 * tail fetch and keep the snapshot-only, poll-until-stable recovery.
 *
 * The floor is pinned to the exact dev build that introduced the endpoint
 * (`dev.<timestamp>.<sha>`) rather than the bare `0.10.7` base so that
 * `0.10.7-dev.*` builds PREDATING the endpoint are correctly excluded —
 * they would otherwise be treated as "ahead of" the stable base by
 * `supportsVersion` and falsely report support, causing the client to
 * skip the loop while `/events/tail` 404s. Note the tradeoff (see
 * `utils.ts` dev-vs-stable ordering): a dev floor also excludes the bare
 * `0.10.7` GA and `0.10.7-staging.*` builds, which carry the endpoint but
 * sort BELOW a dev pre-release of the same base. Bump the floor to the
 * `0.10.7` base (or let the base roll to `0.10.8`) before those ship, or
 * the loop removal silently won't activate in staging/production.
 *
 * Once the tail endpoint's build is the minimum supported assistant
 * version, delete this module, call the endpoint unconditionally, and
 * delete the poll loop.
 */
import { assistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.7-dev.202607081242.ce9b576";

/** Whether the active assistant serves `GET /events/tail`. */
export function supportsEventsTail(): boolean {
  return assistantSupports(MIN_VERSION);
}

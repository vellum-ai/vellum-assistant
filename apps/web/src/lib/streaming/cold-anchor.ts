/**
 * Cold-start anchored replay.
 *
 * The assistant-scoped SSE connection (`sse-service`) and the active
 * conversation's `/messages` fetch (`use-conversation-history`) are two
 * independent client requests that race on a fresh page load. The SSE
 * fetch fires synchronously while `/messages` needs a round-trip, so the
 * connect almost always wins and opens cursor-less — the daemon goes
 * live from its current seq, dropping every event emitted between when
 * the `/messages` snapshot was computed (watermark `S`) and when the
 * subscription attached. That `(S, attach]` window is the cold-start
 * gap.
 *
 * The fix is the canonical change-data-capture ordering — "snapshot,
 * then stream from the snapshot's position" (Postgres `consistent_point`,
 * Linear's `lastSyncId`): once `/messages` resolves with `S`, seed the
 * resumable cursor at `S` and re-anchor the connection so it reconnects
 * carrying `lastSeenSeq = S`. The daemon then replays `seq > S` from its
 * ring before going live, so the gap is delivered; the overlap with the
 * snapshot is an idempotent no-op via `local-seq`. If `S` predates the
 * ring window the daemon goes live from a higher seq and the consumer's
 * seq-gap detector reconciles via `/messages` instead.
 *
 * Anchoring runs at most once per page session, gated on the cursor
 * still being `null` (a genuinely cold connection — no live event has
 * seeded it yet). After a live event has advanced the cursor the
 * snapshot/stream merge and idempotent apply already keep the views
 * aligned, so a backwards re-anchor would only churn the connection.
 *
 * When `/messages` reports no honest position (`S === null`, e.g. an
 * older daemon), the cursor stays `null` and the connection opens
 * cursor-less exactly as a fresh page load does.
 */

import { publish } from "@/lib/event-bus";
import {
  advanceReconnectCursor,
  getReconnectCursor,
} from "@/lib/streaming/reconnect-cursor";

/**
 * Anchor the live SSE connection at the server seq `S` once per
 * cold session.
 *
 * Called when `/messages` resolves for the active conversation. When
 * `S` is a real position and the connection is still cold (cursor
 * `null`), this seeds the resumable cursor at `S` and requests a single
 * re-anchor reconnect so the daemon replays `seq > S` from its ring. A
 * no-op otherwise.
 */
export function anchorColdStartReplay(serverSeq: number | null): void {
  if (serverSeq === null) return;
  // A non-null cursor means a live event already seeded it — the
  // connection is no longer cold, so the running merge/apply path owns
  // alignment from here. Only a still-`null` cursor is a genuine cold
  // start that needs anchoring.
  if (getReconnectCursor() !== null) return;

  // Seed the resumable cursor at the snapshot position. The cold connect
  // that is already in flight was opened cursor-less (before `S` was
  // known), so the bounce below is what actually carries `lastSeenSeq`;
  // seeding first means `buildEventsQuery` reads `S` on the reopen.
  advanceReconnectCursor(serverSeq);

  // Re-anchor the connection. `sse-service` tears down the cursor-less
  // connect and reopens carrying `lastSeenSeq = S`. If no connection is
  // attached yet (the rare case where `/messages` won the race), the
  // bounce is a no-op and the upcoming cold connect carries the seeded
  // cursor directly.
  publish("sse.anchor-requested", {});
}

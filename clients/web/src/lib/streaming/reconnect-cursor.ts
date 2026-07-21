/**
 * Single global cursor for the unfiltered assistant SSE stream.
 *
 * Tracks the highest global `seq` the client has applied on the one
 * unfiltered (assistant-wide) SSE connection. `seq` is a single
 * per-assistant counter the daemon assigns to every conversation-scoped
 * event and is stable across subscriptions, so one number resumes the
 * multiplexed stream regardless of how many conversations ride it.
 *
 * The cursor serves two roles, both keyed off the same value because the
 * connection delivers a single ordered global stream:
 *   - Transport resume: on reconnect the transport sends this number as
 *     `lastSeenSeq` so the daemon replays every buffered event with
 *     `seq > cursor` from its global ring before going live (see
 *     `assistant/src/runtime/assistant-stream-state.ts`).
 *   - Gap detection: a jump in `seq` (or a backwards reset) on the live
 *     stream signals events were missed and the active conversation
 *     should reconcile.
 *
 * Held in memory only. A fresh page load opens a cold (non-reconnect)
 * connection that omits the cursor, so there is nothing to persist
 * across loads; the daemon's ring is bounded to a short window anyway.
 *
 * `seq` is per-assistant, so the cursor is only meaningful within one
 * assistant-scoped connection. Switching assistants is a new seq space:
 * `sse-service` resets the cursor when it attaches a connection so the
 * next assistant starts cold (like a fresh page load) rather than
 * carrying the previous assistant's seq onto an unrelated stream.
 */

let reconnectCursor: number | null = null;

/**
 * The ceiling of the most recently abandoned seq generation, or `null` when
 * no generation reset has been observed on this connection's seq space.
 *
 * A generation reset (the daemon's counter restarting below the live cursor)
 * proves every seq up to the pre-reset cursor belonged to a now-dead
 * generation. A `/messages` request that raced the reset can still land a
 * dead-generation anchor on a per-conversation frontier afterwards; that
 * poisoned frontier sits at or above this ceiling while the new generation
 * re-climbs toward it. That re-climb window is the only place a live event
 * trailing its conversation's frontier is a stale-generation anchor rather
 * than an ordinary snapshot-overlap replay — see the stale-frontier guard in
 * `sse-event-consumer`. Held monotonically (highest ceiling wins) so a second
 * reset never narrows the window, and cleared with the cursor on an assistant
 * switch, which is a fresh seq space.
 */
let abandonedGenerationCeiling: number | null = null;

/**
 * The highest global seq applied so far, or `null` if no event with a
 * seq has been seen yet.
 */
export function getReconnectCursor(): number | null {
  return reconnectCursor;
}

/**
 * Record a seq-generation reset that abandoned every seq up to
 * `abandonedCeiling` — the cursor value observed immediately before the
 * daemon's counter restarted lower. Monotonic: retains the highest ceiling
 * seen so a later, smaller reset never narrows the stale-frontier window.
 */
export function recordAbandonedGeneration(abandonedCeiling: number): void {
  if (
    abandonedGenerationCeiling === null ||
    abandonedCeiling > abandonedGenerationCeiling
  ) {
    abandonedGenerationCeiling = abandonedCeiling;
  }
}

/**
 * The ceiling of the most recent abandoned seq generation, or `null` when no
 * generation reset has been observed on this connection's seq space.
 */
export function getAbandonedGenerationCeiling(): number | null {
  return abandonedGenerationCeiling;
}

/**
 * Advance the cursor to `seq` when it is higher than the current value
 * (monotonic). Called after each event is applied.
 */
export function advanceReconnectCursor(seq: number): void {
  if (reconnectCursor === null || seq > reconnectCursor) {
    reconnectCursor = seq;
  }
}

/**
 * Unconditionally set the cursor to `seq`. Used when a backwards seq is
 * observed (the daemon restarted and the global counter reset), where
 * the old seq space is meaningless and monotonicity must be abandoned.
 */
export function replaceReconnectCursor(seq: number): void {
  reconnectCursor = seq;
}

/**
 * Clear the cursor back to its cold (`null`) state.
 *
 * Called by `sse-service` when a connection is attached for an
 * assistant: `seq` is per-assistant, so a cursor populated under the
 * previous assistant is meaningless on the new one and must not be sent
 * as `lastSeenSeq` or block cold-start anchoring. Starting cold lets the
 * snapshot watermark re-seed the cursor for the new assistant.
 */
export function resetReconnectCursor(): void {
  reconnectCursor = null;
  abandonedGenerationCeiling = null;
}

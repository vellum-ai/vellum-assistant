/**
 * Single global reconnect cursor for the unfiltered assistant SSE
 * stream.
 *
 * Tracks the highest global `seq` the client has received on the one
 * unfiltered (assistant-wide) SSE connection. On reconnect the transport
 * sends this single number so the daemon replays every buffered event
 * with `seq > cursor` — across all conversations — from its global ring
 * before going live (see `assistant/src/runtime/assistant-stream-state.ts`).
 *
 * This is distinct from the per-conversation `clientSeq` watermark in
 * `last-seen-seq.ts`:
 *   - `seq` is a single global counter the daemon assigns to every event
 *     and is stable across subscriptions, so one cursor resumes the
 *     multiplexed stream regardless of how many conversations ride it.
 *   - `clientSeq` is per-conversation per-subscriber and resets each
 *     subscription; it drives gap detection on the active-conversation
 *     filtered view, a separate concern from transport-level resume.
 *
 * Held in memory only. A fresh page load opens a cold (non-reconnect)
 * connection that omits the cursor, so there is nothing to persist
 * across loads; the daemon's ring is bounded to a short window anyway.
 *
 * Writes are monotonic — the cursor only advances.
 */

let reconnectCursor: number | null = null;

/**
 * Advance the cursor to `seq` if it is higher than the current value.
 * Called for every event received on the stream.
 */
export function recordReconnectSeq(seq: number): void {
  if (reconnectCursor === null || seq > reconnectCursor) {
    reconnectCursor = seq;
  }
}

/**
 * The highest global seq received so far, or `null` if no event with a
 * seq has been seen yet.
 */
export function getReconnectCursor(): number | null {
  return reconnectCursor;
}

/** Reset state. Test-only. */
export function __resetReconnectCursorForTesting(): void {
  reconnectCursor = null;
}

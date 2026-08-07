/**
 * Daemon-side state for the pre-checkpoint socket quiesce (see
 * `ipc/routes/checkpoint-ipc-routes.ts` for the flow).
 *
 * Two concerns live here:
 *
 * 1. **SSE subscription registry** — every SSE-backed event-hub subscription
 *    (client-identified or headerless "process"-typed) is registered with a
 *    closer so the quiesce can close the underlying external socket. Genuine
 *    in-process subscribers (plugins, workers) never register and are never
 *    touched.
 * 2. **Admission latch** — SSE clients auto-retry within 1–2s, so a fresh
 *    external socket could be admitted between the quiesce and the freeze.
 *    While the latch is active the events route rejects new subscriptions
 *    with a 503 (clients keep retrying). The latch is wall-clock based, so it
 *    self-clears on restore (CLOCK_REALTIME jumps forward past the deadline)
 *    and expires on its own when no checkpoint happens.
 */

// Mirrors the gateway's reconnect holdoff (velay/slack) so the whole pod
// re-admits external connections on the same schedule.
export const CHECKPOINT_SSE_HOLDOFF_MS = 60_000;

let quiesceUntil = 0;

/** Arm the SSE admission latch ahead of a checkpoint. */
export function beginCheckpointQuiesce(): void {
  quiesceUntil = Date.now() + CHECKPOINT_SSE_HOLDOFF_MS;
}

/** True while new SSE subscriptions must be refused. */
export function isCheckpointQuiesceActive(): boolean {
  return Date.now() < quiesceUntil;
}

/** Test hook: drop the latch. */
export function clearCheckpointQuiesce(): void {
  quiesceUntil = 0;
}

const sseClosers = new Set<() => void>();

/**
 * Track a live SSE-backed subscription. Returns an unregister function the
 * route must call from its cleanup path so closed connections don't leak.
 */
export function registerSseSubscription(close: () => void): () => void {
  sseClosers.add(close);
  return () => {
    sseClosers.delete(close);
  };
}

/** Close every tracked SSE subscription; returns how many were closed. */
export function closeAllSseSubscriptions(): number {
  let closed = 0;
  for (const close of [...sseClosers]) {
    sseClosers.delete(close);
    try {
      close();
      closed++;
    } catch {
      // closer failures must not stop the sweep
    }
  }
  return closed;
}

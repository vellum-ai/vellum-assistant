/**
 * Health heuristics for connected SSE clients.
 */

/** Keep-alive comment sent to idle clients every 7 s by default. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 7_000;

/**
 * Whether a client looks degraded: connected long enough that a
 * heartbeat should have advanced `lastActiveAt`, yet it hasn't. This
 * flags a registered-but-not-heartbeating connection (the symptom of a
 * flapping extension SSE stream) without false-positiving on a healthy
 * freshly-connected client whose first heartbeat hasn't fired yet.
 *
 * Limitation: a just-reconnected flapping client looks like a healthy
 * new connection in a single snapshot — this is best-effort visibility,
 * not a liveness guarantee.
 */
export function isClientDegraded(
  connectedAt: Date,
  lastActiveAt: Date,
  now: Date,
  heartbeatIntervalMs: number,
): boolean {
  const connectedForMs = now.getTime() - connectedAt.getTime();
  const advancedByMs = lastActiveAt.getTime() - connectedAt.getTime();
  return (
    connectedForMs > 2 * heartbeatIntervalMs &&
    advancedByMs < heartbeatIntervalMs
  );
}

/**
 * Health heuristics for connected SSE clients.
 */

/** Keep-alive comment sent to idle clients every 7 s by default. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 7_000;

/**
 * Whether a client looks degraded: its last heartbeat (`lastActiveAt`) is
 * stale by more than two heartbeat intervals. This surfaces a
 * registered-but-not-heartbeating connection — the symptom of a flapping
 * extension SSE stream — whether it never heartbeated or heartbeated and
 * then froze. A healthy client (fresh or actively heartbeating) has a
 * recent `lastActiveAt` and is not flagged.
 *
 * Limitation: a just-reconnected flapping client has a fresh
 * `lastActiveAt` and looks healthy in a single snapshot — this is
 * best-effort visibility, not a liveness guarantee.
 */
export function isClientDegraded(
  lastActiveAt: Date,
  now: Date,
  heartbeatIntervalMs: number,
): boolean {
  return now.getTime() - lastActiveAt.getTime() > 2 * heartbeatIntervalMs;
}

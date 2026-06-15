/**
 * Reachability retry burst-limiter.
 *
 * When the reachability probe flips to `"ready"`, we
 * want the bus to bounce its SSE connection so the conversation-scoped
 * reconcile pass runs. But we don't want to ask for that bounce
 * forever — three retries inside a 10-second window is enough; past
 * that, surface "Connection lost" so the user can manually retry.
 *
 * Stateful (burst count + window start). Plain module, no React. The
 * caller drives it via `handleReachabilityPhase(phase)` from a
 * `useEffect` keyed on the probe phase.
 *
 * Scope: the budget is hook-instance-scoped (the caller creates one
 * limiter per `useEventStream` mount via `useRef` lazy-init). It is
 * NOT per-conversation — a conversation switch within the same hook
 * instance keeps the existing budget. In practice this matches the
 * 10s burst window: a budget burned on conversation A doesn't
 * "follow" the user to conversation B beyond the rolling window.
 *
 * Side effects:
 *   - on success (within budget, `"ready"` phase): clears turn state
 *     via `onReady()` so the composer stops showing "thinking", clears
 *     the visible error via `onClearError()`, and publishes
 *     `reachability.retry-requested` on the bus.
 *   - on exhaustion (3 retries inside the window): calls
 *     `onExhausted({ message })` so the caller can surface the error
 *     state, then `onReset()` so the reachability probe stops
 *     re-triggering this handler.
 */

import { publish } from "@/lib/event-bus";

const STREAM_RETRY_BURST_WINDOW_MS = 10_000;
const STREAM_RETRY_BURST_LIMIT = 3;

export interface ReachabilityBurstLimiterDeps {
  /** Called on `"ready"` success to clear turn state. */
  onReady: () => void;
  /** Called on `"ready"` success to clear the visible error. */
  onClearError: () => void;
  /** Called on exhaustion to surface the connection-lost error. */
  onExhausted: (error: { message: string }) => void;
  /** Called on exhaustion to reset the reachability probe state. */
  onReset: () => void;
  /** Injected clock for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface ReachabilityBurstLimiter {
  /**
   * Drive the limiter from a reachability phase. Caller invokes this
   * from a `useEffect` keyed on the phase value; all phases other than
   * `"ready"` are no-ops.
   */
  handleReachabilityPhase(phase: string): void;
}

export function createReachabilityBurstLimiter(
  deps: ReachabilityBurstLimiterDeps,
): ReachabilityBurstLimiter {
  const now = deps.now ?? Date.now;
  let burstCount = 0;
  let burstStartedAt = 0;

  return {
    handleReachabilityPhase(phase) {
      if (phase !== "ready") return;

      const nowMs = now();
      if (nowMs - burstStartedAt > STREAM_RETRY_BURST_WINDOW_MS) {
        burstStartedAt = nowMs;
        burstCount = 0;
      }
      burstCount += 1;

      if (burstCount > STREAM_RETRY_BURST_LIMIT) {
        deps.onExhausted({ message: "Connection lost. Please try again." });
        deps.onReset();
        return;
      }

      deps.onReady();
      deps.onClearError();
      publish("reachability.retry-requested", {});
    },
  };
}

/**
 * Grace window armed on return from background, during which a transient
 * fetch/probe failure is held back instead of surfaced as a hard error.
 *
 * On `app.resume` the query focus manager (`lib/query-focus-manager.ts`)
 * refetches every mounted query at once, and the first request after a
 * backgrounded tab frequently fails transiently: the assistant pod may be
 * idle-slept, the probe may race the pod waking, and the background poll
 * timers were throttled so no fresh prior reading exists to fall back on.
 * The failure settles within a few seconds, so any error UI raised from it
 * is a flash the user can neither act on nor understand.
 *
 * Consumers gate their error surface on the returned flag and re-evaluate
 * when it clears, so a genuinely failing load still surfaces its error and
 * retry affordance once the window expires.
 *
 * @see {@link file://./../lib/event-bus.ts} for the resume signal taxonomy
 */

import { useEffect, useState } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";

// Matches the assistant status banner's `wasRecentlyActive` clear window: long
// enough to cover a pod wake plus a retry cycle, short enough that a real
// failure is reported promptly.
let resumeGraceMs = 15_000;

/**
 * Override the resume grace window. Test-only seam so specs can exercise the
 * auto-clear without real-time waits; never call from production code.
 * @internal
 */
export function __setResumeGraceMsForTesting(ms: number): void {
  resumeGraceMs = ms;
}

interface UseResumeGraceOptions {
  /**
   * Also arm the window on the `"online"` resume signal. Off by default,
   * matching the query focus manager, which treats network reconnection as
   * TanStack Query's `onlineManager` concern rather than a focus event.
   * Surfaces whose data is refetched on reconnect (not just on focus) opt in.
   */
  includeOnlineSignal?: boolean;
}

/**
 * Whether a resume grace window is currently active.
 */
export function useResumeGrace({
  includeOnlineSignal = false,
}: UseResumeGraceOptions = {}): boolean {
  const [graceUntil, setGraceUntil] = useState<number | null>(null);

  useBusSubscription("app.resume", ({ signal }) => {
    if (signal === "online" && !includeOnlineSignal) {
      return;
    }
    setGraceUntil(Date.now() + resumeGraceMs);
  });

  // Auto-clear when the window elapses. Keyed on the deadline so a later
  // resume re-arms the timer instead of being collapsed into the first.
  useEffect(() => {
    if (graceUntil === null) {
      return;
    }
    const remaining = graceUntil - Date.now();
    if (remaining <= 0) {
      setGraceUntil(null);
      return;
    }
    const timeout = setTimeout(() => {
      setGraceUntil(null);
    }, remaining);
    return () => clearTimeout(timeout);
  }, [graceUntil]);

  return graceUntil !== null;
}

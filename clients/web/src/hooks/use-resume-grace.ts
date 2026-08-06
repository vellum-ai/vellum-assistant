/**
 * Grace window armed on `app.resume`, during which a transient fetch or probe
 * failure is held back instead of surfaced as a hard error.
 *
 * The query focus manager refetches every mounted query when the client
 * returns from the background, and that first request frequently fails
 * against an idle-slept pod before settling, so any error UI raised from it
 * is a flash the user can neither act on nor understand. Consumers gate their
 * error surface on the returned flag; when it clears, a genuinely failing
 * load surfaces its error and retry affordance as usual.
 */

import { useEffect, useState } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";

// Long enough to cover a pod wake plus a retry cycle, short enough that a real
// failure is reported promptly. Matches the status banner's clear window.
let resumeGraceMs = 15_000;

/**
 * Override the resume grace window. Test-only seam so specs can exercise the
 * auto-clear without real-time waits; never call from production code.
 * @internal
 */
export function __setResumeGraceMsForTesting(ms: number): void {
  resumeGraceMs = ms;
}

/**
 * Whether a resume grace window is currently active.
 */
export function useResumeGrace(): boolean {
  const [graceUntil, setGraceUntil] = useState<number | null>(null);

  useBusSubscription("app.resume", () => {
    setGraceUntil(Date.now() + resumeGraceMs);
  });

  // Keyed on the deadline so a later resume re-arms the timer instead of being
  // collapsed into the first.
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

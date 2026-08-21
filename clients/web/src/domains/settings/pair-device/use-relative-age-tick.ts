import { useEffect, useState } from "react";

/** How often a visible relative age re-renders; 30s suits minute phrasing. */
const AGE_REFRESH_INTERVAL_MS = 30_000;

/**
 * Re-render the caller on a slow tick while `active`, so a relative age label
 * ("Requested 2 minutes ago", "Checked 5 minutes ago") keeps up with the
 * clock. Those labels are formatted from a fixed instant, and neither the
 * pending-request list nor the tunnel probe re-renders on its own between
 * updates, so without a tick the age freezes at whatever it read when the data
 * landed and reports a stale reading as a fresh one.
 */
export function useRelativeAgeTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const intervalId = setInterval(
      () => setTick((tick) => tick + 1),
      AGE_REFRESH_INTERVAL_MS,
    );
    return () => clearInterval(intervalId);
  }, [active]);
}

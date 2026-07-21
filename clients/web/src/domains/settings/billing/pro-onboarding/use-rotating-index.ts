import { useEffect, useState } from "react";

/**
 * Cycles an index through `0..count-1` on a fixed interval while enabled.
 * Rotation only runs when `enabled` and `count > 1`; otherwise the index stays
 * at 0. The interval is cleared and the index reset on unmount and whenever the
 * inputs change.
 */
export function useRotatingIndex(
  count: number,
  opts: { intervalMs: number; enabled: boolean },
): number {
  const { intervalMs, enabled } = opts;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!enabled || count <= 1) {
      setIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % count);
    }, intervalMs);
    return () => {
      clearInterval(timer);
      setIndex(0);
    };
  }, [count, intervalMs, enabled]);

  // Satisfy the documented contract on the same render that disables rotation
  // or shrinks the list, before the reset effect commits: return 0 whenever
  // rotation is inactive, otherwise clamp to the current count.
  if (!enabled || count <= 1) {
    return 0;
  }
  return Math.min(index, count - 1);
}

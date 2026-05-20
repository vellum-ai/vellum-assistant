import { useEffect, useState } from "react";

/**
 * Format seconds for per-tool duration display.
 * Matches macOS VCollapsibleStepRowDurationFormatter: always 1 decimal < 60s,
 * "Xm Ys" for >= 60s.
 */
function formatStepDuration(secs: number): string {
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}m ${s}s`;
}

/**
 * Format seconds for card-header elapsed display.
 * Matches macOS RunningIndicator.formatElapsed: integer seconds < 60s,
 * "Xm Ys" for >= 60s.
 */
function formatHeaderElapsed(secs: number): string {
  const whole = Math.floor(secs);
  if (whole < 60) return `${whole}s`;
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}m ${s}s`;
}

/**
 * Returns a formatted elapsed-time string between a start and optional end
 * timestamp. While `completed` is false, ticks every second to show a live
 * counter. Returns null when `startedAt` is not available.
 *
 * @param mode
 *   - `"step"`: per-tool row duration (always 1 decimal, e.g. "3.2s").
 *     Only returns a value when completed (macOS hides per-tool duration
 *     while running).
 *   - `"header"`: card header elapsed (integer seconds, e.g. "15s").
 *     Hidden until >= 5 seconds have elapsed (macOS convention).
 */
export function useElapsedTime(
  startedAt: number | undefined,
  completed: boolean,
  completedAt: number | undefined,
  mode: "step" | "header" = "step",
): string | null {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (startedAt === undefined || completed || mode === "step") return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [startedAt, completed, mode]);

  if (startedAt === undefined) return null;

  if (mode === "step") {
    if (!completed || completedAt === undefined) return null;
    return formatStepDuration((completedAt - startedAt) / 1000);
  }

  if (completed && completedAt !== undefined) {
    const secs = (completedAt - startedAt) / 1000;
    if (secs < 5) return null;
    return formatHeaderElapsed(secs);
  }

  if (!completed) {
    const secs = (now - startedAt) / 1000;
    if (secs < 5) return null;
    return formatHeaderElapsed(secs);
  }

  return null;
}

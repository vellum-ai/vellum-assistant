import { useEffect, useState } from "react";

/**
 * Format an absolute start time for tooltip / inline display next to a
 * duration. Returns a tooltip-ready string like `Started 11:08:24 AM`
 * (today) or `Started May 19, 11:08:24 AM` (other days). Uses the user's
 * locale; seconds are included because per-step durations are often
 * sub-second.
 *
 * Returns `undefined` when `epoch` is undefined so callers can pass the
 * result straight into a `title` attribute (React drops undefined attrs).
 */
export function formatStartTime(epoch: number | undefined): string | undefined {
  if (epoch === undefined) return undefined;
  const date = new Date(epoch);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  if (isToday) return `Started ${timeStr}`;
  const dayStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `Started ${dayStr}, ${timeStr}`;
}

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
 *   - `"step"`: per-tool row duration. While running, shows a live
 *     integer-seconds counter (e.g. "5s", "1m 3s"); on completion, shows
 *     the precise final duration (1 decimal < 60s, e.g. "3.2s").
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
    if (startedAt === undefined || completed) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [startedAt, completed]);

  if (startedAt === undefined) return null;

  if (mode === "step") {
    if (!completed)
      return formatHeaderElapsed(Math.max(0, now - startedAt) / 1000);
    if (completedAt === undefined) return null;
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

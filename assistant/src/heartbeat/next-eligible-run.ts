/**
 * Pure, side-effect-free calculator for the next time the heartbeat scheduler
 * should wake. It mirrors the predictable guards in `heartbeat-service.ts`
 * (active-hours window and daily-cap reset at local midnight) so the scheduler
 * can sleep until the next genuinely eligible run instead of waking each
 * interval only to record a skip.
 *
 * All inputs are passed in — no DB, config, or clock access — so the result is
 * deterministic given its arguments.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface NextEligibleInput {
  /** Base timestamp (ms), usually Date.now(). */
  from: number;
  intervalMs: number;
  /** Inclusive start hour [0-23] of the active window, or null when unset. */
  activeHoursStart: number | null;
  /** Exclusive end hour [0-23] of the active window, or null when unset. */
  activeHoursEnd: number | null;
  /** IANA timezone for hour extraction; null => local time (Date#getHours). */
  timezone: string | null;
  /** True when countCompletedRunsToday() >= maxDailyRuns. */
  dailyCapReached: boolean;
  /** Injectable hour resolver for deterministic tests. */
  getHourFor?: (ms: number) => number;
}

/**
 * Match `isWithinActiveHours` in heartbeat-service.ts: the window is `[start, end)`,
 * with overnight windows (e.g. 22→6) wrapping past midnight.
 */
function isWithinActiveHours(
  hour: number,
  start: number,
  end: number,
): boolean {
  if (start <= end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}

export function computeNextEligibleRunAt(input: NextEligibleInput): number {
  const {
    from,
    intervalMs,
    activeHoursStart,
    activeHoursEnd,
    timezone,
    dailyCapReached,
  } = input;

  const hourFor =
    input.getHourFor ??
    ((ms: number): number => {
      if (timezone) {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hourCycle: "h23",
          hour: "numeric",
        }).formatToParts(new Date(ms));
        return Number(parts.find((p) => p.type === "hour")!.value);
      }
      return new Date(ms).getHours();
    });

  const hasWindow = activeHoursStart != null && activeHoursEnd != null;

  let candidate = from + intervalMs;

  // Daily cap resets at local midnight, so the earliest the next run can happen
  // is the start of the next local day. Advance hour-by-hour until the local
  // hour wraps to 0 (midnight). The window guard below then nudges to the first
  // active hour when a window is configured.
  if (dailyCapReached) {
    candidate = advanceToNextLocalMidnight(candidate, hourFor);
  }

  // Active-hours guard: advance to the next time the candidate's local hour
  // falls inside the [start, end) window, mirroring heartbeat-service.ts.
  if (hasWindow) {
    let guard = 0;
    while (
      !isWithinActiveHours(hourFor(candidate), activeHoursStart, activeHoursEnd)
    ) {
      candidate += HOUR_MS;
      // Worst case a full day of hours; the bound guards against a runaway loop
      // if the resolver never reports an in-window hour.
      if (++guard > 24) break;
    }
  }

  return candidate > from ? candidate : from + intervalMs;
}

/**
 * Advance `ms` to the start of the next local-day boundary (midnight), detected
 * as the first hour step where the resolved local hour is 0.
 */
function advanceToNextLocalMidnight(
  ms: number,
  hourFor: (ms: number) => number,
): number {
  let cursor = ms;
  // Step forward until the hour wraps to 0. Bounded to one full day.
  for (let i = 0; i < 24; i++) {
    cursor += HOUR_MS;
    if (hourFor(cursor) === 0) {
      return cursor;
    }
  }
  return cursor;
}

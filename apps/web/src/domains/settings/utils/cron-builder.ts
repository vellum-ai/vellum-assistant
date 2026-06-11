/**
 * Pure helpers that translate a structured "cadence" (a friendly frequency +
 * time) into a standard 5-field cron expression and a human-readable summary.
 *
 * The Create-schedule modal builds schedules from approachable controls instead
 * of forcing users to write cron by hand. These functions are the single source
 * of truth for that translation and are kept pure so they can be unit-tested
 * without a DOM.
 */

export type ScheduleFrequency = "hourly" | "daily" | "weekly" | "monthly";

export interface Cadence {
  readonly frequency: ScheduleFrequency;
  /** Minute within the hour, 0–59. Used by every frequency. */
  readonly minute: number;
  /** Hour of day, 0–23. Ignored for hourly. */
  readonly hour24: number;
  /** Selected weekdays, 0 = Sunday … 6 = Saturday. Used by weekly. */
  readonly weekdays: readonly number[];
  /**
   * Day of month for the monthly cadence: 1–28 (days that exist in every
   * month) or "last" for the final day. We deliberately omit 29–31 from the
   * simple builder so a monthly schedule never silently skips short months —
   * those cases remain reachable via the Advanced cron field.
   */
  readonly dayOfMonth: number | "last";
}

/** Sensible starting point: every day at 9:00 AM. */
export const DEFAULT_CADENCE: Cadence = {
  frequency: "daily",
  minute: 0,
  hour24: 9,
  weekdays: [1], // Monday
  dayOfMonth: 1,
};

export interface WeekdayMeta {
  /** Cron day-of-week value (0 = Sunday … 6 = Saturday). */
  readonly value: number;
  /** Single-letter label for compact chips. */
  readonly letter: string;
  /** Abbreviated label, e.g. "Mon". */
  readonly short: string;
  /** Full label, e.g. "Monday". */
  readonly full: string;
}

export const WEEKDAYS: readonly WeekdayMeta[] = [
  { value: 0, letter: "S", short: "Sun", full: "Sunday" },
  { value: 1, letter: "M", short: "Mon", full: "Monday" },
  { value: 2, letter: "T", short: "Tue", full: "Tuesday" },
  { value: 3, letter: "W", short: "Wed", full: "Wednesday" },
  { value: 4, letter: "T", short: "Thu", full: "Thursday" },
  { value: 5, letter: "F", short: "Fri", full: "Friday" },
  { value: 6, letter: "S", short: "Sat", full: "Saturday" },
];

const MONDAY_TO_FRIDAY = [1, 2, 3, 4, 5];

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Unique, sorted weekday list; falls back to Monday when empty. */
export function normalizeWeekdays(weekdays: readonly number[]): number[] {
  const unique = Array.from(
    new Set(
      weekdays
        .map((d) => clampInt(d, 0, 6))
        .filter((d) => Number.isInteger(d)),
    ),
  ).sort((a, b) => a - b);
  return unique.length > 0 ? unique : [1];
}

/** Build a standard 5-field cron expression (minute hour dom month dow). */
export function buildCronExpression(cadence: Cadence): string {
  const minute = clampInt(cadence.minute, 0, 59);
  const hour = clampInt(cadence.hour24, 0, 23);

  switch (cadence.frequency) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${normalizeWeekdays(cadence.weekdays).join(",")}`;
    case "monthly": {
      if (cadence.dayOfMonth === "last") {
        return `${minute} ${hour} L * *`;
      }
      const dayOfMonth = clampInt(cadence.dayOfMonth, 1, 28);
      return `${minute} ${hour} ${dayOfMonth} * *`;
    }
  }
}

/** Format a 24-hour time as a 12-hour clock string, e.g. "9:05 AM". */
export function formatTimeOfDay(hour24: number, minute: number): string {
  const hour = clampInt(hour24, 0, 23);
  const min = clampInt(minute, 0, 59);
  const period = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(min).padStart(2, "0")} ${period}`;
}

/** Format a number with its English ordinal suffix, e.g. 1 → "1st", 22 → "22nd". */
export function formatOrdinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

function describeWeekdays(weekdays: readonly number[]): string {
  const days = normalizeWeekdays(weekdays);
  const set = new Set(days);

  if (days.length === 7) return "every day";
  if (days.length === 5 && MONDAY_TO_FRIDAY.every((d) => set.has(d))) {
    return "every weekday";
  }
  if (days.length === 2 && set.has(0) && set.has(6)) return "every weekend";
  if (days.length === 1) {
    return `every ${WEEKDAYS[days[0]]?.full ?? "day"}`;
  }

  const names = days.map((d) => WEEKDAYS[d]?.short ?? "");
  const last = names.pop();
  return `every ${names.join(", ")} & ${last}`;
}

/**
 * Plain-language description of when a cadence fires, e.g.
 * "Runs every weekday at 9:00 AM".
 */
export function describeCadence(cadence: Cadence): string {
  const time = formatTimeOfDay(cadence.hour24, cadence.minute);

  switch (cadence.frequency) {
    case "hourly": {
      const minute = clampInt(cadence.minute, 0, 59);
      return `Runs every hour at :${String(minute).padStart(2, "0")}`;
    }
    case "daily":
      return `Runs every day at ${time}`;
    case "weekly":
      return `Runs ${describeWeekdays(cadence.weekdays)} at ${time}`;
    case "monthly":
      return cadence.dayOfMonth === "last"
        ? `Runs on the last day of every month at ${time}`
        : `Runs on the ${formatOrdinal(clampInt(cadence.dayOfMonth, 1, 28))} of every month at ${time}`;
  }
}

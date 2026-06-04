import {
  timezoneDayStartEpoch,
  toTimezoneDateString,
} from "@/components/charts/format-date-label";

export type UsageRangeWindowId = "today" | "7d" | "30d" | "90d" | "all";

const RANGE_START_DAY_OFFSETS: Record<
  Exclude<UsageRangeWindowId, "all">,
  number
> = {
  today: 0,
  "7d": 6,
  "30d": 29,
  "90d": 89,
};

/**
 * Resolve the `{ from, to }` epoch-ms window for a usage range, with calendar
 * day boundaries computed in the effective `tz` so they stay aligned with the
 * backend's zone-aware usage buckets.
 */
export function resolveUsageRangeWindow(
  range: UsageRangeWindowId,
  tz: string,
  now: Date | number = Date.now(),
): {
  from: number;
  to: number;
} {
  const to = typeof now === "number" ? now : now.getTime();
  if (range === "all") {
    return { from: 0, to };
  }

  const dayOffset = RANGE_START_DAY_OFFSETS[range];
  const { fromDate } = resolveLastTimezoneCalendarDays(
    dayOffset + 1,
    tz,
    to,
  );
  return {
    from: timezoneDayStartEpoch(fromDate, tz),
    to,
  };
}

export function resolveLastTimezoneCalendarDays(
  days: number,
  tz: string,
  now: Date | number = Date.now(),
): {
  fromDate: string;
  toDate: string;
} {
  const to = typeof now === "number" ? now : now.getTime();
  // Today's calendar date in `tz`, then step back whole days on a UTC-noon
  // anchor to avoid DST slips before resolving zone-local midnight.
  const toDate = toTimezoneDateString(new Date(to), tz);
  const [year, month, day] = toDate.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day, 12));
  anchor.setUTCDate(anchor.getUTCDate() - (days - 1));
  const fromDate = toTimezoneDateString(anchor, "UTC");
  return { fromDate, toDate };
}

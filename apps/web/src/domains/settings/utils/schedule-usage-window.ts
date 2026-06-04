import {
  timezoneDayStartEpoch,
  toTimezoneDateString,
} from "@/components/charts/format-date-label";
import { getEffectiveTimezone } from "@/utils/effective-timezone";

export interface ScheduleUsageWindow {
  from: number;
  to: number;
}

export function resolveScheduleUsageWindow(
  tz: string = getEffectiveTimezone(),
  now: Date | number = Date.now(),
): ScheduleUsageWindow {
  const to = typeof now === "number" ? now : now.getTime();
  const todayInTz = toTimezoneDateString(new Date(to), tz);
  const [year, month, day] = todayInTz.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day, 12));
  anchor.setUTCDate(anchor.getUTCDate() - 6);
  const fromDate = toTimezoneDateString(anchor, "UTC");

  return {
    from: timezoneDayStartEpoch(fromDate, tz),
    to,
  };
}

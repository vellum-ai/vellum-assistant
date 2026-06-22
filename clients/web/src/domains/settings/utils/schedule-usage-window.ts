import { getEffectiveTimezone } from "@/utils/effective-timezone";
import { resolveUsageRangeWindow } from "@/utils/usage-window";

export interface ScheduleUsageWindow {
  from: number;
  to: number;
}

export function resolveScheduleUsageWindow(
  tz: string = getEffectiveTimezone(),
  now: Date | number = Date.now(),
): ScheduleUsageWindow {
  return resolveUsageRangeWindow("7d", tz, now);
}

import { getEffectiveTimezone } from "@/utils/effective-timezone";
import {
  resolveUsageRangeWindow,
  SCHEDULE_USAGE_RANGE,
} from "@/utils/usage-window";

export interface ScheduleUsageWindow {
  from: number;
  to: number;
}

export function resolveScheduleUsageWindow(
  tz: string = getEffectiveTimezone(),
  now: Date | number = Date.now(),
): ScheduleUsageWindow {
  return resolveUsageRangeWindow(SCHEDULE_USAGE_RANGE, tz, now);
}

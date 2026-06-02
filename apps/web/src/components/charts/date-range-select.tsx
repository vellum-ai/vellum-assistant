import { useMemo } from "react";

import {
  Dropdown,
  type DropdownOption,
} from "@vellum/design-library/components/dropdown";

import { toTimezoneDateString } from "@/components/charts/format-date-label";
import { getEffectiveTimezone } from "@/utils/effective-timezone";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

interface DateRangeSelectProps {
  readonly value: DateRange;
  readonly onChange: (range: DateRange) => void;
}

type PresetDays = "7" | "30" | "90";

const PRESET_OPTIONS: ReadonlyArray<DropdownOption<PresetDays>> = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

/**
 * Compute a "last N days" range whose calendar bounds are expressed in the
 * given IANA timezone, so they stay aligned with the `tz` sent to the backend.
 *
 * "Today" is the calendar date in `tz`; the lower bound is that date minus
 * `days - 1`. Day arithmetic runs on a UTC date anchored at noon to avoid DST
 * edge slips when subtracting whole days.
 */
export function computeRangeInTimezone(
  days: number,
  tz: string = getEffectiveTimezone(),
): DateRange {
  const to = toTimezoneDateString(new Date(), tz);
  const [y, m, d] = to.split("-").map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12));
  anchor.setUTCDate(anchor.getUTCDate() - (days - 1));
  const from = toTimezoneDateString(anchor, "UTC");
  return { from, to };
}

function daysBetween(from: string, to: string): number {
  const msPerDay = 86_400_000;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  return Math.round((toDate.getTime() - fromDate.getTime()) / msPerDay) + 1;
}

export function DateRangeSelect({ value, onChange }: DateRangeSelectProps) {
  const tz = useEffectiveTimezone();

  const selectedPreset = useMemo<PresetDays>(() => {
    const days = daysBetween(value.from, value.to);
    if (days === 7) return "7";
    if (days === 90) return "90";
    return "30";
  }, [value.from, value.to]);

  const handleChange = (preset: PresetDays) => {
    onChange(computeRangeInTimezone(Number(preset), tz));
  };

  return (
    <Dropdown<PresetDays>
      options={PRESET_OPTIONS}
      value={selectedPreset}
      onChange={handleChange}
      aria-label="Date range"
    />
  );
}

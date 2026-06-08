import { useMemo } from "react";

import {
    Dropdown,
    type DropdownOption,
} from "@vellumai/design-library/components/dropdown";

import { getEffectiveTimezone } from "@/utils/effective-timezone";
import { resolveLastTimezoneCalendarDays } from "@/utils/usage-window";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

interface DateRangeSelectProps {
  readonly value: DateRange;
  /**
   * Called when the user picks a preset. Emits both the computed range and the
   * preset identity (`days`) so consumers can persist the active preset and
   * recompute its bounds on a timezone change without reverse-matching.
   */
  readonly onChange: (range: DateRange, presetDays: number) => void;
}

/**
 * Single source of truth for the relative presets this control exposes. Other
 * modules (e.g. billing reconciliation) iterate this to recompute whichever
 * preset is active when the effective timezone changes.
 */
export const PRESET_DAYS = [7, 30, 90] as const;

/** Preset selected by default (matches the "Last 30 days" billing default). */
export const DEFAULT_PRESET_DAYS = 30;

type PresetDays = `${(typeof PRESET_DAYS)[number]}`;

const PRESET_OPTIONS: ReadonlyArray<DropdownOption<PresetDays>> = PRESET_DAYS.map(
  (days) => ({ value: `${days}`, label: `Last ${days} days` }),
);

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
  const { fromDate, toDate } = resolveLastTimezoneCalendarDays(days, tz);
  return { from: fromDate, to: toDate };
}

function daysBetween(from: string, to: string): number {
  const msPerDay = 86_400_000;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  return Math.round((toDate.getTime() - fromDate.getTime()) / msPerDay) + 1;
}

/**
 * Map a range's span to the preset identity (`days`) this control would show
 * for it, defaulting to `DEFAULT_PRESET_DAYS` for any span that isn't 7 or 90.
 * Shared so consumers can derive the active preset with the same rule the
 * dropdown uses for its selected option.
 */
export function presetDaysFromRange({ from, to }: DateRange): number {
  const days = daysBetween(from, to);
  if (days === 7) return 7;
  if (days === 90) return 90;
  return DEFAULT_PRESET_DAYS;
}

export function DateRangeSelect({ value, onChange }: DateRangeSelectProps) {
  const tz = useEffectiveTimezone();

  const selectedPreset = useMemo<PresetDays>(
    () => `${presetDaysFromRange(value)}` as PresetDays,
    [value],
  );

  const handleChange = (preset: PresetDays) => {
    const days = Number(preset);
    onChange(computeRangeInTimezone(days, tz), days);
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

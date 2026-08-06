import {
  Select,
  type SelectOption,
} from "@vellumai/design-library/components/select";

import { getEffectiveTimezone } from "@/utils/effective-timezone";
import { resolveLastTimezoneCalendarDays } from "@/utils/usage-window";

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

interface DateRangeSelectProps {
  /**
   * The active preset's identity (`days`), not its bounds. Deriving bounds is
   * the consumer's job, because only the consumer knows when they need
   * recomputing. Recovering the identity by measuring a range's span cannot
   * distinguish the 30-day preset from any other span that rounds to it.
   */
  readonly value: number;
  readonly onChange: (presetDays: number) => void;
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

const PRESET_OPTIONS: ReadonlyArray<SelectOption<PresetDays>> = PRESET_DAYS.map(
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

export function DateRangeSelect({ value, onChange }: DateRangeSelectProps) {
  // A value that is not one of the presets has no row to show, so fall back to
  // the default rather than render a blank trigger.
  const selected =
    PRESET_DAYS.find((days) => days === value) ?? DEFAULT_PRESET_DAYS;

  return (
    <Select<PresetDays>
      options={PRESET_OPTIONS}
      value={`${selected}`}
      onChange={(preset) => onChange(Number(preset))}
      aria-label="Date range"
    />
  );
}

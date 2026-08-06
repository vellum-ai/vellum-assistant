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
   * recomputing; recovering the identity from a range here would be lossy, as
   * {@link presetDaysFromRange} shows.
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

function daysBetween(from: string, to: string): number {
  const msPerDay = 86_400_000;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  return Math.round((toDate.getTime() - fromDate.getTime()) / msPerDay) + 1;
}

/**
 * Map a range's span to the preset identity (`days`) it best corresponds to,
 * defaulting to `DEFAULT_PRESET_DAYS` for any span that isn't 7 or 90.
 *
 * Lossy, and a last resort: it cannot tell a 30-day preset from any other span
 * it rounds to 30, so a consumer that knows which preset is active should track
 * that identity rather than recover it from bounds.
 */
export function presetDaysFromRange({ from, to }: DateRange): number {
  const days = daysBetween(from, to);
  if (days === 7) {
    return 7;
  }
  if (days === 90) {
    return 90;
  }
  return DEFAULT_PRESET_DAYS;
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

/**
 * Locale-aware relative-time formatting over a shared, per-locale-cached
 * `Intl.RelativeTimeFormat` (construction is expensive; reuse is the
 * documented pattern). Callers own any domain-specific phrasing around it,
 * e.g. a "just now" cutoff.
 *
 * Reference: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/RelativeTimeFormat
 */

const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
];

/** Units a caller may clamp the phrasing at (largest-to-smallest granularity). */
export type RelativeTimeMinimumUnit = (typeof UNITS)[number]["unit"];

const formatters = new Map<string, Intl.RelativeTimeFormat | null>();

function getFormatter(locale: string | undefined): Intl.RelativeTimeFormat | null {
  const key = locale ?? "";
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter =
      typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl
        ? new Intl.RelativeTimeFormat(locale, {
            style: "long",
            numeric: "auto",
          })
        : null;
    formatters.set(key, formatter);
  }
  return formatter;
}

export interface FormatRelativeTimeOptions {
  /** BCP 47 locale tag; defaults to the host environment's locale. */
  locale?: string;
  /**
   * Smallest unit to phrase in; a difference below it reads as "now"
   * (`format(0, "second")` under `numeric: "auto"`). Defaults to `"second"`.
   */
  minimumUnit?: RelativeTimeMinimumUnit;
}

/**
 * Relative label for an instant against the current time, e.g. "2 minutes
 * ago" / "in 3 days". Falls back to an absolute `toLocaleString()` where
 * `Intl.RelativeTimeFormat` is unavailable.
 */
export function formatRelativeTime(
  epochMs: number,
  options: FormatRelativeTimeOptions = {},
): string {
  const formatter = getFormatter(options.locale);
  if (!formatter) {
    return new Date(epochMs).toLocaleString();
  }
  const diff = epochMs - Date.now();
  const absDiff = Math.abs(diff);
  const minIndex = UNITS.findIndex(
    ({ unit }) => unit === (options.minimumUnit ?? "second"),
  );
  for (const { unit, ms } of UNITS.slice(0, minIndex + 1)) {
    if (absDiff >= ms) {
      return formatter.format(Math.round(diff / ms), unit);
    }
  }
  return formatter.format(0, "second");
}

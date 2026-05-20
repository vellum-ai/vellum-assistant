const RELATIVE_FORMATTER =
  typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl
    ? new Intl.RelativeTimeFormat(undefined, { style: "long", numeric: "auto" })
    : null;

const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
];

export function formatRelativeTime(epochMs: number): string {
  const diff = epochMs - Date.now();
  const absDiff = Math.abs(diff);
  if (absDiff < 30_000) return "just now";
  if (!RELATIVE_FORMATTER) {
    return new Date(epochMs).toLocaleString();
  }
  for (const { unit, ms } of UNITS) {
    if (absDiff >= ms || unit === "second") {
      const value = Math.round(diff / ms);
      return RELATIVE_FORMATTER.format(value, unit);
    }
  }
  return RELATIVE_FORMATTER.format(Math.round(diff / 1000), "second");
}

export function formatAbsoluteDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

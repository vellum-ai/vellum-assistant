/**
 * Format a "YYYY-MM-DD" date string as a short label such as "Apr 24".
 */
export function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Format a `Date` as a "YYYY-MM-DD" string using local time.
 */
export function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Format a `Date` as a "YYYY-MM-DD" string representing the calendar date in
 * the given IANA timezone. `en-CA` yields ISO-like `YYYY-MM-DD` output.
 */
export function toTimezoneDateString(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

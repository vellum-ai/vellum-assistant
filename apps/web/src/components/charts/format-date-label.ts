/**
 * Format a "YYYY-MM-DD" date string as a short label such as "Apr 24".
 */
export function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

/**
 * Epoch ms for the start of the calendar day `dateStr` ("YYYY-MM-DD") as it
 * occurs in the given IANA timezone — i.e. zone-local midnight. DST-safe:
 * derives the zone's UTC offset at that instant and subtracts it, so the
 * returned epoch maps back to 00:00 wall-clock in `tz`.
 */
export function timezoneDayStartEpoch(dateStr: string, tz: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Provisional UTC midnight, then correct by the zone offset observed there.
  const utcMidnight = Date.UTC(y, m - 1, d);
  const offsetMs = utcMidnight - zonedWallClockEpoch(new Date(utcMidnight), tz);
  return utcMidnight + offsetMs;
}

/**
 * Interpret the wall-clock time that `instant` shows in `tz` as if it were UTC,
 * returning that as epoch ms. Used to recover a zone's UTC offset.
 */
function zonedWallClockEpoch(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
}

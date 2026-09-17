/**
 * The compact timestamp a mail list draws: the clock time for a message from
 * today, the month and day for anything older, and the year once it is not
 * this year. `now` is a parameter so the fixtures in stories and tests render
 * the same string on every run.
 */
export function formatEmailListTime(
  iso: string,
  now: Date,
  locale: string,
): string {
  const date = new Date(iso);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** The full timestamp the reading pane draws under the subject. */
export function formatEmailDetailTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** `1.2 MB`, `340 KB`, `12 B`: enough precision for an attachment chip. */
export function formatAttachmentSize(bytes: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unitIndex],
    unitDisplay: "narrow",
    maximumFractionDigits: value < 10 && unitIndex > 0 ? 1 : 0,
  }).format(value);
}

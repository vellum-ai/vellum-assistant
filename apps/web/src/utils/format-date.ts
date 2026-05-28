/**
 * Format a date as a short, human-readable string (e.g., "27 May" or "27 May 2025").
 * Omits the year when it matches the current year, unless `alwaysShowYear` is set.
 */
export function formatFriendlyDate(
  date: Date,
  opts?: { alwaysShowYear?: boolean },
): string {
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year:
      opts?.alwaysShowYear ||
      date.getFullYear() !== new Date().getFullYear()
        ? "numeric"
        : undefined,
  });
}

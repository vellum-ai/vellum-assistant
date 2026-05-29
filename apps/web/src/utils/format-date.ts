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

/**
 * Compact relative-time label for inline metadata ("just now", "2h ago").
 * Mirrors the macOS client's `Date.relativeShortString()`.
 */
export function formatRelativeDate(
  dateStr: string | null | undefined,
): string {
  if (!dateStr) {
    return "—";
  }

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const MINUTE_MS = 1000 * 60;
  const HOUR_MS = MINUTE_MS * 60;
  const DAY_MINUTES = 60 * 24;
  const DAY_MS = MINUTE_MS * DAY_MINUTES;

  if (diffMs < 0) {
    const absDiffMs = -diffMs;
    if (absDiffMs < HOUR_MS) {
      return "in <1h";
    }
    const roundedMinutes = Math.round(absDiffMs / MINUTE_MS);
    const hours = Math.round(roundedMinutes / 60);
    if (hours < 24) {
      return `in ${hours}h`;
    }
    return `in ${Math.round(roundedMinutes / DAY_MINUTES)}d`;
  }

  const diffDays = Math.floor(diffMs / DAY_MS);
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / HOUR_MS);
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / MINUTE_MS);
      return diffMins <= 1 ? "just now" : `${diffMins}m ago`;
    }
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) {
    return "yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks}w ago`;
  }
  return date.toLocaleDateString();
}

/**
 * Full local timestamp with timezone abbreviation for tooltip display.
 * e.g. "May 29, 2026, 10:36 AM EDT"
 */
export function formatFullLocalDate(
  dateStr: string | null | undefined,
): string {
  if (!dateStr) {
    return "";
  }
  return new Date(dateStr).toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

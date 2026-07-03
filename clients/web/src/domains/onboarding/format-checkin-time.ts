/**
 * Format the booked check-in start (ISO string from the daemon's
 * /onboarding/checkin response) into a short wall-clock time like "2:30 PM",
 * rendered in the event's own timeZone when one is supplied. Returns null for
 * an unparseable/empty input so callers can fall back to generic copy.
 */
export function formatCheckinTime(
  startIso: string | undefined | null,
  timeZone?: string | null,
): string | null {
  if (!startIso) return null;
  const date = new Date(startIso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    // Bad/unknown timeZone → format in the local zone rather than throw.
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
}

/**
 * Human phrase for the moment the daily credit limit resets. The platform
 * resets the spend counter at midnight UTC; this expresses that moment in the
 * viewer's clock: "5:00 PM your time (midnight UTC)", or just "midnight UTC"
 * when the viewer's clock aligns with UTC midnight.
 *
 * Computed from the actual next UTC midnight so DST transitions land on the
 * right local hour. `timeZone` and `now` are injectable for tests; production
 * callers pass neither.
 */
export function dailyResetTimePhrase(
  timeZone?: string,
  now: Date = new Date(),
): string {
  const nextUtcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const localTime = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(nextUtcMidnight);
  if (localTime === "12:00 AM") {
    return "midnight UTC";
  }
  return `${localTime} your time (midnight UTC)`;
}

/**
 * Human phrase for the moment the daily credit limit resets. The platform
 * resets the spend counter at midnight UTC; this expresses that moment in the
 * viewer's clock with a timezone label: "5:00 PM MT". The generic zone name
 * avoids DST-specific abbreviations (MT, not MDT); zones without one fall
 * back to a location or offset label ("India Time", "GMT+2").
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
  return (
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "shortGeneric",
      ...(timeZone ? { timeZone } : {}),
    })
      .format(nextUtcMidnight)
      // Some ICU builds separate the time from AM/PM with a narrow no-break
      // space; normalize so the copy is runtime-independent.
      .replace(/ /g, " ")
  );
}

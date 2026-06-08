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
 * resolves the zone-local wall clock 00:00:00 to its UTC instant via a
 * two-pass technique, so it stays correct even on DST-transition days where
 * the zone's offset differs between local- and UTC-midnight.
 */
export function timezoneDayStartEpoch(dateStr: string, tz: string): number {
  // Desired wall clock, scalarized by treating its Y-M-D-H-M-S as if UTC.
  const desired = Date.parse(dateStr + "T00:00:00Z");
  // First guess: interpret the desired wall clock as if it were UTC, then
  // correct by the offset between the wall clock `guess` actually shows in
  // `tz` and the desired one. A second pass converges DST-boundary days.
  let guess = desired;
  for (let pass = 0; pass < 2; pass++) {
    const observed = zonedWallClockEpoch(new Date(guess), tz);
    guess -= observed - desired;
  }

  // Nonexistent-midnight (spring-forward) gap: some zones advance the clock
  // *at* local midnight (e.g. America/Santiago), so the wall time 00:00:00
  // never occurs on `dateStr`. The two-pass convergence then lands on the
  // last pre-gap instant, which still belongs to the *previous* local date.
  // Detect that by re-formatting the guess in `tz`: if its calendar date is
  // earlier than `dateStr`, midnight was skipped. The correct answer is the
  // first valid instant on `dateStr` — i.e. the moment the clock jumps
  // forward — so advance the guess by the gap size (the offset jump across
  // the transition), which lands exactly on the post-transition wall clock.
  if (toTimezoneDateString(new Date(guess), tz) < dateStr) {
    const offsetBefore = zonedWallClockEpoch(new Date(guess), tz) - guess;
    const afterGap = guess + 60 * 60 * 1000;
    const offsetAfter = zonedWallClockEpoch(new Date(afterGap), tz) - afterGap;
    // gapMs is positive (typically one hour); adding it skips the missing
    // local hour and lands on the first instant whose wall clock is `dateStr`.
    const gapMs = offsetAfter - offsetBefore;
    guess += gapMs;
  }
  return guess;
}

/**
 * Read the wall clock that `instant` shows in `tz` and scalarize it by
 * treating its Y-M-D-H-M-S as if UTC, returning that as epoch ms. Used to
 * compare an observed wall clock against a desired one.
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

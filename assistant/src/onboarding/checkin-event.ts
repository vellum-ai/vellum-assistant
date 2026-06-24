/**
 * Pure helpers for the programmatic "Day 2 Check-in" onboarding meeting.
 *
 * The check-in used to be scheduled conversationally: the web client minted a
 * dedicated conversation and posted a natural-language prompt instructing the
 * assistant to pull the calendar and book a slot. This module replaces that
 * with deterministic logic that runs server-side the moment Google Calendar
 * OAuth lands — find the first open 15-minute slot in the user's local
 * afternoon tomorrow and build the event.
 *
 * The event's title typography and HTML description are kept VERBATIM from the
 * old prompt (`clients/web/.../checkin-prompt.ts`): locked title rules, tested
 * HTML-sanitization-safe body, default first-run substitutions, and the
 * deep-link CTA back into the app. Only the slot SELECTION changed — it is now
 * a fixed window rather than a model judgment call.
 *
 * Everything here is side-effect-free and timezone-pure so it can be unit
 * tested without a calendar connection; the orchestration that actually talks
 * to Google lives in `schedule-checkin.ts`.
 */

/** Length of the check-in meeting. */
export const CHECKIN_DURATION_MINUTES = 15;

/**
 * Primary booking window in the user's local clock: the first open 15-minute
 * slot between 12pm and 5pm tomorrow.
 */
export const PRIMARY_WINDOW = { startHour: 12, endHour: 17 } as const;

/**
 * Fallback window when the primary 12pm–5pm window is fully booked: widen on
 * both ends to 8am–8pm and take the earliest open slot there.
 */
export const WIDE_WINDOW = { startHour: 8, endHour: 20 } as const;

/** The fixed, single-encoded first-week prompt carried by the CTA deep link. */
const CTA_ENCODED_PROMPT =
  "What%20would%20you%20recommend%20I%20tackle%20first%20this%20week%3F%20Propose%20it%20but%20wait%20for%20my%20go-ahead%20before%20doing%20anything";

export interface CheckinNames {
  /** The user's collected name. Blank/omitted → dropped from the title. */
  userName?: string;
  /** The assistant's display name. Blank/omitted → dropped from the title. */
  assistantName?: string;
}

/**
 * Build the check-in event title. Locked typography — mirrors the four cases
 * the original prompt documented:
 *   both names → `{me} <> {you}: Day 2 Check-in`
 *   me only    → `{me}: Day 2 Check-in`
 *   you only   → `{you}: Day 2 Check-in`
 *   neither    → `Day 2 Check-in`
 */
export function buildCheckinTitle({
  userName,
  assistantName,
}: CheckinNames): string {
  const me = userName?.trim();
  const you = assistantName?.trim();
  if (me && you) return `${me} <> ${you}: Day 2 Check-in`;
  if (me) return `${me}: Day 2 Check-in`;
  if (you) return `${you}: Day 2 Check-in`;
  return "Day 2 Check-in";
}

/**
 * Build the HTML event description with the default first-run substitutions.
 *
 * Google Calendar strips nearly all styling, so the body relies only on the
 * tags that survive (`<p>`, `<strong>`, `<a>`, emoji) and makes the CTA a bold
 * link rather than a styled button. The deep link opens a fresh conversation
 * (`uuid`) pre-seeded with the first-week prompt.
 */
export function buildCheckinDescription(uuid: string): string {
  const href = `https://www.vellum.ai/assistant/conversations/${uuid}?prompt=${CTA_ENCODED_PROMPT}`;
  return [
    "<p>👋 <strong>Hi, it was great to meet you properly.</strong></p>",
    "<p>You just set me up, and I've already started learning <strong>what you're working on</strong>. This 15 minutes is the natural place to put that to work. I'll walk you through one thing I'd like to do for you this week.</p>",
    `<p><a href="${href}"><strong>Let's go →</strong></a></p>`,
    "<p>Click the link and we'll get started.</p>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Timezone math
//
// We resolve wall-clock windows ("tomorrow 12:00 in America/New_York") to
// absolute instants using Intl, so DST transitions and arbitrary offsets are
// handled without a date library.
// ---------------------------------------------------------------------------

/**
 * Offset (local − UTC, in ms) that `timeZone` has at the given instant.
 * Derived by formatting the instant in the zone and diffing the wall clock.
 */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  // `hourCycle: h23` can emit "24" for midnight on some runtimes — normalize.
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - utcMs;
}

/**
 * Convert a wall-clock time in `timeZone` to an absolute epoch-ms instant.
 * Refines once to settle DST boundaries where the naive offset guess differs
 * from the offset that actually applies at the resolved instant.
 */
export function zonedWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

/** Calendar date (1-based month) that is "tomorrow" in `timeZone` at `nowMs`. */
export function tomorrowInTimeZone(
  nowMs: number,
  timeZone: string,
): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(nowMs))) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  // Add a day via UTC arithmetic (handles month/year rollover), then read the
  // wall-clock date back out — we only care about Y/M/D, not the instant.
  const tomorrow = new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)) +
      24 * 60 * 60 * 1000,
  );
  return {
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
  };
}

// ---------------------------------------------------------------------------
// Slot finding
// ---------------------------------------------------------------------------

/** A half-open busy interval `[start, end)` in epoch ms. */
export interface BusyInterval {
  start: number;
  end: number;
}

/**
 * Earliest start (epoch ms) of a free `durationMs` slot inside
 * `[windowStart, windowEnd)`, or `null` if the window is fully booked.
 *
 * Walks the busy intervals in order, advancing a cursor past each overlap; the
 * first gap wide enough to fit the duration wins. This returns the *first*
 * open slot, which is exactly the "first open time slot in the window"
 * behavior the onboarding flow wants.
 */
export function findFirstOpenSlot(
  windowStart: number,
  windowEnd: number,
  busy: BusyInterval[],
  durationMs: number,
): number | null {
  const relevant = busy
    .filter((b) => b.end > windowStart && b.start < windowEnd)
    .sort((a, b) => a.start - b.start);

  let cursor = windowStart;
  for (const interval of relevant) {
    if (interval.start - cursor >= durationMs) {
      return cursor;
    }
    if (interval.end > cursor) {
      cursor = interval.end;
    }
    if (cursor + durationMs > windowEnd) {
      return null;
    }
  }
  return cursor + durationMs <= windowEnd ? cursor : null;
}

export interface ChosenSlot {
  /** Slot start, epoch ms. */
  startMs: number;
  /** Slot end, epoch ms. */
  endMs: number;
  /** Which window the slot came from — drives logging/telemetry only. */
  window: "primary" | "wide" | "fallback";
}

/**
 * Pick the check-in slot for tomorrow in `timeZone` given the busy intervals.
 *
 * 1. First open 15-min slot in 12pm–5pm.
 * 2. If that window is full, widen to 8am–8pm and take the earliest open slot.
 * 3. If even that is full (pathological), fall back to 12:00 so a reminder
 *    still lands — better an overlapping check-in than none.
 */
export function chooseCheckinSlot(
  nowMs: number,
  timeZone: string,
  busy: BusyInterval[],
): ChosenSlot {
  const { year, month, day } = tomorrowInTimeZone(nowMs, timeZone);
  const durationMs = CHECKIN_DURATION_MINUTES * 60 * 1000;

  const at = (hour: number) =>
    zonedWallTimeToUtcMs(year, month, day, hour, 0, timeZone);

  const primaryStart = at(PRIMARY_WINDOW.startHour);
  const primaryEnd = at(PRIMARY_WINDOW.endHour);
  const wideStart = at(WIDE_WINDOW.startHour);
  const wideEnd = at(WIDE_WINDOW.endHour);

  const primary = findFirstOpenSlot(primaryStart, primaryEnd, busy, durationMs);
  if (primary !== null) {
    return { startMs: primary, endMs: primary + durationMs, window: "primary" };
  }

  const wide = findFirstOpenSlot(wideStart, wideEnd, busy, durationMs);
  if (wide !== null) {
    return { startMs: wide, endMs: wide + durationMs, window: "wide" };
  }

  return {
    startMs: primaryStart,
    endMs: primaryStart + durationMs,
    window: "fallback",
  };
}

/** Window covering both the primary and fallback ranges — the free/busy query span. */
export function checkinFreeBusyWindow(
  nowMs: number,
  timeZone: string,
): { timeMinMs: number; timeMaxMs: number } {
  const { year, month, day } = tomorrowInTimeZone(nowMs, timeZone);
  return {
    timeMinMs: zonedWallTimeToUtcMs(
      year,
      month,
      day,
      WIDE_WINDOW.startHour,
      0,
      timeZone,
    ),
    timeMaxMs: zonedWallTimeToUtcMs(
      year,
      month,
      day,
      WIDE_WINDOW.endHour,
      0,
      timeZone,
    ),
  };
}

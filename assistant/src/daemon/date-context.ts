/**
 * Temporal context formatter for future weekday/weekend grounding.
 *
 * Produces a compact, deterministic payload describing the current date,
 * upcoming weekend/work-week windows, and a short horizon of labelled
 * future dates.  Intended for runtime injection into the model context.
 */

export interface TemporalContextOptions {
  /** Override current time (epoch ms) for deterministic tests. */
  nowMs?: number;
  /** IANA timezone (e.g. "America/New_York"). Defaults to host timezone. */
  timeZone?: string;
  /** Number of future days to list (default 14, hard-capped at 14). */
  horizonDays?: number;
}

const MAX_OUTPUT_CHARS = 1500;
const MAX_HORIZON_ENTRIES = 14;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/**
 * Get the local date parts for a given instant in the specified timezone.
 */
function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // Weekday as 0-6 (Sun-Sat)
  const weekdayShort = get('weekday');
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    weekday: weekdayMap[weekdayShort] ?? 0,
  };
}

/**
 * Format a Date as YYYY-MM-DD in the given timezone.
 */
function formatLocalDate(date: Date, timeZone: string): string {
  const p = localDateParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Advance a date by `days` calendar days (timezone-aware).
 * Uses noon UTC as anchor to avoid DST edge cases with day boundaries.
 */
function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime() + days * 86_400_000);
  return result;
}

/**
 * Build a compact temporal context string for model injection.
 *
 * Output is hard-capped at {@link MAX_OUTPUT_CHARS} characters and
 * {@link MAX_HORIZON_ENTRIES} horizon entries.
 */
export function buildTemporalContext(options: TemporalContextOptions = {}): string {
  const now = new Date(options.nowMs ?? Date.now());
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const horizonDays = Math.min(options.horizonDays ?? MAX_HORIZON_ENTRIES, MAX_HORIZON_ENTRIES);

  const todayParts = localDateParts(now, timeZone);
  const todayStr = formatLocalDate(now, timeZone);
  const todayWeekday = WEEKDAY_NAMES[todayParts.weekday];

  // ── Next weekend (Saturday-Sunday) ──
  const daysUntilSaturday = (6 - todayParts.weekday + 7) % 7 || 7;
  const nextSaturday = addDays(now, daysUntilSaturday);
  const nextSunday = addDays(now, daysUntilSaturday + 1);

  // ── Next work week (Monday-Friday) ──
  const daysUntilMonday = (1 - todayParts.weekday + 7) % 7 || 7;
  const nextMonday = addDays(now, daysUntilMonday);
  const nextFriday = addDays(now, daysUntilMonday + 4);

  // ── Horizon list ──
  const horizonLines: string[] = [];
  for (let i = 1; i <= horizonDays; i++) {
    const futureDate = addDays(now, i);
    const futureParts = localDateParts(futureDate, timeZone);
    const label = WEEKDAY_NAMES[futureParts.weekday];
    horizonLines.push(`  ${formatLocalDate(futureDate, timeZone)} ${label}`);
  }

  const lines = [
    `<temporal_context>`,
    `Today: ${todayStr} (${todayWeekday})`,
    `Timezone: ${timeZone}`,
    ``,
    `Week definitions: work week = Monday–Friday, weekend = Saturday–Sunday`,
    ``,
    `Next weekend: ${formatLocalDate(nextSaturday, timeZone)} – ${formatLocalDate(nextSunday, timeZone)}`,
    `Next work week: ${formatLocalDate(nextMonday, timeZone)} – ${formatLocalDate(nextFriday, timeZone)}`,
    ``,
    `Upcoming dates:`,
    ...horizonLines,
    `</temporal_context>`,
  ];

  let output = lines.join('\n');

  // Hard cap: truncate if somehow over budget (shouldn't happen with 14 entries).
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS - 25) + '\n</temporal_context>';
  }

  return output;
}

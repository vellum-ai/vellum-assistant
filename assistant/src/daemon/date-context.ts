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
  /** IANA timezone for the assistant host clock (defaults to process local timezone). */
  hostTimeZone?: string;
  /** IANA timezone configured in user settings (if available). */
  configuredUserTimeZone?: string | null;
  /** IANA timezone inferred from user profile/memory (if available). */
  userTimeZone?: string | null;
  /** Number of future days to list (default 14, hard-capped at 14). */
  horizonDays?: number;
}

const MAX_OUTPUT_CHARS = 1500;
const MAX_HORIZON_ENTRIES = 14;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const UTC_GMT_OFFSET_TOKEN_RE = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/i;

function normalizeOffsetToken(offsetToken: string): string {
  if (offsetToken === "GMT" || offsetToken === "UTC") {
    return "+00:00";
  }
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(offsetToken);
  if (!match) {
    return "+00:00";
  }
  const [, sign, hours, minutes] = match;
  return `${sign}${hours.padStart(2, "0")}:${(minutes ?? "00").padStart(
    2,
    "0",
  )}`;
}

function canonicalizeUtcGmtOffsetToken(offsetToken: string): string | null {
  if (/^(?:UTC|GMT)$/i.test(offsetToken)) {
    return "UTC";
  }
  const match = offsetToken.match(UTC_GMT_OFFSET_TOKEN_RE);
  if (!match) {
    return null;
  }
  const [, sign, hoursRaw, minutesRaw] = match;
  const hours = Number.parseInt(hoursRaw, 10);
  const minutes = Number.parseInt(minutesRaw ?? "0", 10);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  if (hours > 14 || minutes > 59) {
    return null;
  }
  const totalMinutes = (hours * 60 + minutes) * (sign === "+" ? 1 : -1);
  if (Math.abs(totalMinutes) > 14 * 60) {
    return null;
  }
  if (totalMinutes === 0) {
    return "UTC";
  }
  const absTotalMinutes = Math.abs(totalMinutes);
  const absHours = Math.floor(absTotalMinutes / 60);
  const absMinutes = absTotalMinutes % 60;
  const offsetSign = totalMinutes > 0 ? "+" : "-";

  // For whole-hour offsets, prefer `Etc/GMT` for stable canonicalization.
  if (absMinutes === 0) {
    // `Etc/GMT` uses POSIX sign semantics: east-of-UTC offsets use a minus sign.
    const etcSign = totalMinutes > 0 ? "-" : "+";
    return `Etc/GMT${etcSign}${absHours}`;
  }

  // Bun/Intl accepts fixed-offset IDs in ±HH:MM format.
  return `${offsetSign}${String(absHours).padStart(2, "0")}:${String(
    absMinutes,
  ).padStart(2, "0")}`;
}

function canonicalizeTimeZone(timeZone: string): string | null {
  const trimmed = timeZone.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const canonicalOffset = canonicalizeUtcGmtOffsetToken(trimmed);
  if (canonicalOffset) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: canonicalOffset,
      }).resolvedOptions().timeZone;
    } catch {
      return null;
    }
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: trimmed,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Regex matching IANA timezone identifiers (e.g. "America/New_York") and
 * UTC/GMT offset tokens (e.g. "UTC+5", "GMT-8:30").
 */
const TIMEZONE_TOKEN_RE =
  /\b(?:[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+|(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?)\b/gi;

/**
 * Extract the user's timezone from V2 memory recall injected text.
 *
 * Scans the `<user_identity>` section (if present) for lines containing
 * "timezone" and tries to resolve an IANA identifier. Falls back to
 * scanning the full text body.
 */
export function extractUserTimeZoneFromRecall(
  injectedText: string,
): string | null {
  if (!injectedText || injectedText.trim().length === 0) return null;

  // Prefer lines inside <user_identity> that mention "timezone"
  const identityMatch = injectedText.match(
    /<user_identity>([\s\S]*?)<\/user_identity>/,
  );
  if (identityMatch) {
    const identityBlock = identityMatch[1];
    for (const line of identityBlock.split("\n")) {
      if (/time\s*zone/i.test(line)) {
        for (const token of extractTimeZoneCandidates(line)) {
          const canonical = canonicalizeTimeZone(token);
          if (canonical) return canonical;
        }
      }
    }
    // Scan full identity block for any timezone token
    for (const token of extractTimeZoneCandidates(identityBlock)) {
      const canonical = canonicalizeTimeZone(token);
      if (canonical) return canonical;
    }
  }

  // Fallback: scan entire injected text for timezone tokens in
  // lines that mention "timezone"
  for (const line of injectedText.split("\n")) {
    if (/time\s*zone/i.test(line)) {
      for (const token of extractTimeZoneCandidates(line)) {
        const canonical = canonicalizeTimeZone(token);
        if (canonical) return canonical;
      }
    }
  }

  return null;
}

function extractTimeZoneCandidates(text: string): string[] {
  const matches = (text.match(TIMEZONE_TOKEN_RE) ?? [])
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const ianaTokens = matches.filter((token) => token.includes("/"));
  const offsetTokens = matches.filter((token) => !token.includes("/"));
  return [...ianaTokens, ...offsetTokens];
}

/**
 * Get the local date parts for a given instant in the specified timezone.
 */
function localDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Weekday as 0-6 (Sun-Sat)
  const weekdayShort = get("weekday");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    weekday: weekdayMap[weekdayShort] ?? 0,
  };
}

/**
 * Format a Date as YYYY-MM-DD in the given timezone.
 */
function formatLocalDate(date: Date, timeZone: string): string {
  const p = localDateParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(
    p.day,
  ).padStart(2, "0")}`;
}

/**
 * Format a Date as local ISO 8601 with timezone offset in the given timezone.
 */
function formatLocalIsoWithOffset(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const offset = normalizeOffsetToken(get("timeZoneName"));
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

/**
 * Advance a date by `days` calendar days in the given timezone.
 *
 * Computes the local date, adds days to the day component, then anchors
 * the result at noon local time to avoid DST-transition edge cases.
 */
function addDays(date: Date, days: number, timeZone: string): Date {
  const parts = localDateParts(date, timeZone);
  // Use Date.UTC for calendar overflow (e.g. Jan 32 → Feb 1).
  const ref = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  const tY = ref.getUTCFullYear();
  const tM = ref.getUTCMonth() + 1;
  const tD = ref.getUTCDate();
  // Noon UTC covers UTC-12 through ~UTC+11.  For far-east timezones
  // (UTC+12/+13/+14) noon UTC is already the next local day, so fall
  // back to midnight UTC which resolves correctly there.
  const noonUTC = new Date(Date.UTC(tY, tM - 1, tD, 12, 0, 0));
  const r = localDateParts(noonUTC, timeZone);
  if (r.year === tY && r.month === tM && r.day === tD) {
    return noonUTC;
  }
  return new Date(Date.UTC(tY, tM - 1, tD, 0, 0, 0));
}

/**
 * Build a compact temporal context string for model injection.
 *
 * Output is hard-capped at {@link MAX_OUTPUT_CHARS} characters and
 * {@link MAX_HORIZON_ENTRIES} horizon entries.
 */
export function buildTemporalContext(
  options: TemporalContextOptions = {},
): string {
  const now = new Date(options.nowMs ?? Date.now());
  const resolvedHostTimeZone =
    canonicalizeTimeZone(
      options.hostTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ) ?? "UTC";
  const resolvedConfiguredUserTimeZone = options.configuredUserTimeZone
    ? canonicalizeTimeZone(options.configuredUserTimeZone)
    : null;
  const resolvedUserTimeZone = options.userTimeZone
    ? canonicalizeTimeZone(options.userTimeZone)
    : null;
  const resolvedTimeZone = options.timeZone
    ? canonicalizeTimeZone(options.timeZone)
    : null;
  const timeZone =
    resolvedTimeZone ??
    resolvedConfiguredUserTimeZone ??
    resolvedUserTimeZone ??
    resolvedHostTimeZone;
  const userTimeZone = resolvedConfiguredUserTimeZone ?? resolvedUserTimeZone;
  const timeZoneSource = resolvedTimeZone
    ? "explicit_override"
    : resolvedConfiguredUserTimeZone
      ? "user_settings"
      : resolvedUserTimeZone
        ? "user_profile_memory"
        : "assistant_host_fallback";
  const horizonDays = Math.min(
    options.horizonDays ?? MAX_HORIZON_ENTRIES,
    MAX_HORIZON_ENTRIES,
  );

  const todayParts = localDateParts(now, timeZone);
  const todayStr = formatLocalDate(now, timeZone);
  const todayWeekday = WEEKDAY_NAMES[todayParts.weekday];

  // ── Next weekend (Saturday-Sunday) ──
  const daysUntilSaturday = (6 - todayParts.weekday + 7) % 7 || 7;
  const nextSaturday = addDays(now, daysUntilSaturday, timeZone);
  const nextSunday = addDays(now, daysUntilSaturday + 1, timeZone);

  // ── Next work week (Monday-Friday) ──
  const daysUntilMonday = (1 - todayParts.weekday + 7) % 7 || 7;
  const nextMonday = addDays(now, daysUntilMonday, timeZone);
  const nextFriday = addDays(now, daysUntilMonday + 4, timeZone);

  // ── Horizon list ──
  const horizonLines: string[] = [];
  for (let i = 1; i <= horizonDays; i++) {
    const futureDate = addDays(now, i, timeZone);
    const futureParts = localDateParts(futureDate, timeZone);
    const label = WEEKDAY_NAMES[futureParts.weekday];
    horizonLines.push(`  ${formatLocalDate(futureDate, timeZone)} ${label}`);
  }

  const lines = [
    `<temporal_context>`,
    `Today: ${todayStr} (${todayWeekday})`,
    `Timezone: ${timeZone}`,
    `Current local time: ${formatLocalIsoWithOffset(now, timeZone)}`,
    `Current UTC time: ${now.toISOString()}`,
    `Clock source: assistant host machine`,
    `Assistant host timezone: ${resolvedHostTimeZone}`,
    `User timezone: ${userTimeZone ?? "unknown"}`,
    `Timezone source: ${timeZoneSource}`,
    ``,
    `Week definitions: work week = Monday–Friday, weekend = Saturday–Sunday`,
    ``,
    `Next weekend: ${formatLocalDate(
      nextSaturday,
      timeZone,
    )} – ${formatLocalDate(nextSunday, timeZone)}`,
    `Next work week: ${formatLocalDate(
      nextMonday,
      timeZone,
    )} – ${formatLocalDate(nextFriday, timeZone)}`,
    ``,
    `Upcoming dates:`,
    ...horizonLines,
    `</temporal_context>`,
  ];

  let output = lines.join("\n");

  // Hard cap: truncate if somehow over budget (shouldn't happen with 14 entries).
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS - 25) + "\n</temporal_context>";
  }

  return output;
}

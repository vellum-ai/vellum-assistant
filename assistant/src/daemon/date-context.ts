/**
 * Temporal context formatter for date/time grounding.
 *
 * Produces a compact, deterministic payload describing the current date,
 * time, and timezone.  Intended for runtime injection into the model context.
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
}

const WEEKDAY_LONG = [
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
  // Check abbreviation mapping before Intl (many abbreviations are not recognized by Intl)
  const abbrIana = TIMEZONE_ABBREVIATIONS[trimmed.toUpperCase()];
  if (abbrIana) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: abbrIana,
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
 * Common timezone abbreviation → IANA identifier mapping.
 * Used as a fallback when `Intl.DateTimeFormat` does not recognize the abbreviation.
 */
const TIMEZONE_ABBREVIATIONS: Record<string, string> = {
  // North America
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  MST: "America/Denver",
  MDT: "America/Denver",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  EST: "America/New_York",
  EDT: "America/New_York",
  AKST: "America/Anchorage",
  AKDT: "America/Anchorage",
  HST: "Pacific/Honolulu",
  AST: "America/Puerto_Rico",
  NST: "America/St_Johns",
  NDT: "America/St_Johns",
  // Europe
  BST: "Europe/London",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  EET: "Europe/Athens",
  EEST: "Europe/Athens",
  WEST: "Europe/Lisbon",
  MSK: "Europe/Moscow",
  // Asia / Oceania
  JST: "Asia/Tokyo",
  KST: "Asia/Seoul",
  HKT: "Asia/Hong_Kong",
  SGT: "Asia/Singapore",
  WIB: "Asia/Jakarta",
  PHT: "Asia/Manila",
  PKT: "Asia/Karachi",
  NPT: "Asia/Kathmandu",
  AEST: "Australia/Sydney",
  AEDT: "Australia/Sydney",
  ACST: "Australia/Adelaide",
  ACDT: "Australia/Adelaide",
  AWST: "Australia/Perth",
  NZST: "Pacific/Auckland",
  NZDT: "Pacific/Auckland",
  // South America
  BRT: "America/Sao_Paulo",
};

/**
 * Regex matching IANA timezone identifiers (e.g. "America/New_York"),
 * UTC/GMT offset tokens (e.g. "UTC+5", "GMT-8:30"), and common
 * timezone abbreviations (e.g. "PST", "EST", "JST").
 *
 * Abbreviation alternation is built from `TIMEZONE_ABBREVIATIONS` keys.
 */
const TIMEZONE_ABBR_ALTERNATION = Object.keys(TIMEZONE_ABBREVIATIONS).join("|");
const TIMEZONE_TOKEN_RE = new RegExp(
  `\\b(?:[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)+|(?:UTC|GMT)(?:[+-]\\d{1,2}(?::?\\d{2})?)?|(?:${TIMEZONE_ABBR_ALTERNATION}))\\b`,
  "gi",
);

/**
 * Extract the user's timezone from memory recall injected text.
 *
 * Prefers identity items (`<item kind="identity" ...>`) rendered inside the
 * `<recalled>` section of `<memory_context>`. Falls back to scanning the
 * full injected text for lines mentioning "timezone".
 */
export function extractUserTimeZoneFromRecall(
  injectedText: string,
): string | null {
  if (!injectedText || injectedText.trim().length === 0) return null;

  // Prefer identity items: <item ... kind="identity" ...>content</item>
  const identityItemRe = /<item\s[^>]*kind="identity"[^>]*>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  const identityTexts: string[] = [];
  while ((match = identityItemRe.exec(injectedText)) !== null) {
    identityTexts.push(match[1]);
  }

  if (identityTexts.length > 0) {
    // First pass: identity items whose text mentions "timezone"
    for (const text of identityTexts) {
      if (/time\s*zone/i.test(text)) {
        for (const token of extractTimeZoneCandidates(text)) {
          const canonical = canonicalizeTimeZone(token);
          if (canonical) return canonical;
        }
      }
    }
    // Second pass: any timezone token in any identity item
    for (const text of identityTexts) {
      for (const token of extractTimeZoneCandidates(text)) {
        const canonical = canonicalizeTimeZone(token);
        if (canonical) return canonical;
      }
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
 * Format time as HH:MM:SS with UTC offset and timezone name.
 *
 * Uses the timezone resolution cascade:
 * explicit override → configured user tz → profile user tz → host fallback.
 *
 * Returns format: `2026-04-02 (Thursday) 01:52:33 -05:00 (America/Chicago)`
 */
export function formatTurnTimestamp(
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

  const dateStr = formatLocalDate(now, timeZone);
  const todayParts = localDateParts(now, timeZone);
  const dayName = WEEKDAY_LONG[todayParts.weekday];

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  const offset = normalizeOffsetToken(get("timeZoneName"));

  return `${dateStr} (${dayName}) ${hour}:${minute}:${second} ${offset} (${timeZone})`;
}

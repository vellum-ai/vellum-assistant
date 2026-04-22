/**
 * Timezone-aware bucketing for usage events.
 *
 * SQLite's `strftime(..., 'unixepoch')` is UTC-only, which means bucket
 * boundaries (both daily and hourly) can't respect the user's timezone when
 * computed in SQL. This module performs bucketing in JavaScript using
 * `Intl.DateTimeFormat` so boundaries align to local-hour / local-day in any
 * IANA timezone — including fractional offsets (e.g. Asia/Kolkata, UTC+5:30)
 * and DST transitions.
 */

import type { UsageDayBucket, UsageTimeRange } from "./llm-usage-store.js";

/** Minimal raw row shape needed for bucketing. */
export interface UsageEventBucketRow {
  created_at: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  llm_call_count: number | null;
}

/** Parts extracted from a single Date in a target timezone. */
interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  /** UTC offset in minutes at this instant in the target tz. */
  offsetMinutes: number;
}

/**
 * Validate that `tz` is a recognized IANA timezone identifier.
 * Throws a tagged error the route layer can surface as 400.
 */
export function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    const err = new Error(
      `Invalid IANA timezone identifier: "${tz}". Expected a value like "America/Los_Angeles" or "UTC".`,
    );
    (err as Error & { code?: string }).code = "INVALID_TIMEZONE";
    throw err;
  }
}

/**
 * Extract local wall-clock parts + UTC offset for a given instant in `tz`.
 *
 * Uses `formatToParts` with a fixed format to reliably get numeric fields and
 * the short GMT offset. The GMT offset disambiguates the duplicate DST
 * fall-back hour (e.g. 1am EDT and 1am EST both format to "01" in local time
 * but have different offsets).
 */
function getLocalParts(epochMillis: number, tz: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(new Date(epochMillis));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let offsetMinutes = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        // `hour12: false` can still yield "24" at midnight in some locales; clamp.
        hour = Number(part.value) % 24;
        break;
      case "timeZoneName":
        offsetMinutes = parseShortOffset(part.value);
        break;
    }
  }
  return { year, month, day, hour, offsetMinutes };
}

/**
 * Parse the `shortOffset` string returned by `Intl.DateTimeFormat` into minutes.
 *
 * Examples: "GMT-8" → -480, "GMT+5:30" → 330, "GMT" → 0, "UTC" → 0.
 */
function parseShortOffset(value: string): number {
  const match = value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  return sign * (hours * 60 + minutes);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Build the canonical daily bucket key in `tz`: "YYYY-MM-DD". */
function dayKey(parts: LocalParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/**
 * Build the canonical hourly bucket key in `tz`: "YYYY-MM-DD HH:00".
 *
 * For the DST fall-back hour we need to keep the two physically distinct
 * hours separate even though they share the same local wall-clock label.
 * We track them by their UTC offset internally via a separate map key,
 * but the returned `date` string is identical for both so the display label
 * matches. The caller uses a compound map key that includes the offset.
 */
function hourKey(parts: LocalParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:00`;
}

/** Compose a map key that separates duplicate DST fall-back hours. */
function hourMapKey(parts: LocalParts): string {
  return `${hourKey(parts)}|${parts.offsetMinutes}`;
}

/**
 * Advance `parts` by one local hour, returning the UTC instant of the next
 * hour's start. Used to walk a range and fill empty buckets.
 *
 * We compute the next hour by taking the current instant, adding 1 hour of
 * UTC wall time, and then projecting it back into local parts. This skips the
 * spring-forward hour (23-hour day) and correctly emits both halves of the
 * fall-back hour (25-hour day).
 */
function addOneHourUtc(epochMillis: number): number {
  return epochMillis + 60 * 60 * 1000;
}

function addOneDayUtc(epochMillis: number): number {
  return epochMillis + 24 * 60 * 60 * 1000;
}

/**
 * Find the UTC instant corresponding to the start of the local hour that
 * contains `epochMillis` in `tz`.
 *
 * Because Intl doesn't give us this directly, we approximate by:
 *   1. Getting the local parts of `epochMillis`
 *   2. Subtracting the minutes/seconds of the wall clock
 *
 * This returns a UTC instant that, when formatted in `tz`, has hour == parts.hour
 * and minute/second == 0.
 */
function alignToLocalHourStart(epochMillis: number, tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(epochMillis));
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    if (part.type === "minute") minute = Number(part.value);
    if (part.type === "second") second = Number(part.value);
  }
  return epochMillis - (minute * 60 + second) * 1000;
}

/**
 * Find the UTC instant corresponding to local midnight of the day containing
 * `epochMillis` in `tz`.
 *
 * DST-aware: the UTC offset at local midnight can differ from the offset at
 * `epochMillis` when a DST transition falls earlier in the same local day.
 * Naively subtracting the current wall-clock hours/minutes/seconds would land
 * on a UTC instant that formats as the wrong local date (e.g. 23:00 of the
 * previous day after spring-forward). We instead derive midnight by locating
 * the UTC instant whose local formatting is Y-M-D 00:00 in `tz`.
 */
function alignToLocalDayStart(epochMillis: number, tz: string): number {
  const parts = getLocalParts(epochMillis, tz);
  // UTC midnight of the same Y-M-D is a close-but-incorrect guess. Its offset
  // approximates the offset at local midnight — one iteration of correction
  // handles the common case where a DST transition sits between the two.
  const utcMidnightGuess = Date.UTC(parts.year, parts.month - 1, parts.day);
  const offset1 = getLocalParts(utcMidnightGuess, tz).offsetMinutes;
  let candidate = utcMidnightGuess - offset1 * 60_000;
  const offset2 = getLocalParts(candidate, tz).offsetMinutes;
  if (offset2 !== offset1) {
    candidate = utcMidnightGuess - offset2 * 60_000;
  }
  return candidate;
}

/** Format a short human-readable hour label in `tz`, e.g. "3pm". */
function formatHourLabel(epochMillis: number, tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: true,
  });
  // "3 PM" → "3pm"
  return formatter
    .format(new Date(epochMillis))
    .replace(/\s/g, "")
    .toLowerCase();
}

/** Format a short human-readable day label in `tz`, e.g. "Apr 11". */
function formatDayLabel(epochMillis: number, tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
  });
  return formatter.format(new Date(epochMillis));
}

interface MutableBucket {
  bucketId: string;
  date: string;
  displayLabel: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
  /** Sort key — the UTC instant of the bucket start. */
  sortKey: number;
}

function emptyBucket(
  bucketId: string,
  date: string,
  displayLabel: string,
  sortKey: number,
): MutableBucket {
  return {
    bucketId,
    date,
    displayLabel,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    eventCount: 0,
    sortKey,
  };
}

function addEventToBucket(
  bucket: MutableBucket,
  row: UsageEventBucketRow,
): void {
  bucket.totalInputTokens += row.input_tokens;
  bucket.totalOutputTokens += row.output_tokens;
  bucket.totalEstimatedCostUsd += row.estimated_cost_usd ?? 0;
  bucket.eventCount += row.llm_call_count ?? 1;
}

function finalize(buckets: Map<string, MutableBucket>): UsageDayBucket[] {
  return Array.from(buckets.values())
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ bucketId, date, displayLabel, ...rest }) => ({
      bucketId,
      date,
      displayLabel,
      totalInputTokens: rest.totalInputTokens,
      totalOutputTokens: rest.totalOutputTokens,
      totalEstimatedCostUsd: rest.totalEstimatedCostUsd,
      eventCount: rest.eventCount,
    }));
}

/** Options for bucketing behavior. */
export interface BucketingOptions {
  /**
   * When true, emit a zero-value bucket for every hour (or day) in the
   * requested range even if no events fall inside it. This produces a
   * continuous chart axis for empty periods but adds noise to text output
   * like the CLI. Defaults to false.
   */
  fillEmpty?: boolean;
}

/**
 * Bucket raw usage events by local hour in the given timezone.
 *
 * DST fall-back duplicate hours are preserved as separate buckets with
 * identical display labels. When `options.fillEmpty` is true, the returned
 * array contains a zero-value bucket for every local hour in the range.
 */
export function bucketEventsByHour(
  events: UsageEventBucketRow[],
  range: UsageTimeRange,
  tz: string,
  options: BucketingOptions = {},
): UsageDayBucket[] {
  validateTimezone(tz);
  const buckets = new Map<string, MutableBucket>();

  if (options.fillEmpty) {
    let cursor = alignToLocalHourStart(range.from, tz);
    let safety = 0;
    const maxIterations = 200_000;
    while (cursor <= range.to && safety++ < maxIterations) {
      const parts = getLocalParts(cursor, tz);
      const key = hourMapKey(parts);
      if (!buckets.has(key)) {
        buckets.set(
          key,
          emptyBucket(key, hourKey(parts), formatHourLabel(cursor, tz), cursor),
        );
      }
      cursor = addOneHourUtc(cursor);
    }
  }

  for (const row of events) {
    const parts = getLocalParts(row.created_at, tz);
    const key = hourMapKey(parts);
    let bucket = buckets.get(key);
    if (!bucket) {
      const hourStart = alignToLocalHourStart(row.created_at, tz);
      bucket = emptyBucket(
        key,
        hourKey(parts),
        formatHourLabel(hourStart, tz),
        hourStart,
      );
      buckets.set(key, bucket);
    }
    addEventToBucket(bucket, row);
  }

  return finalize(buckets);
}

/**
 * Bucket raw usage events by local day in the given timezone.
 *
 * When `options.fillEmpty` is true, the returned array contains a zero-value
 * bucket for every local day in the range.
 */
export function bucketEventsByDay(
  events: UsageEventBucketRow[],
  range: UsageTimeRange,
  tz: string,
  options: BucketingOptions = {},
): UsageDayBucket[] {
  validateTimezone(tz);
  const buckets = new Map<string, MutableBucket>();

  if (options.fillEmpty) {
    let cursor = alignToLocalDayStart(range.from, tz);
    let safety = 0;
    const maxIterations = 10_000;
    while (cursor <= range.to && safety++ < maxIterations) {
      const parts = getLocalParts(cursor, tz);
      const key = dayKey(parts);
      if (!buckets.has(key)) {
        buckets.set(
          key,
          emptyBucket(key, key, formatDayLabel(cursor, tz), cursor),
        );
      }
      // Advance by 24 UTC hours, then realign to local midnight. Handles
      // DST transitions where a "day" is 23 or 25 hours long in local time.
      cursor = alignToLocalDayStart(addOneDayUtc(cursor), tz);
    }
  }

  for (const row of events) {
    const parts = getLocalParts(row.created_at, tz);
    const key = dayKey(parts);
    let bucket = buckets.get(key);
    if (!bucket) {
      const dayStart = alignToLocalDayStart(row.created_at, tz);
      bucket = emptyBucket(key, key, formatDayLabel(dayStart, tz), dayStart);
      buckets.set(key, bucket);
    }
    addEventToBucket(bucket, row);
  }

  return finalize(buckets);
}

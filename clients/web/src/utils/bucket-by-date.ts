/**
 * Group timestamped items into the date bands a long history reads best in:
 * Today, Yesterday, Previous 7 days, Previous 30 days, then one band per
 * calendar month.
 *
 * Pure, and `now` is a parameter, so a caller can render the same grouping a
 * test asserts. Labels are not produced here: the four relative bands are
 * translated copy and a month band is formatted in the reader's locale, both
 * of which belong to the surface rendering them.
 *
 * Boundaries are local calendar midnights computed through the `Date`
 * constructor rather than by subtracting 86_400_000 milliseconds, so a band
 * still ends at midnight across a daylight-saving transition.
 */

/** Which band an item landed in. `month` is 0-indexed, as `Date` reports it. */
export type DateBucketId =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "previous7Days" }
  | { kind: "previous30Days" }
  | { kind: "month"; year: number; month: number };

export interface DateBucket<T> {
  /** Stable, collision-free identity for React keys and scroll anchors. */
  key: string;
  id: DateBucketId;
  items: T[];
}

/** Epoch ms of local midnight `offsetDays` from the day `date` falls in. */
function localDayStart(date: Date, offsetDays = 0): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + offsetDays,
  ).getTime();
}

export function dateBucketKey(id: DateBucketId): string {
  return id.kind === "month" ? `month:${id.year}-${id.month}` : id.kind;
}

/**
 * The band `timestamp` falls in, for a caller holding one instant rather than
 * a list. {@link bucketByDate} files its items through this, so anything that
 * labels a row with it agrees with the heading the row sits under.
 */
export function dateBucketIdFor(timestamp: number, now: Date): DateBucketId {
  const today = localDayStart(now);
  if (timestamp >= today) {
    return { kind: "today" };
  }
  if (timestamp >= localDayStart(now, -1)) {
    return { kind: "yesterday" };
  }
  if (timestamp >= localDayStart(now, -7)) {
    return { kind: "previous7Days" };
  }
  if (timestamp >= localDayStart(now, -30)) {
    return { kind: "previous30Days" };
  }
  const date = new Date(timestamp);
  return { kind: "month", year: date.getFullYear(), month: date.getMonth() };
}

/** Newest band first, with the four relative bands ahead of every month. */
const RELATIVE_ORDER: DateBucketId["kind"][] = [
  "today",
  "yesterday",
  "previous7Days",
  "previous30Days",
];

/** Rank inside the fixed band order; every month sorts after all four. */
function bandRank(id: DateBucketId): number {
  return id.kind === "month"
    ? RELATIVE_ORDER.length
    : RELATIVE_ORDER.indexOf(id.kind);
}

function compareBuckets<T>(a: DateBucket<T>, b: DateBucket<T>): number {
  const byBand = bandRank(a.id) - bandRank(b.id);
  if (byBand !== 0 || a.id.kind !== "month" || b.id.kind !== "month") {
    return byBand;
  }
  return b.id.year - a.id.year || b.id.month - a.id.month;
}

/**
 * Band `items` by the instant `getTime` reads off each one, newest band first.
 * Items keep their relative order inside a band, so a recency-sorted input
 * stays recency-sorted throughout. An item with no usable instant is dropped:
 * a row with no date cannot be placed under a date heading, and inventing one
 * would file it under today.
 */
export function bucketByDate<T>(
  items: readonly T[],
  getTime: (item: T) => number | null | undefined,
  now: Date,
): DateBucket<T>[] {
  const buckets = new Map<string, DateBucket<T>>();
  for (const item of items) {
    const timestamp = getTime(item);
    if (timestamp == null || !Number.isFinite(timestamp)) {
      continue;
    }
    const id = dateBucketIdFor(timestamp, now);
    const key = dateBucketKey(id);
    const existing = buckets.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      buckets.set(key, { key, id, items: [item] });
    }
  }
  /* Sorted rather than emitted in first-seen order: the caller's input is
     recency-ordered in practice but nothing here depends on that, and a band
     order that changes with the input is a band order nobody can test. */
  return [...buckets.values()].sort(compareBuckets);
}

/**
 * `Intl.DateTimeFormat` is expensive to construct and the reuse is the
 * documented pattern, so each shape is built once per locale. The key carries
 * the shape because one locale needs three of them.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  shape: "time" | "dayMonth" | "dayMonthYear",
  locale: string | undefined,
): Intl.DateTimeFormat {
  const key = `${shape}:${locale ?? ""}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(
      locale,
      shape === "time"
        ? { hour: "numeric", minute: "2-digit" }
        : shape === "dayMonth"
          ? { day: "numeric", month: "short" }
          : { day: "numeric", month: "short", year: "numeric" },
    );
    formatters.set(key, cached);
  }
  return cached;
}

/**
 * How a row inside a date band names its own instant, in a form that cannot
 * contradict the heading above it.
 *
 * Today and Yesterday are single days, so the clock time is the only thing
 * left to say and it is unambiguous under either heading. Every older band
 * spans several days, so the row carries the date; the year shows only when
 * it differs from `now`'s, which is the rule `formatFriendlyDate` follows.
 *
 * Deliberately not a relative duration ("2 days ago"). Those round, and a
 * rounded duration disagrees with a calendar band: a chat from early
 * yesterday is a bit over a day old and reads as two days, under a heading
 * that says Yesterday.
 */
export function formatBucketedTime(
  timestamp: number,
  now: Date,
  locale?: string,
): string {
  const kind = dateBucketIdFor(timestamp, now).kind;
  const date = new Date(timestamp);
  if (kind === "today" || kind === "yesterday") {
    return formatter("time", locale).format(date);
  }
  const shape =
    date.getFullYear() === now.getFullYear() ? "dayMonth" : "dayMonthYear";
  return formatter(shape, locale).format(date);
}

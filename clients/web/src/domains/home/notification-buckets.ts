import type { FeedItem, FeedItemBucket } from "@vellumai/assistant-api";

/**
 * The three sections of the notification surfaces, most important first.
 *
 * `bucket` is written by the daemon by fixed rule. Everything here is about
 * arranging rows that already carry one, plus a fallback for rows written
 * before the field existed.
 */
export const BUCKET_ORDER: readonly FeedItemBucket[] = [
  "needs_you",
  "worth_knowing",
  "activity",
];

/**
 * The bucket a row belongs to.
 *
 * Rows written before the field existed are placed from what they do carry:
 * `noteworthy` was the pre-bucket inbox/activity split, and a row carrying an
 * action or an approval-shaped detail panel is blocked on the user by
 * definition. Not a second ranking rule, just a reading of an older row.
 */
export function resolveBucket(item: FeedItem): FeedItemBucket {
  if (item.bucket) {
    return item.bucket;
  }
  const blocksUser =
    (item.actions?.length ?? 0) > 0 ||
    item.detailPanel?.kind === "permissionChat" ||
    item.detailPanel?.kind === "toolPermission" ||
    item.urgency === "critical";
  if (blocksUser) {
    return "needs_you";
  }
  return item.noteworthy ? "worth_knowing" : "activity";
}

/** Whether a run row is still being driven by something. */
export function isRunInFlight(item: FeedItem): boolean {
  const state = item.run?.state;
  return state === "queued" || state === "running" || state === "needs_input";
}

export interface BucketSection {
  bucket: FeedItemBucket;
  items: FeedItem[];
  /** Live runs inside this section, for the header's "N running" count. */
  runningCount: number;
}

/**
 * Split the visible feed into its three sections, ordered most to least
 * important, with each section's rows in the order they should be read.
 *
 * Empty sections are dropped: an always-present "Needs you" header reading
 * zero is a permanent reminder of nothing.
 */
export function groupIntoSections(items: FeedItem[]): BucketSection[] {
  const byBucket = new Map<FeedItemBucket, FeedItem[]>();
  for (const bucket of BUCKET_ORDER) {
    byBucket.set(bucket, []);
  }
  for (const item of items) {
    byBucket.get(resolveBucket(item))?.push(item);
  }

  const sections: BucketSection[] = [];
  for (const bucket of BUCKET_ORDER) {
    const bucketItems = byBucket.get(bucket) ?? [];
    if (bucketItems.length === 0) {
      continue;
    }
    sections.push({
      bucket,
      items: sortWithinBucket(bucketItems),
      runningCount: bucketItems.filter(isRunInFlight).length,
    });
  }
  return sections;
}

/**
 * Rank inside a section: live runs first, then everything else newest first.
 *
 * In-progress runs sit at the top of Activity because that is the one part of
 * the section that is still changing. Running work is not something to act on,
 * so it does not earn a section of its own; when a run does need the user it
 * has already moved to the top section and is not here.
 *
 * The digest sinks to the bottom of its section: it is a summary of rows that
 * are no longer shown, so it reads as a footer rather than as news.
 */
function sortWithinBucket(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    const rankDelta = rowRank(a) - rowRank(b);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return Date.parse(b.timestamp) - Date.parse(a.timestamp);
  });
}

function rowRank(item: FeedItem): number {
  if (isRunInFlight(item)) {
    return 0;
  }
  if (item.type === "digest") {
    return 2;
  }
  return 1;
}

/**
 * A run that has gone this long without an update reads as stalled rather
 * than as working. Nothing is killed over it: long work is legitimate, and a
 * timeout that ended a four-hour job because it was quiet would be worse than
 * a row that overstates its progress.
 */
export const RUN_QUIET_AFTER_MS = 30 * 60 * 1000;

/** Whether a live run has had nothing to say for a while. */
export function isRunQuiet(item: FeedItem, nowMs: number): boolean {
  if (!isRunInFlight(item)) {
    return false;
  }
  const updatedMs = Date.parse(item.timestamp);
  return !Number.isNaN(updatedMs) && nowMs - updatedMs > RUN_QUIET_AFTER_MS;
}

/**
 * Elapsed time on a live run, as `m:ss` under an hour and `h:mm:ss` over it.
 *
 * Monospaced digits at the call site, so the row does not jitter as the
 * seconds tick.
 */
export function formatRunElapsed(startedAt: string, nowMs: number): string {
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return "";
  }
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * Ids the section-scoped bulk actions apply to.
 *
 * "Clear activity" clears the Activity section only, so it can no longer wipe
 * a pending approval, and it leaves live runs alone: dismissing a row for work
 * that is still going would just have it reappear on the next update.
 */
export function clearableActivityIds(sections: BucketSection[]): string[] {
  const activity = sections.find((section) => section.bucket === "activity");
  if (!activity) {
    return [];
  }
  return activity.items
    .filter((item) => !isRunInFlight(item))
    .map((item) => item.id);
}

/** Ids of every unread row across every section. */
export function unreadIds(sections: BucketSection[]): string[] {
  return sections
    .flatMap((section) => section.items)
    .filter((item) => item.status === "new")
    .map((item) => item.id);
}

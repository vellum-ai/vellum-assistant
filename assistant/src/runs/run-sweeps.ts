/**
 * The two sweeps that keep the Activity section honest.
 *
 * **Digest.** Routine finished work folds into one row: "14 runs today, all
 * succeeded". Without it, a day of heartbeats and memory sweeps buries the
 * handful of rows that mean something under dozens that do not, which is the
 * failure mode the whole revamp exists to fix.
 *
 * **Orphan reconciliation.** A run whose producer went away, because the
 * process died mid-run or a producer forgot to close one, is closed as
 * `interrupted` and offers a re-run. A crash must not be able to leave a
 * spinner turning forever.
 *
 * Both are idempotent and never throw: they run on a timer next to everything
 * else the daemon sweeps, and a sweep that can fail a boot is worse than a
 * stale row.
 */

import type { FeedItem, FeedItemDigest } from "../api/responses/home.js";
import { appendFeedItem, readHomeFeed } from "../home/feed-writer.js";
import { bucketCompat, bucketExpiresAt } from "../notifications/bucket.js";
import { getLogger } from "../util/logger.js";
import { reconcileOrphanedRuns } from "./run-store.js";

const log = getLogger("run-sweeps");

/** How often the sweeps run. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Window a digest covers.
 *
 * A day, matching how people talk about their own activity ("what ran
 * today"), and matching the 48-hour Activity TTL closely enough that a digest
 * never outlives the rows it folded.
 */
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Runs a digest must cover before it is worth drawing.
 *
 * Below this, the individual rows are more informative than a count of them:
 * "2 runs today" tells the reader strictly less than the two rows do.
 */
const DIGEST_MIN_RUNS = 3;

/** Feed-item id for the rolling digest. Stable, so each sweep replaces it. */
export const DIGEST_ITEM_ID = "digest:runs";

/**
 * Fold finished routine runs inside the digest window into one row, and
 * dismiss the rows it covers.
 *
 * Only routine Activity runs are folded. A failure, a notable success, and
 * anything the user still has to answer keep their own rows: those are the
 * rows a digest would be hiding, not summarizing.
 */
export async function sweepRunDigest(): Promise<void> {
  try {
    const now = Date.now();
    const windowStartMs = now - DIGEST_WINDOW_MS;
    const items = readHomeFeed().items;

    const foldable = items.filter((item) => isFoldable(item, windowStartMs));
    if (foldable.length < DIGEST_MIN_RUNS) {
      return;
    }

    const failedCount = foldable.filter(
      (item) => item.run?.state === "failed" || item.run?.state === "interrupted",
    ).length;

    const digest: FeedItemDigest = {
      runCount: foldable.length,
      failedCount,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(now).toISOString(),
    };

    const compat = bucketCompat("activity");
    const nowIso = new Date(now).toISOString();
    const row: FeedItem = {
      id: DIGEST_ITEM_ID,
      type: "digest",
      bucket: "activity",
      title: "Recent activity",
      summary: composeDigestSummary(digest),
      timestamp: nowIso,
      createdAt: nowIso,
      // A summary of work nobody was waiting on never asks for attention.
      status: "seen",
      digest,
      priority: compat.priority,
      noteworthy: compat.noteworthy,
      category: compat.category,
      expiresAt: bucketExpiresAt("activity", now),
    };

    await appendFeedItem(row);

    // The folded rows go quiet rather than being deleted: the Activity page is
    // the full log, and a user who expands the digest has to find something
    // there. `dismissed` is what the surfaces already treat as "not in the
    // list", so nothing new is needed to hide them.
    for (const item of foldable) {
      await appendFeedItem({ ...item, status: "dismissed" });
    }

    log.info(
      { runCount: digest.runCount, failedCount },
      "Folded routine runs into the activity digest",
    );
  } catch (err) {
    log.warn({ err }, "Activity digest sweep failed");
  }
}

/**
 * Whether a row is routine finished work the digest should absorb.
 *
 * Deliberately narrow. Every exclusion here is a row the user might be looking
 * for, and a digest that swallows one is worse than no digest at all.
 */
function isFoldable(item: FeedItem, windowStartMs: number): boolean {
  if (item.type !== "run" || !item.run) {
    return false;
  }
  if (item.status === "dismissed") {
    return false;
  }
  if (item.bucket !== "activity") {
    return false;
  }
  if (item.run.state !== "succeeded" && item.run.state !== "cancelled") {
    return false;
  }
  const endedMs = Date.parse(item.run.endedAt ?? item.timestamp);
  return !Number.isNaN(endedMs) && endedMs >= windowStartMs;
}

function composeDigestSummary(digest: FeedItemDigest): string {
  const runs = digest.runCount === 1 ? "1 run" : `${digest.runCount} runs`;
  return digest.failedCount === 0
    ? `${runs} in the last day, all succeeded.`
    : `${runs} in the last day, ${digest.failedCount} of them unfinished.`;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic sweeps and run one pass immediately.
 *
 * The immediate pass is the startup reconciliation: at boot nothing is live,
 * so every non-terminal run row on disk is by definition orphaned and gets
 * closed before a client can render a spinner for it.
 */
export function startRunSweeps(): void {
  if (sweepTimer) {
    return;
  }
  void runSweepPass();
  sweepTimer = setInterval(() => {
    void runSweepPass();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopRunSweeps(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

async function runSweepPass(): Promise<void> {
  // Orphans first: a run closed by this pass becomes foldable in the same
  // pass rather than waiting five minutes for the next one.
  try {
    await reconcileOrphanedRuns();
  } catch (err) {
    log.warn({ err }, "Orphaned-run reconciliation failed");
  }
  await sweepRunDigest();
}

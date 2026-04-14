// Phase 5 stopgap — replace when an integration event bus lands.
//
// Fires a periodic tick that asks each platform-baseline generator
// to refresh its feed items. Today the only generator is the Gmail
// digest, and we call it from a trivial `setInterval`. Once the
// daemon grows a real integration event bus (or an integration
// heartbeat that already runs on a cadence), this module should be
// deleted and the generator wired into that bus instead.
//
// IMPORTANT: This module is NOT auto-started. Wiring
// `startFeedScheduler()` into daemon startup is a follow-up — it is
// deliberately left inert so a buggy baseline generator can't take
// down daemon boot before Phase 5 is fully tested end-to-end.

import { getLogger } from "../util/logger.js";
import { generateGmailDigest } from "./platform-gmail-digest.js";

const log = getLogger("home-feed-scheduler");

/** 15 minutes — matches the cadence of other daemon polling loops. */
const FEED_TICK_INTERVAL_MS = 15 * 60 * 1000;

let tickHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the feed scheduler tick. Idempotent — calling twice is a
 * no-op and returns the same cleanup function each time.
 *
 * Returns a cleanup function that stops the interval when invoked,
 * mirroring the lifecycle pattern used by other daemon background
 * services.
 */
export function startFeedScheduler(): () => void {
  if (tickHandle) {
    return stopFeedScheduler;
  }

  tickHandle = setInterval(() => {
    generateGmailDigest(new Date()).catch((err) => {
      log.warn({ err }, "Gmail digest generator failed");
    });
  }, FEED_TICK_INTERVAL_MS);

  log.info(
    { intervalMs: FEED_TICK_INTERVAL_MS },
    "Feed scheduler started (Phase 5 stopgap)",
  );

  return stopFeedScheduler;
}

/**
 * Stop the feed scheduler tick. Safe to call when the scheduler is
 * not running.
 */
export function stopFeedScheduler(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
    log.info("Feed scheduler stopped");
  }
}

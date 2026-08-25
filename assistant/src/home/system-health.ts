/**
 * System health: one durable counter row per failing subsystem.
 *
 * Replaces the per-failure notifications that used to be most of the bell's
 * volume. A provider timeout on the heartbeat is not something the user can
 * fix, and because the notification dedupe window resets daily, one persistent
 * fault produced an endless stream of identical rows. This collapses that into
 * a single row per subsystem that counts, never pushes, and clears itself
 * after a run of successes.
 *
 * The row lives in the home feed like any other, so it inherits persistence,
 * the `home_feed_updated` broadcast, and the client's read/dismiss handling for
 * free. Its `type` is `system_health`, which is how clients tell it apart from
 * an ordinary notification.
 */

import type { FeedItem, FeedItemSystemHealth } from "../api/responses/home.js";
import { bucketCompat } from "../notifications/bucket.js";
import { getLogger } from "../util/logger.js";
import { appendFeedItem, bulkSetFeedItemStatus, readHomeFeed } from "./feed-writer.js";

const log = getLogger("system-health");

/**
 * Consecutive successes that clear a subsystem's row.
 *
 * More than one, so a single lucky tick during an ongoing outage does not
 * erase the record of it; small enough that a genuinely recovered subsystem
 * stops nagging within a few cycles.
 */
const CLEAR_AFTER_SUCCESSES = 3;

/** Feed-item id for a subsystem's health row. Stable, so writes replace it. */
export function systemHealthItemId(subsystem: string): string {
  return `health:${subsystem}`;
}

export interface SubsystemFailure {
  /** Stable subsystem id, e.g. `heartbeat`. Keys the row. */
  subsystem: string;
  /** Display name for the subsystem, e.g. `Heartbeat`. */
  label: string;
  /** One-line description of what failed. Raw error constants are stripped. */
  errorSummary?: string;
  /** A repair affordance, when one exists. */
  remedy?: { path: string; label: string };
  /** Conversation to open for the details. */
  conversationId?: string;
}

/**
 * Consecutive successes observed per subsystem since its last failure.
 *
 * In-memory on purpose: a restart resetting the streak means a recovered
 * subsystem's row survives a few extra cycles, which is a far cheaper mistake
 * than persisting a counter that could clear a row for a subsystem that is
 * still broken.
 */
const successStreaks = new Map<string, number>();

/**
 * Serializes the read-modify-write on the feed.
 *
 * The feed writer coalesces concurrent writes but does not serialize the read
 * that computes them, so two failures landing together would both read the
 * same count and the second would overwrite the first's increment.
 */
let tail: Promise<void> = Promise.resolve();

function serialize(work: () => Promise<void>): Promise<void> {
  const next = tail.then(work, work);
  // Failures are logged inside `work`; keeping the chain resolved stops one
  // bad write from wedging every later health update behind it.
  tail = next.catch(() => {});
  return next;
}

/**
 * Record a subsystem failure, creating or incrementing its health row.
 *
 * Never throws and never pushes: the row appears in the Activity section and
 * waits to be looked at. Fire-and-forget safe.
 */
export async function recordSubsystemFailure(
  failure: SubsystemFailure,
): Promise<void> {
  return serialize(async () => {
    try {
      successStreaks.delete(failure.subsystem);

      const id = systemHealthItemId(failure.subsystem);
      const existing = readHomeFeed().items.find((item) => item.id === id);
      const previous = existing?.systemHealth;
      const now = new Date().toISOString();

      const health: FeedItemSystemHealth = {
        subsystem: failure.subsystem,
        failureCount: (previous?.failureCount ?? 0) + 1,
        firstFailureAt: previous?.firstFailureAt ?? now,
        lastFailureAt: now,
        ...(failure.errorSummary
          ? { lastErrorSummary: sanitizeErrorSummary(failure.errorSummary) }
          : {}),
        ...(failure.remedy
          ? { remedyPath: failure.remedy.path, remedyLabel: failure.remedy.label }
          : {}),
      };

      const compat = bucketCompat("activity");
      const item: FeedItem = {
        id,
        type: "system_health",
        bucket: "activity",
        title: `${failure.label} is failing`,
        summary: composeHealthSummary(failure.label, health),
        timestamp: now,
        // Preserved so a row that has been counting for a week keeps its
        // place in creation-ordered views rather than jumping to the top on
        // every failure.
        createdAt: existing?.createdAt ?? now,
        // A row the user has already seen goes quiet and stays quiet: the
        // count keeps climbing without re-flagging the bell, which is the
        // whole point of collapsing repeats into a counter.
        status: existing?.status === "dismissed" ? "dismissed" : (existing?.status ?? "new"),
        systemHealth: health,
        priority: compat.priority,
        noteworthy: compat.noteworthy,
        category: compat.category,
        ...(failure.conversationId
          ? { conversationId: failure.conversationId }
          : {}),
      };

      await appendFeedItem(item);
    } catch (err) {
      log.warn(
        { err, subsystem: failure.subsystem },
        "Failed to record subsystem failure",
      );
    }
  });
}

/**
 * Record a subsystem success. Clears the subsystem's health row once
 * {@link CLEAR_AFTER_SUCCESSES} consecutive successes have been seen.
 *
 * Cheap in the steady state: with no row on disk there is nothing to clear,
 * so a healthy subsystem only ever touches the in-memory streak counter.
 */
export async function recordSubsystemSuccess(subsystem: string): Promise<void> {
  const streak = (successStreaks.get(subsystem) ?? 0) + 1;
  successStreaks.set(subsystem, streak);
  if (streak < CLEAR_AFTER_SUCCESSES) {
    return;
  }

  return serialize(async () => {
    try {
      const id = systemHealthItemId(subsystem);
      const existing = readHomeFeed().items.find((item) => item.id === id);
      if (!existing || existing.status === "dismissed") {
        return;
      }
      await bulkSetFeedItemStatus(
        ["new", "seen", "acted_on"],
        "dismissed",
        [id],
      );
      successStreaks.delete(subsystem);
      log.info(
        { subsystem, failureCount: existing.systemHealth?.failureCount },
        "Subsystem recovered; cleared its health row",
      );
    } catch (err) {
      log.warn({ err, subsystem }, "Failed to clear subsystem health row");
    }
  });
}

/**
 * "Heartbeat has failed 17 times since 3 Aug.": a count and a start date,
 * which is everything a row nobody can act on owes the reader.
 */
function composeHealthSummary(
  label: string,
  health: FeedItemSystemHealth,
): string {
  const since = new Date(health.firstFailureAt);
  const sinceLabel = Number.isNaN(since.getTime())
    ? null
    : since.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const times = health.failureCount === 1 ? "once" : `${health.failureCount} times`;
  const opening = sinceLabel
    ? `${label} has failed ${times} since ${sinceLabel}.`
    : `${label} has failed ${times}.`;
  return health.lastErrorSummary
    ? `${opening} Most recently: ${health.lastErrorSummary}`
    : opening;
}

/**
 * Trim an error to one readable line and drop raw error constants, so a health
 * row reads as prose rather than as a log line pasted into a consumer surface.
 */
function sanitizeErrorSummary(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const withoutConstants = oneLine
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  return withoutConstants.length > 160
    ? `${withoutConstants.slice(0, 157).trimEnd()}...`
    : withoutConstants;
}

/** Test seam: drop the in-memory success streaks. */
export function resetSystemHealthStreaksForTests(): void {
  successStreaks.clear();
}

// ---------------------------------------------------------------------------
// Memory retrospective — per-UTC-day attempt counter (runaway backstop).
// ---------------------------------------------------------------------------
//
// A single assistant-wide counter, keyed by UTC date, backing the
// `memory.retrospective.maxRunsPerAssistantPerDay` cap. The responsive path
// (post-turn trigger check) and the timer sweep check the day's budget before
// enqueuing and record one unit only after an enqueue actually lands; once the
// day's count reaches the cap those paths stop enqueuing until the next UTC day,
// whose fresh `day_key` starts a new count with no cron needed.
//
// The counter is NOT conversation-keyed — it spans every conversation — so it
// deliberately stays out of `CONVERSATION_KEYED_MEMORY_TABLES` and survives
// conversation deletion. Stale prior-day rows are pruned opportunistically on
// the first recorded run of each new day (see `recordDailyRetrospectiveRun`).
//
// The row lives on the dedicated memory connection (`assistant-memory.db`),
// resolved via `memoryDbOrNull`; every read/write degrades to a no-op (and the
// cap fails open) when that connection is unavailable — a degraded memory
// subsystem must never block the responsive path.

import { eq, lt, sql } from "drizzle-orm";

import { memoryRetrospectiveDailyCount } from "../../../persistence/schema/index.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";

const log = getLogger("memory-retrospective-daily-count");

/** The UTC calendar-day key (`YYYY-MM-DD`) for a millisecond timestamp. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Retrospective enqueue attempts recorded for `now`'s UTC day so far. Returns 0
 * when no row exists yet or the memory connection is unavailable.
 */
export function getRetrospectiveDailyCount(now: number): number {
  const mdb = memoryDbOrNull("getRetrospectiveDailyCount");
  if (!mdb) {
    return 0;
  }
  const row = mdb
    .select({ runCount: memoryRetrospectiveDailyCount.runCount })
    .from(memoryRetrospectiveDailyCount)
    .where(eq(memoryRetrospectiveDailyCount.dayKey, utcDayKey(now)))
    .get();
  return row?.runCount ?? 0;
}

/**
 * Whether the assistant's daily retrospective budget for `now`'s UTC day is
 * exhausted — its recorded count has reached `maxRunsPerDay`. Callers check this
 * BEFORE enqueuing and skip when it returns `true`. The count is bumped
 * separately, only after an enqueue actually lands, via
 * `recordDailyRetrospectiveRun`, so a source the enqueue helper skips (scheduled
 * thread, consolidation source, recursion guard) never consumes budget.
 *
 * Fails open — returns `false` (not exhausted) — on every degraded path: a
 * non-positive/non-finite cap (cap disabled), an unavailable memory database, or
 * a thrown SQLite error, matching the memory subsystem's degrade-don't-block
 * posture (a down memory connection already fails the cooldown gate open too).
 */
export function isDailyRetrospectiveBudgetExhausted(
  maxRunsPerDay: number,
  now: number,
): boolean {
  if (!Number.isFinite(maxRunsPerDay) || maxRunsPerDay <= 0) {
    return false;
  }
  try {
    return getRetrospectiveDailyCount(now) >= maxRunsPerDay;
  } catch (err) {
    log.warn(
      { err, dayKey: utcDayKey(now) },
      "daily retrospective budget check failed; allowing enqueue",
    );
    return false;
  }
}

/**
 * Record one retrospective enqueue against `now`'s UTC day, bumping the day's
 * count. Call ONLY after an enqueue actually landed — a skipped or ineligible
 * enqueue must not consume budget.
 *
 * No-ops on a disabled cap (non-positive/non-finite `maxRunsPerDay`) so a
 * disabled backstop never writes rows, and degrades to a no-op on an unavailable
 * memory database or a thrown SQLite error.
 *
 * Rolling the counter is cheap and idempotent: a primary-key upsert bumps the
 * current day's row, and a single `day_key < today` delete prunes stale rows.
 * The delete only removes anything on the first recorded run of a new UTC day;
 * on every later same-day call there are no older rows, so it is a no-op.
 */
export function recordDailyRetrospectiveRun(
  maxRunsPerDay: number,
  now: number,
): void {
  if (!Number.isFinite(maxRunsPerDay) || maxRunsPerDay <= 0) {
    return;
  }
  const mdb = memoryDbOrNull("recordDailyRetrospectiveRun");
  if (!mdb) {
    return;
  }
  const dayKey = utcDayKey(now);
  try {
    mdb
      .insert(memoryRetrospectiveDailyCount)
      .values({ dayKey, runCount: 1 })
      .onConflictDoUpdate({
        target: memoryRetrospectiveDailyCount.dayKey,
        set: {
          runCount: sql`${memoryRetrospectiveDailyCount.runCount} + 1`,
        },
      })
      .run();

    mdb
      .delete(memoryRetrospectiveDailyCount)
      .where(lt(memoryRetrospectiveDailyCount.dayKey, dayKey))
      .run();
  } catch (err) {
    log.warn(
      { err, dayKey },
      "daily retrospective run recording failed; continuing",
    );
  }
}

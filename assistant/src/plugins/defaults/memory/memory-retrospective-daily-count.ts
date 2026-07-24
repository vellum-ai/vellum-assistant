// ---------------------------------------------------------------------------
// Memory retrospective — per-UTC-day attempt counter (runaway backstop).
// ---------------------------------------------------------------------------
//
// A single assistant-wide counter, keyed by UTC date, backing the
// `memory.retrospective.maxRunsPerAssistantPerDay` cap. Each retrospective
// enqueue decision from the responsive path (post-turn trigger check) and the
// timer sweep reserves one unit of the day's budget; once the day's count
// reaches the cap those paths stop enqueuing until the next UTC day, whose
// fresh `day_key` starts a new count with no cron needed.
//
// The counter is NOT conversation-keyed — it spans every conversation — so it
// deliberately stays out of `CONVERSATION_KEYED_MEMORY_TABLES` and survives
// conversation deletion. Stale prior-day rows are pruned opportunistically on
// the first reservation of each new day (see `reserveDailyRetrospectiveBudget`).
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
 * Reserve one unit of the assistant's daily retrospective budget for `now`'s
 * UTC day. Returns `true` — recording the reservation (incrementing the day's
 * count) — when the day's count is still below `maxRunsPerDay`; returns `false`
 * WITHOUT recording once the cap is reached, so a capped attempt costs nothing.
 *
 * Fail-open on every degraded path: an unavailable memory database, a
 * non-positive/non-finite cap, or a thrown SQLite error all return `true`
 * without capping, matching the memory subsystem's degrade-don't-block posture
 * (a down memory connection already fails the cooldown gate open too).
 *
 * Rolling the counter is cheap and idempotent: a primary-key upsert bumps the
 * current day's row, and a single `day_key < today` delete prunes stale rows.
 * The delete only removes anything on the first reservation of a new UTC day;
 * on every later same-day call there are no older rows, so it is a no-op.
 */
export function reserveDailyRetrospectiveBudget(
  maxRunsPerDay: number,
  now: number,
): boolean {
  if (!Number.isFinite(maxRunsPerDay) || maxRunsPerDay <= 0) {
    return true;
  }
  const mdb = memoryDbOrNull("reserveDailyRetrospectiveBudget");
  if (!mdb) {
    return true;
  }
  const dayKey = utcDayKey(now);
  try {
    const row = mdb
      .select({ runCount: memoryRetrospectiveDailyCount.runCount })
      .from(memoryRetrospectiveDailyCount)
      .where(eq(memoryRetrospectiveDailyCount.dayKey, dayKey))
      .get();
    if ((row?.runCount ?? 0) >= maxRunsPerDay) {
      return false;
    }

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

    return true;
  } catch (err) {
    log.warn(
      { err, dayKey },
      "daily retrospective budget reservation failed; allowing enqueue",
    );
    return true;
  }
}

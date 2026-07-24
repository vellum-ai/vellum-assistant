/**
 * Per-UTC-day run counter for memory background jobs, keyed by `counter` name.
 *
 * One row per `(counter, day_key)` on the dedicated memory database
 * (`assistant-memory.db`) holds the current UTC day's tally for that counter.
 * Reads for any day other than a stored `day_key` return zero, and the first
 * {@link recordDailyRun} of a new UTC day opportunistically prunes that
 * counter's prior-day rows — so the row set never grows and no separate cleanup
 * pass is needed. Callers pass their own `counter` name so independent counters
 * (e.g. consolidation, retrospective) never share a row.
 *
 * The table is NOT conversation-keyed — it spans every conversation — so it
 * deliberately stays out of `CONVERSATION_KEYED_MEMORY_TABLES` and survives
 * conversation deletion. Every read/write resolves the memory connection via
 * `memoryDbOrNull` and degrades to a no-op (the cap fails open) when that
 * connection is unavailable — a degraded memory subsystem must never block the
 * responsive path.
 */

import { and, eq, lt, sql } from "drizzle-orm";

import { memoryDailyRunCount } from "../../../persistence/schema/index.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";

const log = getLogger("daily-run-counter");

/** UTC calendar day (`YYYY-MM-DD`) for `nowMs`. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Runs recorded under `counter` so far during the current UTC day. Returns 0
 * when no row exists yet or the memory connection is unavailable.
 */
export function getDailyRunCount(counter: string, nowMs: number): number {
  const mdb = memoryDbOrNull("getDailyRunCount");
  if (!mdb) {
    return 0;
  }
  const row = mdb
    .select({ runCount: memoryDailyRunCount.runCount })
    .from(memoryDailyRunCount)
    .where(
      and(
        eq(memoryDailyRunCount.counter, counter),
        eq(memoryDailyRunCount.dayKey, utcDay(nowMs)),
      ),
    )
    .get();
  return row?.runCount ?? 0;
}

/**
 * Record one run under `counter` for the current UTC day and return the new
 * count. Degrades to a no-op returning 0 on an unavailable memory database or a
 * thrown SQLite error.
 *
 * Rolling the counter is cheap and idempotent: a primary-key upsert bumps the
 * current day's row, and a single `counter = ? AND day_key < today` delete
 * prunes that counter's stale rows. The delete only removes anything on the
 * first recorded run of a new UTC day; on every later same-day call there are no
 * older rows for the counter, so it is a no-op. The prune is scoped to `counter`
 * so unrelated counters' prior-day rows are never touched.
 */
export function recordDailyRun(counter: string, nowMs: number): number {
  const mdb = memoryDbOrNull("recordDailyRun");
  if (!mdb) {
    return 0;
  }
  const dayKey = utcDay(nowMs);
  try {
    const row = mdb
      .insert(memoryDailyRunCount)
      .values({ counter, dayKey, runCount: 1 })
      .onConflictDoUpdate({
        target: [memoryDailyRunCount.counter, memoryDailyRunCount.dayKey],
        set: { runCount: sql`${memoryDailyRunCount.runCount} + 1` },
      })
      .returning({ runCount: memoryDailyRunCount.runCount })
      .get();

    mdb
      .delete(memoryDailyRunCount)
      .where(
        and(
          eq(memoryDailyRunCount.counter, counter),
          lt(memoryDailyRunCount.dayKey, dayKey),
        ),
      )
      .run();

    return row?.runCount ?? 0;
  } catch (err) {
    log.warn(
      { err, counter, dayKey },
      "daily run recording failed; continuing",
    );
    return 0;
  }
}

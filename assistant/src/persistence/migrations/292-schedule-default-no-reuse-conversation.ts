import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Disable conversation reuse on all existing schedules.
 *
 * Recurring schedules previously defaulted to `reuse_conversation = 1`, so
 * every fire appended to one long-lived conversation. That unbounded,
 * self-similar transcript is a drift hazard for weaker models (it primes them
 * to repeat or extend the prior run) and grows per-fire token cost without
 * adding correctness — durable cross-run state already lives in workspace files
 * and memory. Schedules now default to a fresh conversation per fire; this
 * aligns existing rows with that contract.
 *
 * Idempotent: the guarded UPDATE matches nothing once every row is already 0.
 */
export function migrateScheduleDefaultNoReuseConversation(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  raw
    .query(
      /*sql*/ `UPDATE cron_jobs SET reuse_conversation = 0 WHERE reuse_conversation != 0`,
    )
    .run();
}

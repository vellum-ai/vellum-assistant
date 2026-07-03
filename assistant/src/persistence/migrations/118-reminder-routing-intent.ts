import type { DrizzleDb } from "../db-connection.js";

/**
 * Add routing_intent and routing_hints_json columns to reminders table.
 *
 * routing_intent controls how the reminder is delivered at trigger time:
 *   - single_channel: deliver to a single best channel
 *   - multi_channel: deliver to a subset of channels
 *   - all_channels (default): deliver to every available channel
 *
 * routing_hints_json stores an opaque JSON object with hints for the
 * routing engine (e.g. preferred channels, exclusions).
 */
export function migrateReminderRoutingIntent(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE reminders ADD COLUMN routing_intent TEXT NOT NULL DEFAULT 'all_channels'`,
    );
  } catch {
    /* already exists */
  }

  try {
    database.run(
      /*sql*/ `ALTER TABLE reminders ADD COLUMN routing_hints_json TEXT NOT NULL DEFAULT '{}'`,
    );
  } catch {
    /* already exists */
  }
}

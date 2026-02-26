import type { DrizzleDb } from '../db-connection.js';

/**
 * Add routing_intent and routing_hints_json columns to reminders.
 *
 * These fields let the model specify how the reminder should be delivered
 * at trigger time (single channel, multiple channels, or all channels).
 * Existing reminders default to single_channel with no routing hints.
 */
export function migrateReminderRoutingColumns(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE reminders ADD COLUMN routing_intent TEXT NOT NULL DEFAULT 'single_channel'`,
    );
  } catch { /* Column already exists */ }

  try {
    database.run(
      /*sql*/ `ALTER TABLE reminders ADD COLUMN routing_hints_json TEXT NOT NULL DEFAULT '{}'`,
    );
  } catch { /* Column already exists */ }
}

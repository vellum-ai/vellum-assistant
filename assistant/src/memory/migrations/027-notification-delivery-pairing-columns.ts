import type { DrizzleDb } from '../db-connection.js';

/**
 * Add conversation pairing audit columns to notification_deliveries.
 *
 * These columns track which conversation and message were materialized
 * for each notification delivery, plus the strategy that was used.
 */
export function migrateNotificationDeliveryPairingColumns(database: DrizzleDb): void {
  try {
    database.run(/*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN conversation_id TEXT`);
  } catch { /* Column already exists */ }
  try {
    database.run(/*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN message_id TEXT`);
  } catch { /* Column already exists */ }
  try {
    database.run(/*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN conversation_strategy TEXT`);
  } catch { /* Column already exists */ }
}

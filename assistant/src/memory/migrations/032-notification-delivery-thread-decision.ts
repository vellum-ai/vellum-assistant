import type { DrizzleDb } from '../db-connection.js';

/**
 * Add thread decision audit columns to notification_deliveries.
 *
 * These columns record the model's per-channel thread action (start_new
 * or reuse_existing), the target conversation ID for reuse, and whether
 * a fallback to start_new was needed due to an invalid/stale target.
 */
export function migrateNotificationDeliveryThreadDecision(database: DrizzleDb): void {
  try {
    database.run(/*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN thread_action TEXT`);
  } catch { /* Column already exists */ }
  try {
    database.run(/*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN thread_target_conversation_id TEXT`);
  } catch { /* Column already exists */ }
  try {
    database.run(/*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN thread_decision_fallback_used INTEGER`);
  } catch { /* Column already exists */ }
}

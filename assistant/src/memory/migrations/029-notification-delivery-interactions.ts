import type { DrizzleDb } from '../db-connection.js';

/**
 * Add the notification_delivery_interactions table (append-only interaction log)
 * and summary columns on notification_deliveries for seen/viewed/last-interaction
 * tracking.
 *
 * All DDL statements are idempotent (CREATE TABLE IF NOT EXISTS, ALTER TABLE
 * ADD COLUMN try/catch).
 */
export function migrateNotificationDeliveryInteractions(database: DrizzleDb): void {
  // -- Interaction log table --------------------------------------------------
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS notification_delivery_interactions (
      id TEXT PRIMARY KEY,
      notification_delivery_id TEXT NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
      assistant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      interaction_type TEXT NOT NULL,
      confidence TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence_text TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_ndi_delivery_occurred ON notification_delivery_interactions(notification_delivery_id, occurred_at DESC)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_ndi_assistant_occurred ON notification_delivery_interactions(assistant_id, occurred_at DESC)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_ndi_channel_occurred ON notification_delivery_interactions(channel, occurred_at DESC)`);

  // -- Summary columns on notification_deliveries -----------------------------
  const summaryColumns = [
    'seen_at INTEGER',
    'seen_confidence TEXT',
    'seen_source TEXT',
    'seen_evidence_text TEXT',
    'viewed_at INTEGER',
    'last_interaction_at INTEGER',
    'last_interaction_type TEXT',
    'last_interaction_confidence TEXT',
    'last_interaction_source TEXT',
    'last_interaction_evidence_text TEXT',
  ];

  for (const col of summaryColumns) {
    try {
      database.run(/*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN ${col}`);
    } catch { /* Column already exists */ }
  }
}

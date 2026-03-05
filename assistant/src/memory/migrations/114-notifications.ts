import type { DrizzleDb } from "../db-connection.js";
import { migrateNotificationTablesSchema } from "./019-notification-tables-schema-migration.js";
import { migrateNotificationDeliveryPairingColumns } from "./027-notification-delivery-pairing-columns.js";
import { migrateNotificationDeliveryClientAck } from "./028-notification-delivery-client-ack.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Notification system tables: preferences, events, decisions, and deliveries.
 * Includes migration to drop legacy enum-based notification tables.
 */
export function createNotificationTables(database: DrizzleDb): void {
  // Migration: drop legacy enum-based notification tables if old schema detected.
  // Guarded behind a one-time check for the old `notification_type` column.
  migrateNotificationTablesSchema(database);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      preference_text TEXT NOT NULL,
      applies_when_json TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  if (tableHasColumn(database, "notification_preferences", "assistant_id")) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_preferences_assistant_id ON notification_preferences(assistant_id)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_preferences_assistant_priority ON notification_preferences(assistant_id, priority DESC)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_preferences_priority ON notification_preferences(priority DESC)`,
    );
  }

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS notification_events (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      source_event_name TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      attention_hints_json TEXT NOT NULL DEFAULT '{}',
      payload_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  if (tableHasColumn(database, "notification_events", "assistant_id")) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_events_assistant_event_created ON notification_events(assistant_id, source_event_name, created_at)`,
    );
    database.run(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedupe ON notification_events(assistant_id, dedupe_key) WHERE dedupe_key IS NOT NULL`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_events_event_created ON notification_events(source_event_name, created_at)`,
    );
    database.run(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedupe ON notification_events(dedupe_key) WHERE dedupe_key IS NOT NULL`,
    );
  }

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS notification_decisions (
      id TEXT PRIMARY KEY,
      notification_event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
      should_notify INTEGER NOT NULL,
      selected_channels TEXT NOT NULL DEFAULT '[]',
      reasoning_summary TEXT NOT NULL,
      confidence REAL NOT NULL,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      prompt_version TEXT,
      validation_results TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_decisions_event_id ON notification_decisions(notification_event_id)`,
  );

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      notification_decision_id TEXT NOT NULL REFERENCES notification_decisions(id) ON DELETE CASCADE,
      assistant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      destination TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 1,
      rendered_title TEXT,
      rendered_body TEXT,
      error_code TEXT,
      error_message TEXT,
      sent_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_unique ON notification_deliveries(notification_decision_id, channel, destination, attempt)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_decision_id ON notification_deliveries(notification_decision_id)`,
  );
  if (tableHasColumn(database, "notification_deliveries", "assistant_id")) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_assistant_status ON notification_deliveries(assistant_id, status)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status)`,
    );
  }

  // Add conversation pairing audit columns (idempotent ALTER TABLE)
  migrateNotificationDeliveryPairingColumns(database);

  // Add client delivery ack columns (idempotent ALTER TABLE)
  migrateNotificationDeliveryClientAck(database);
}

import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the lifecycle_events table for tracking app lifecycle telemetry
 * (app_open, hatch, etc.).
 */
export function createLifecycleEventsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS lifecycle_events (
      id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the auth_fallback_events table for tracking legacy-loopback
 * auth-fallback counts forwarded by the gateway. One row per
 * (guard, path, failure_kind) per flush window.
 */
export function createAuthFallbackEventsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS auth_fallback_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      guard TEXT NOT NULL,
      path TEXT NOT NULL,
      failure_kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL
    )
  `);
}

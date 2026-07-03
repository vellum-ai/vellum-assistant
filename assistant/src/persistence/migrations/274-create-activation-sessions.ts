import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the activation_sessions table. One row per conversation that was
 * started on the activation-rail bootstrap template, used by the activation
 * funnel telemetry to scope events to activation conversations.
 */
export function createActivationSessionsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS activation_sessions (
      conversation_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
}

import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the onboarding_events table for tracking pre-chat onboarding
 * selections (tools, tasks, tone, Google connect status).
 */
export function createOnboardingEventsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS onboarding_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      screen TEXT NOT NULL,
      tools_json TEXT,
      tasks_json TEXT,
      tone TEXT,
      google_connected INTEGER,
      google_scopes_json TEXT,
      ab_variant TEXT
    )
  `);
}

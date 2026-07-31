import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the skill_loaded_events table for `skill_loaded` telemetry events —
 * one row per activation of a Vellum-produced skill (see
 * skill-loaded-events-store.ts for the data contract). The index backs the
 * telemetry reporter's compound `(created_at, id)` watermark cursor.
 */
export function createSkillLoadedEventsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS skill_loaded_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      conversation_id TEXT,
      skill_name TEXT NOT NULL,
      skill_updated_at TEXT,
      provider TEXT,
      model TEXT,
      inference_profile TEXT,
      inference_profile_source TEXT
    )
  `);
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_skill_loaded_events_created_at_id ON skill_loaded_events (created_at, id)`,
  );
}

import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Drop orphaned media tables that are no longer used.
 *
 * These tables were previously created by 111-media-assets.ts but the CREATE
 * TABLE statements were removed in PR #16739. This migration cleans up
 * existing databases that still have them.
 */
export function migrateDropOrphanedMediaTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS media_vision_outputs`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS media_timelines`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS media_events`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS media_tracking_profiles`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS media_event_feedback`);
}

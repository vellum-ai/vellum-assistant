import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Move a watch timeline entry's screenshot into the row that owns it.
 *
 * `screenshot` holds the frame's JPEG bytes directly, so an entry is one row
 * with one lifetime: a single `DELETE` takes the narration, the screen, and
 * the pixels together, with nothing staged elsewhere to coordinate against.
 * `screenshot_attachment_id`, the id of a separately staged file, goes with
 * it.
 *
 * Idempotent: each `ALTER TABLE` is guarded by a column check, so a crash
 * between the two leaves the next boot able to finish the job.
 */
export function migrateWatchTimelineScreenshotBlob(database: DrizzleDb): void {
  if (!tableHasColumn(database, "watch_timeline_entries", "screenshot")) {
    database.run(
      /*sql*/ `ALTER TABLE watch_timeline_entries ADD COLUMN screenshot BLOB`,
    );
  }
  if (
    tableHasColumn(
      database,
      "watch_timeline_entries",
      "screenshot_attachment_id",
    )
  ) {
    database.run(
      /*sql*/ `ALTER TABLE watch_timeline_entries DROP COLUMN screenshot_attachment_id`,
    );
  }
}

import type { DrizzleDb } from "../db-connection.js";

/**
 * Add delivered_segment_count column to channel_inbound_events.
 *
 * Tracks how many text segments of a split reply were successfully
 * delivered, so retries can resume from where they left off rather
 * than re-sending already-delivered segments.
 */
export function migrateChannelInboundDeliveredSegments(
  database: DrizzleDb,
): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN delivered_segment_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* Column already exists */
  }
}

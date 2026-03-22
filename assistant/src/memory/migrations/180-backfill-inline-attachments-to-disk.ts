import { writeAttachmentToDisk } from "../attachments-store.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Backfill existing inline (base64-in-DB) attachments to disk.
 *
 * Finds attachment rows that have non-empty data_base64 but no file_path,
 * writes each one to disk, and updates the row to store the file path
 * while clearing the inline data.
 *
 * Processes in batches of 50 to avoid holding large amounts of base64 data
 * in memory at once.
 */
export function migrateBackfillInlineAttachmentsToDisk(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_backfill_inline_attachments_v1",
    () => {
      const raw = getSqliteFrom(database);
      const BATCH_SIZE = 50;
      let totalMigrated = 0;

      for (;;) {
        const rows = raw
          .query(
            `SELECT id, original_filename, data_base64 FROM attachments
             WHERE (file_path IS NULL OR file_path = '')
               AND data_base64 != ''
               AND length(data_base64) > 0
             LIMIT ?`,
          )
          .all(BATCH_SIZE) as Array<{
          id: string;
          original_filename: string;
          data_base64: string;
        }>;

        if (rows.length === 0) break;

        for (const row of rows) {
          const filePath = writeAttachmentToDisk(
            row.data_base64,
            row.original_filename,
          );
          raw
            .query(
              `UPDATE attachments SET file_path = ?, data_base64 = '' WHERE id = ?`,
            )
            .run(filePath, row.id);
        }

        totalMigrated += rows.length;
      }

      if (totalMigrated > 0) {
        // Log is intentionally not imported to keep migration self-contained;
        // the checkpoint value records completion.
        console.log(`Migrated ${totalMigrated} inline attachments to disk`);
      }
    },
  );
}

/**
 * Reverse: no-op.
 *
 * The forward migration moved attachment data from inline base64 in the
 * database to on-disk files and cleared the dataBase64 column. The original
 * base64 data has been deleted from the DB, and re-reading it from disk
 * back into the database would be unreliable (file paths may have changed,
 * disk files may have been cleaned up). The on-disk files remain intact
 * and functional.
 */
export function migrateBackfillInlineAttachmentsToDiskDown(
  _database: DrizzleDb,
): void {
  // No-op — see comment above.
}

import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Backfill MIME types for audio attachments that were stored with
 * "application/octet-stream" because the EXTENSION_MIME_MAP was
 * missing audio format entries.
 *
 * Updates mime_type based on the file extension in original_filename.
 */

const AUDIO_EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/x-m4a",
  opus: "audio/opus",
};

export function migrateBackfillAudioAttachmentMimeTypes(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_backfill_audio_attachment_mime_types_v1",
    () => {
      const raw = getSqliteFrom(database);

      for (const [ext, mime] of Object.entries(AUDIO_EXT_MIME)) {
        const pattern = `%.${ext}`;
        const result = raw
          .query(
            `UPDATE attachments
             SET mime_type = ?, kind = 'document'
             WHERE lower(original_filename) LIKE ?
               AND mime_type = 'application/octet-stream'`,
          )
          .run(mime, pattern);

        if ((result as { changes?: number }).changes) {
          console.log(
            `Backfilled ${(result as { changes: number }).changes} .${ext} attachments → ${mime}`,
          );
        }
      }
    },
  );
}

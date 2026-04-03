import { readFileSync, unlinkSync } from "node:fs";

import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Remove image attachments that contain HTML error pages instead of actual
 * image data. This can happen when a CDN (e.g. Slack) returns an HTML sign-in
 * page due to a missing OAuth scope, and the gateway stores the response body
 * as an image attachment.
 *
 * Handles both inline (data_base64) and on-disk (file_path) storage.
 */

const HTML_MARKERS = ["<!doctype", "<html"];

function looksLikeHtml(bytes: Buffer): boolean {
  // Strip leading BOM / whitespace
  const text = bytes.toString("utf-8").trimStart().toLowerCase();
  return HTML_MARKERS.some((marker) => text.startsWith(marker));
}

export function migrateScrubCorruptedImageAttachments(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_scrub_corrupted_image_attachments_v1",
    () => {
      const raw = getSqliteFrom(database);

      function deleteCorruptedAttachment(
        id: string,
        filePath: string | null,
      ): void {
        raw
          .query(`DELETE FROM message_attachments WHERE attachment_id = ?`)
          .run(id);
        raw.query(`DELETE FROM attachments WHERE id = ?`).run(id);

        if (filePath) {
          try {
            unlinkSync(filePath);
          } catch {
            // File already missing — ignore
          }
        }

        console.log(
          `[scrub-corrupted-attachments] Removed corrupted attachment ${id}`,
        );
      }

      // Step A — Find and remove corrupted attachments stored inline (data_base64)
      // Process in batches using rowid cursor to ensure all rows are scanned
      // even when corrupted rows are non-contiguous.
      const BATCH_SIZE = 100;
      let lastRowid = 0;
      for (;;) {
        const rows = raw
          .query(
            `SELECT rowid, id, data_base64, file_path FROM attachments
             WHERE mime_type LIKE 'image/%'
               AND data_base64 IS NOT NULL
               AND data_base64 != ''
               AND rowid > ?
             ORDER BY rowid
             LIMIT ?`,
          )
          .all(lastRowid, BATCH_SIZE) as Array<{
          rowid: number;
          id: string;
          data_base64: string;
          file_path: string | null;
        }>;

        if (rows.length === 0) break;

        for (const row of rows) {
          lastRowid = row.rowid;
          try {
            const decoded = Buffer.from(
              row.data_base64.slice(0, 200),
              "base64",
            );
            if (looksLikeHtml(decoded)) {
              deleteCorruptedAttachment(row.id, row.file_path);
            }
          } catch {
            // Skip rows with invalid base64
          }
        }
      }

      // Step B — Find and remove corrupted attachments stored on disk (file_path)
      // Disk-backed attachments are typically fewer; query all at once.
      const diskRows = raw
        .query(
          `SELECT id, file_path FROM attachments
           WHERE mime_type LIKE 'image/%'
             AND file_path IS NOT NULL
             AND (data_base64 IS NULL OR data_base64 = '')`,
        )
        .all() as Array<{ id: string; file_path: string }>;

      for (const row of diskRows) {
        try {
          const bytes = readFileSync(row.file_path);
          const head = bytes.subarray(0, 100);
          if (looksLikeHtml(head)) {
            deleteCorruptedAttachment(row.id, row.file_path);
          }
        } catch {
          // File doesn't exist or can't be read — skip
        }
      }
    },
  );
}

/**
 * Reverse: no-op.
 *
 * Corrupted data (HTML stored as image) has no value to restore.
 */
export function migrateScrubCorruptedImageAttachmentsDown(
  _database: DrizzleDb,
): void {
  // No-op — corrupted data (HTML stored as image) has no value to restore.
}

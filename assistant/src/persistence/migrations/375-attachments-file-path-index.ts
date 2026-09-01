import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const INDEX = "idx_attachments_file_path";

/**
 * Answer "which rows name this file" without reading the table.
 *
 * Several guards ask exactly that, all by equality on `file_path`: whether a
 * path is shared before a shrink rewrites it, whether either of a shrink's
 * sidecar names is some row's canonical file, which rows a leftover backup
 * belongs to, and whether an orphaned attachment's file is still referenced
 * before `deleteOrphanAttachments` unlinks it. Nothing indexed the column, so
 * each was a full scan of `attachments`, and the storage sweep runs the first
 * two once per candidate for up to two hundred candidates a pass.
 *
 * EXPLAIN QUERY PLAN, before:
 *
 *     SCAN attachments
 *
 * and after, for the same three shapes (`file_path = ?` counted, aggregated,
 * and `file_path IN (?, ?)`):
 *
 *     SEARCH attachments USING COVERING INDEX idx_attachments_file_path (file_path=?)
 *     SEARCH attachments USING INDEX idx_attachments_file_path (file_path=?)
 *     SEARCH attachments USING COVERING INDEX idx_attachments_file_path (file_path=?)
 *
 * Partial, and here that is the safe choice rather than the fragile one. A row
 * whose bytes are inline carries a null `file_path` and can never satisfy an
 * equality or `IN` against a parameter, so it belongs in none of these answers
 * and the index need not carry it. SQLite proves that implication from the
 * SHAPE of the predicate rather than from any literal in the query text, which
 * is what separates this from `idx_attachments_created_at_id`, where a
 * `kind = 'image'` variant would have been usable only for as long as that
 * literal survived. Any future `file_path = <anything>` rides this index too.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateAttachmentsFilePathIndex(database: DrizzleDb): void {
  getSqliteFrom(database).exec(
    `CREATE INDEX IF NOT EXISTS ${INDEX}
       ON attachments (file_path)
       WHERE file_path IS NOT NULL`,
  );
}

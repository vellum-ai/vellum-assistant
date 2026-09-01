import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const INDEX = "idx_attachments_created_at_id";

/**
 * Order attachments by age, so a scan of them can be resumed.
 *
 * The camera-frame storage sweep walks aged attachments a page at a time,
 * bounding an age (`created_at < ?`), continuing from a keyset cursor
 * (`(created_at, id) > (?, ?)`), and reading them in that same order. Nothing
 * indexed any of it: `attachments` carried only a partial unique index on
 * `content_hash`, so every page was a full table scan plus a temp b-tree sort,
 * and a pass over a large install re-paid for both on each page.
 *
 * The two columns in cursor order serve all three at once. The bound and the
 * continuation are the same index seek, and the ordering falls out of the index.
 * The sweep asks nothing else of SQL: it decides what is a frame worth shrinking
 * over the rows this range returns, so a page visits only what it hands back.
 *
 * Deliberately NOT partial. A `WHERE kind = 'image'` variant is usable, since
 * the sweep's `kind` predicate is a literal SQLite can prove the implication
 * from, but its usability would then hang on that literal surviving in the query
 * text, and a size-based predicate cannot work at all because the sweep binds
 * that threshold as a parameter. A plain composite is the one that keeps working
 * when the query around it changes, and it is reusable by any other age-ordered
 * question about attachments.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateAttachmentsCreatedAtIdIndex(database: DrizzleDb): void {
  getSqliteFrom(database).exec(
    `CREATE INDEX IF NOT EXISTS ${INDEX} ON attachments (created_at, id)`,
  );
}

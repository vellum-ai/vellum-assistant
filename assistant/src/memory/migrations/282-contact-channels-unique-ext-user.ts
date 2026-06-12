import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-282");

/**
 * Deduplicate contact_channels rows sharing the same (type, external_user_id)
 * and add a partial unique index so duplicates cannot recur.
 *
 * A Slack user ID (or Telegram user ID, etc.) uniquely identifies a person
 * per channel type. Multiple rows for the same identity are data corruption,
 * not a valid state. The dedup keeps the row with the best status
 * (blocked > revoked > active > unverified > other) and most recent updated_at.
 */
export function migrateContactChannelsUniqueExtUser(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Count duplicate groups before dedup for observability.
  const dupeCount =
    raw
      .query<{ cnt: number }, []>(
        /*sql*/ `SELECT COUNT(*) AS cnt FROM (
        SELECT type, external_user_id
        FROM contact_channels
        WHERE external_user_id IS NOT NULL
        GROUP BY type, external_user_id
        HAVING COUNT(*) > 1
      )`,
      )
      .get()?.cnt ?? 0;

  // Step 1: Delete duplicate rows, keeping the best one per (type, external_user_id).
  // "Best" = lowest status rank, then most recent updated_at.
  // Blocked/revoked ranks highest because they represent explicit user decisions
  // that the rest of the contact code preserves (syncChannels guards against
  // overwriting blocked status). Active ranks next as the normal verified state.
  const result = raw.run(/*sql*/ `
    DELETE FROM contact_channels
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY type, external_user_id
                 ORDER BY
                   CASE status
                     WHEN 'blocked' THEN 0
                     WHEN 'revoked' THEN 1
                     WHEN 'active' THEN 2
                     WHEN 'unverified' THEN 3
                     ELSE 4
                   END,
                   updated_at DESC
               ) AS rn
        FROM contact_channels
        WHERE external_user_id IS NOT NULL
      )
      WHERE rn = 1
    )
    AND external_user_id IS NOT NULL
  `);

  if (dupeCount > 0 || result.changes > 0) {
    log.info(
      { duplicateGroups: dupeCount, rowsDeleted: result.changes },
      "Deduplicated contact_channels by (type, external_user_id)",
    );
  }

  // Step 2: Drop the old non-unique index (if it exists) — the unique index
  // covers the same columns and supersedes it.
  raw.run(/*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user`);

  // Step 3: Create a partial unique index on (type, external_user_id) for
  // non-null external_user_id values.
  raw.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_channels_type_ext_user_unique
             ON contact_channels(type, external_user_id)
             WHERE external_user_id IS NOT NULL`);
}

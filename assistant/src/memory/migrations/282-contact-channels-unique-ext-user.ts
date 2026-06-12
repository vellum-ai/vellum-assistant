import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-282");

/**
 * Originally this migration deduped contact_channels rows sharing the same
 * (type, external_user_id) and created a partial unique index. The unique
 * index is no longer needed because all identity lookups now use the
 * (type, address) unique constraint from migration 105. The external_user_id
 * column is redundant — address always equals canonicalize(externalUserId)
 * for every active channel type.
 *
 * This migration now:
 *  1. Still deduplicates any historical corruption (idempotent, harmless).
 *  2. Drops the partial unique index on (type, external_user_id) if it
 *     exists from a prior run.
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

  // Step 2: Drop the unique index on (type, external_user_id) — all identity
  // lookups now use the (type, address) constraint from migration 105.
  raw.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user_unique`,
  );

  // Also drop the old non-unique index if it exists from older installs.
  raw.run(/*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user`);
}

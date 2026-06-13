import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-282");

/**
 * Deduplicates contact_channels rows sharing the same (type, external_user_id)
 * and drops the indexes on that pair. All identity lookups use the
 * (type, address) unique constraint from migration 105; the external_user_id
 * column is redundant — address equals canonicalize(externalUserId) for every
 * active channel type.
 *
 * Steps:
 *  1. Deduplicates any historical corruption (idempotent, harmless).
 *  2. Drops the unique and non-unique indexes on (type, external_user_id).
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

  // Step 2: Drop the (type, external_user_id) indexes — identity is
  // enforced via the (type, address) unique constraint (migration 105).
  raw.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user_unique`,
  );

  // Also drop the old non-unique index if it exists from older installs.
  raw.run(/*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user`);
}

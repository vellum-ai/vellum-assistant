import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-283");

/**
 * Normalizes contact_channels addresses to lowercase, deduplicates rows
 * sharing the same (type, external_user_id), and drops the indexes on that
 * pair. All identity lookups use the (type, address) unique constraint from
 * migration 105; the external_user_id column is redundant — address equals
 * canonicalize(externalUserId) for every active channel type.
 *
 * Steps:
 *  1. Deduplicate by (type, LOWER(address)) — handles historical rows where
 *     Slack addresses were stored uppercase by the old gateway code.
 *  2. Lowercase all remaining address values.
 *  3. Deduplicate by (type, external_user_id) — handles corruption.
 *  4. Drop the unique and non-unique indexes on (type, external_user_id).
 */
export function migrateContactChannelsUniqueExtUser(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Step 1: Deduplicate by (type, LOWER(address)). Historical Slack channels
  // may have uppercase addresses (e.g. 'U12345') that conflict with lowercased
  // versions once we normalize. Keep the best row per group.
  const addressDedupResult = raw.run(/*sql*/ `
    DELETE FROM contact_channels
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY type, LOWER(address)
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
      )
      WHERE rn = 1
    )
  `);

  if (addressDedupResult.changes > 0) {
    log.info(
      { rowsDeleted: addressDedupResult.changes },
      "Deduplicated contact_channels by (type, LOWER(address))",
    );
  }

  // Step 2: Normalize all addresses to lowercase.
  const normalizeResult = raw.run(
    /*sql*/ `UPDATE contact_channels SET address = LOWER(address) WHERE address != LOWER(address)`,
  );

  if (normalizeResult.changes > 0) {
    log.info(
      { rowsUpdated: normalizeResult.changes },
      "Normalized contact_channels addresses to lowercase",
    );
  }

  // Step 3: Deduplicate by (type, external_user_id) — handles historical
  // corruption where multiple rows share the same external identity.
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

  const extUserDedupResult = raw.run(/*sql*/ `
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

  if (dupeCount > 0 || extUserDedupResult.changes > 0) {
    log.info(
      { duplicateGroups: dupeCount, rowsDeleted: extUserDedupResult.changes },
      "Deduplicated contact_channels by (type, external_user_id)",
    );
  }

  // Step 4: Drop the (type, external_user_id) indexes — identity is
  // enforced via the (type, address) unique constraint (migration 105).
  raw.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user_unique`,
  );

  // Also drop the old non-unique index if it exists from older installs.
  raw.run(/*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user`);
}

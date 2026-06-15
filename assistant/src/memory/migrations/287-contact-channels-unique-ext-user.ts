import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-287");

/**
 * Deduplicates historical case collisions in contact_channels, restores
 * original platform-provided casing, and drops the (type, external_user_id)
 * indexes.
 *
 * Historical writes lowercased addresses inconsistently — some paths stored
 * 'U12345' and others stored 'u12345' for the same identity. This migration
 * resolves those collisions by keeping the best row per (type, address)
 * group (case-insensitive match for dedup only), then restores original
 * casing from external_user_id into address.
 *
 * Steps:
 *  1. Deduplicate by (type, address) case-insensitively — keeps the best row.
 *  2. Normalize addresses — restore original casing from external_user_id.
 *  3. Drop the (type, external_user_id) indexes — external_user_id is
 *     redundant with address for every active channel type.
 */
export function migrateContactChannelsUniqueExtUser(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Step 1: Deduplicate historical case collisions. After this, the existing
  // case-sensitive UNIQUE(type, address) constraint remains valid because
  // only one row per case-insensitive group survives.
  const addressDedupResult = raw.run(/*sql*/ `
    DELETE FROM contact_channels
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY type, address COLLATE NOCASE
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
      "Deduplicated contact_channels by (type, address) case-insensitive",
    );
  }

  // Step 2: Restore original platform-provided casing. external_user_id
  // stores the exact value from the platform (e.g. "U12345ABC") while
  // address may have been lowercased by old write paths.
  const normalizeResult = raw.run(/*sql*/ `
    UPDATE contact_channels
    SET address = external_user_id
    WHERE external_user_id IS NOT NULL
      AND address != external_user_id
  `);

  if (normalizeResult.changes > 0) {
    log.info(
      { rowsUpdated: normalizeResult.changes },
      "Restored original casing from external_user_id into address",
    );
  }

  // Step 3: Drop the (type, external_user_id) indexes — identity is
  // enforced via the (type, address) unique constraint.
  raw.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user_unique`,
  );
  raw.run(/*sql*/ `DROP INDEX IF EXISTS idx_contact_channels_type_ext_user`);
}

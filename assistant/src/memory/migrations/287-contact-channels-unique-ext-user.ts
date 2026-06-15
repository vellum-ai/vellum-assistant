import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-287");

/**
 * Deduplicates historical case collisions in contact_channels and restores
 * original platform-provided casing.
 *
 * Historical writes lowercased addresses inconsistently — some paths stored
 * 'U12345' and others stored 'u12345' for the same identity. This migration
 * resolves those collisions by keeping the best row per (type, address)
 * group (case-insensitive match for dedup only), then restores original
 * casing from external_user_id into address.
 *
 * Steps:
 *  1. Deduplicate by (type, address) case-insensitively — keeps the best row.
 *  2. Deduplicate by (type, external_user_id) case-insensitively — prevents
 *     collisions when step 4 normalizes addresses from external_user_id.
 *  3. Remove cross-column collision blockers — rows with NULL external_user_id
 *     whose address equals another row's external_user_id.
 *  4. Normalize addresses — restore original casing from external_user_id.
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

  // Step 2: Deduplicate by (type, external_user_id) so that step 3's
  // normalization (SET address = external_user_id) cannot produce collisions.
  // Two rows with different addresses but the same external_user_id would
  // both get the same address after normalization.
  const extIdDedupResult = raw.run(/*sql*/ `
    DELETE FROM contact_channels
    WHERE external_user_id IS NOT NULL
      AND id NOT IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY type, external_user_id COLLATE NOCASE
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
  `);

  if (extIdDedupResult.changes > 0) {
    log.info(
      { rowsDeleted: extIdDedupResult.changes },
      "Deduplicated contact_channels by (type, external_user_id)",
    );
  }

  // Step 3: Remove rows that would block normalization due to cross-column
  // collisions. A row with NULL external_user_id whose address equals another
  // row's external_user_id prevents that row's normalization (UNIQUE violation).
  const crossColResult = raw.run(/*sql*/ `
    DELETE FROM contact_channels
    WHERE external_user_id IS NULL
      AND id IN (
        SELECT blocker.id
        FROM contact_channels AS blocker
        INNER JOIN contact_channels AS normalizer
          ON normalizer.type = blocker.type
          AND normalizer.external_user_id = blocker.address
          AND normalizer.address != normalizer.external_user_id
          AND normalizer.external_user_id IS NOT NULL
          AND normalizer.id != blocker.id
      )
  `);

  if (crossColResult.changes > 0) {
    log.info(
      { rowsDeleted: crossColResult.changes },
      "Removed cross-column collision blockers",
    );
  }

  // Step 4: Restore original platform-provided casing. external_user_id
  // stores the exact value from the platform (e.g. "U12345ABC") while
  // address may have been lowercased by old write paths. UPDATE OR IGNORE
  // as a safety net for any remaining edge cases.
  const normalizeResult = raw.run(/*sql*/ `
    UPDATE OR IGNORE contact_channels
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
}

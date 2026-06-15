import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-288");

/**
 * Re-normalizes contact_channels addresses from external_user_id.
 *
 * Between migration 287 (which first normalized addresses) and this migration
 * (which lands with the lookup refactor), write paths may have re-lowercased
 * addresses. This idempotent pass restores original platform casing so that
 * the new exact-match lookups on address work correctly.
 */
export function migrateContactChannelsRenormalizeAddresses(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Remove rows that would block normalization due to cross-column collisions.
  raw.run(/*sql*/ `
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

  const result = raw.run(/*sql*/ `
    UPDATE OR IGNORE contact_channels
    SET address = external_user_id
    WHERE external_user_id IS NOT NULL
      AND address != external_user_id
  `);

  if (result.changes > 0) {
    log.info(
      { rowsUpdated: result.changes },
      "Re-normalized contact_channels addresses from external_user_id",
    );
  }
}

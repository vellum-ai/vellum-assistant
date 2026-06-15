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

  const result = raw.run(/*sql*/ `
    UPDATE contact_channels
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

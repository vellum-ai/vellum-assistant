import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-290");

/**
 * Restores original platform-provided casing into address from external_user_id.
 *
 * Idempotent: rows where address already equals external_user_id are no-ops.
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
          AND normalizer.external_user_id = blocker.address COLLATE NOCASE
          AND normalizer.address != normalizer.external_user_id
          AND normalizer.external_user_id IS NOT NULL
          AND normalizer.id != blocker.id
      )
  `);

  // Non-email channels: restore original platform casing from external_user_id.
  const nonEmailResult = raw.run(/*sql*/ `
    UPDATE OR IGNORE contact_channels
    SET address = external_user_id
    WHERE external_user_id IS NOT NULL
      AND address != external_user_id
      AND type != 'email'
  `);

  // Email channels: ensure address is lowercased (canonical per RFC 5321).
  const emailResult = raw.run(/*sql*/ `
    UPDATE OR IGNORE contact_channels
    SET address = LOWER(external_user_id)
    WHERE type = 'email'
      AND external_user_id IS NOT NULL
      AND address != LOWER(external_user_id)
  `);

  const totalChanges = nonEmailResult.changes + emailResult.changes;
  if (totalChanges > 0) {
    log.info(
      { rowsUpdated: totalChanges },
      "Re-normalized contact_channels addresses from external_user_id",
    );
  }
}

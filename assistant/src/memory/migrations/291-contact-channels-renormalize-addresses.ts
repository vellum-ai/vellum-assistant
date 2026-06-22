import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-291");

/**
 * Restores original platform-provided casing into address from external_user_id
 * for channels where the raw platform ID is the canonical identity (Slack,
 * Telegram, etc.). Phone and WhatsApp channels are excluded because their
 * canonical form (E.164) may differ from the raw external_user_id.
 *
 * Idempotent: rows where address already equals external_user_id are no-ops.
 */
export function migrateContactChannelsRenormalizeAddresses(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // A later migration drops external_user_id; once it has run there is nothing
  // to renormalize from. This step re-runs on every startup, so skip when the
  // column is absent rather than referencing it and failing.
  const cols = raw.prepare("PRAGMA table_info(contact_channels)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "external_user_id")) {
    return;
  }

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

  // Non-phone, non-email channels: restore original platform casing from
  // external_user_id. Phone/WhatsApp are excluded because their canonical
  // form (E.164 with '+' prefix) may differ from the raw external_user_id.
  const nonEmailResult = raw.run(/*sql*/ `
    UPDATE OR IGNORE contact_channels
    SET address = external_user_id
    WHERE external_user_id IS NOT NULL
      AND address != external_user_id
      AND type NOT IN ('email', 'phone', 'whatsapp')
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

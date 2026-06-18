import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-294");

/**
 * Drops the `external_user_id` column and its index from `contact_channels`.
 *
 * `address` is the single canonical identity column; `external_user_id` is
 * redundant. The index `idx_contact_channels_type_ext_user` must be dropped
 * first — SQLite refuses to drop a column referenced by an index.
 *
 * Idempotent: skips if the column has already been dropped.
 */
export function migrateDropExternalUserId(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const cols = raw.prepare("PRAGMA table_info(contact_channels)").all() as {
    name: string;
  }[];
  const hasColumn = cols.some((c) => c.name === "external_user_id");

  if (!hasColumn) {
    log.info("external_user_id column already absent — skipping");
    return;
  }

  raw.run("DROP INDEX IF EXISTS idx_contact_channels_type_ext_user");
  raw.run("ALTER TABLE contact_channels DROP COLUMN external_user_id");
  log.info("Dropped external_user_id column from contact_channels");
}

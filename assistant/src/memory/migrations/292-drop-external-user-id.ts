import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-292");

/**
 * Drops the `external_user_id` column from `contact_channels`.
 *
 * The column is fully redundant: `address` is the single canonical identity
 * column and every write path already canonicalizes into it. All reads that
 * previously fell back through `externalUserId ?? address` now read `address`
 * directly.
 *
 * Idempotent: skips if the column has already been dropped (fresh installs
 * or re-runs).
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

  raw.run("ALTER TABLE contact_channels DROP COLUMN external_user_id");
  log.info("Dropped external_user_id column from contact_channels");
}

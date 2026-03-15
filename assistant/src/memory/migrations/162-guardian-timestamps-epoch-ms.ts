import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const log = getLogger("migration-162");

/**
 * Convert guardian table timestamps from ISO 8601 text to epoch ms integers.
 *
 * The `canonical_guardian_requests`, `canonical_guardian_deliveries`, and
 * `scoped_approval_grants` tables originally used TEXT for timestamp columns
 * while all other tables use INTEGER (epoch ms). This migration converts
 * existing data in-place — SQLite's dynamic typing allows storing integers
 * in columns declared as TEXT without a table rebuild.
 */
export function migrateGuardianTimestampsEpochMs(database: DrizzleDb): void {
  withCrashRecovery(
    database,
    "migration_guardian_timestamps_epoch_ms_v1",
    () => {
      const raw = getSqliteFrom(database);

      // Convert canonical_guardian_requests timestamp columns
      raw.exec(/*sql*/ `
      UPDATE canonical_guardian_requests
      SET created_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000 + CAST(substr(created_at, 21, 3) AS INTEGER),
          updated_at = CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + CAST(substr(updated_at, 21, 3) AS INTEGER),
          expires_at = CASE
            WHEN expires_at IS NOT NULL
            THEN CAST(strftime('%s', expires_at) AS INTEGER) * 1000 + CAST(substr(expires_at, 21, 3) AS INTEGER)
            ELSE NULL
          END
      WHERE typeof(created_at) = 'text'
    `);

      // Convert canonical_guardian_deliveries timestamp columns
      raw.exec(/*sql*/ `
      UPDATE canonical_guardian_deliveries
      SET created_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000 + CAST(substr(created_at, 21, 3) AS INTEGER),
          updated_at = CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + CAST(substr(updated_at, 21, 3) AS INTEGER)
      WHERE typeof(created_at) = 'text'
    `);

      // Convert scoped_approval_grants timestamp columns
      raw.exec(/*sql*/ `
      UPDATE scoped_approval_grants
      SET expires_at = CAST(strftime('%s', expires_at) AS INTEGER) * 1000 + CAST(substr(expires_at, 21, 3) AS INTEGER),
          created_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000 + CAST(substr(created_at, 21, 3) AS INTEGER),
          updated_at = CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + CAST(substr(updated_at, 21, 3) AS INTEGER),
          consumed_at = CASE
            WHEN consumed_at IS NOT NULL
            THEN CAST(strftime('%s', consumed_at) AS INTEGER) * 1000 + CAST(substr(consumed_at, 21, 3) AS INTEGER)
            ELSE NULL
          END
      WHERE typeof(created_at) = 'text'
    `);

      log.info(
        "Converted guardian table timestamps from ISO 8601 text to epoch ms",
      );
    },
  );
}

import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Add enrichment columns to canonical_guardian_requests for guardian
 * approval UX:
 *
 * - command_preview: truncated command/input preview (first ~500 chars)
 * - risk_level: "low", "medium", "high"
 * - activity_text: LLM's explanation of why it's calling the tool
 * - execution_target: "sandbox" or "host"
 *
 * All columns are nullable TEXT — existing rows default to NULL.
 */
export function migrateGuardianRequestEnrichmentColumns(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_guardian_request_enrichment_columns_v1",
    () => {
      const raw = getSqliteFrom(database);

      if (
        !tableHasColumn(
          database,
          "canonical_guardian_requests",
          "command_preview",
        )
      ) {
        raw.exec(
          /*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN command_preview TEXT`,
        );
      }

      if (
        !tableHasColumn(database, "canonical_guardian_requests", "risk_level")
      ) {
        raw.exec(
          /*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN risk_level TEXT`,
        );
      }

      if (
        !tableHasColumn(
          database,
          "canonical_guardian_requests",
          "activity_text",
        )
      ) {
        raw.exec(
          /*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN activity_text TEXT`,
        );
      }

      if (
        !tableHasColumn(
          database,
          "canonical_guardian_requests",
          "execution_target",
        )
      ) {
        raw.exec(
          /*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN execution_target TEXT`,
        );
      }
    },
  );
}

import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const log = getLogger("migration-317");

const TELEMETRY_COLUMNS = [
  "last_seen_at",
  "interaction_count",
  "last_interaction",
] as const;

/**
 * Drops the `contact_channels` interaction-telemetry columns
 * (`last_seen_at`, `interaction_count`, `last_interaction`).
 *
 * Interaction telemetry is gateway-owned: reads source it from the stamped
 * trust verdict and the gateway rich-read relay, and writes go only to the
 * gateway DB. The assistant-side columns are dead weight.
 *
 * No DROP INDEX needed: none of these columns are covered by a contact_channels
 * index and they carry no FK. Idempotent via the per-column presence guard.
 */
export function migrateDropContactChannelTelemetry(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  for (const column of TELEMETRY_COLUMNS) {
    if (!tableHasColumn(database, "contact_channels", column)) continue;
    raw.run(/*sql*/ `ALTER TABLE contact_channels DROP COLUMN ${column}`);
    log.info(`Dropped ${column} column from contact_channels`);
  }
}

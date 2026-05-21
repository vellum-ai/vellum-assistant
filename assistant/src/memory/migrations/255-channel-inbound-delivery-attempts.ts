import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_channel_inbound_delivery_attempts_v1";

/** Add a delivery-specific retry counter for channel inbound events. */
export function migrateChannelInboundDeliveryAttempts(
  database: DrizzleDb,
): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    if (
      tableHasColumn(database, "channel_inbound_events", "delivery_attempts")
    ) {
      return;
    }
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      ALTER TABLE channel_inbound_events
        ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0
    `);
  });
}

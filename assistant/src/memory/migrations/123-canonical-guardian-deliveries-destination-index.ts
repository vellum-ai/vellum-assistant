import type { DrizzleDb } from '../db-connection.js';

/**
 * Add composite index on canonical_guardian_deliveries(destination_channel, destination_chat_id).
 *
 * The listPendingCanonicalGuardianRequestsByDestinationChat helper queries
 * deliveries by (destination_channel, destination_chat_id) to bridge inbound
 * guardian replies back to canonical requests. Without an index these
 * degrade to full table scans as delivery history grows.
 */
export function migrateCanonicalGuardianDeliveriesDestinationIndex(database: DrizzleDb): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_destination ON canonical_guardian_deliveries(destination_channel, destination_chat_id)`,
  );
}

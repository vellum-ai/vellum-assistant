import type { DrizzleDb } from "../db-connection.js";

/**
 * Add index on guardian_action_deliveries.destination_conversation_id.
 *
 * Several lookup paths (getPendingDeliveriesByConversation,
 * getExpiredDeliveriesByConversation, getFollowupDeliveriesByConversation)
 * filter deliveries by destination_conversation_id. Without an index
 * these degrade to full table scans as delivery history grows.
 */
export function migrateGuardianDeliveryConversationIndex(
  database: DrizzleDb,
): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_deliveries_dest_conversation ON guardian_action_deliveries(destination_conversation_id)`,
  );
}

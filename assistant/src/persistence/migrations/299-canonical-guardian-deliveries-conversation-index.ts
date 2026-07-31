import type { DrizzleDb } from "../db-connection.js";

/**
 * Add index on canonical_guardian_deliveries(destination_conversation_id).
 *
 * Guardian cards record their associated internal conversation on every
 * delivery — channel cards as well as in-app — and the conversation-scope
 * readers (candidate enrichment, decision gate, reply-routing seed) look up
 * pending requests by destination_conversation_id. Candidate enrichment runs on
 * the per-notification routing path, so without this index those lookups
 * degrade to full table scans as delivery history grows.
 */
export function migrateCanonicalGuardianDeliveriesConversationIndex(
  database: DrizzleDb,
): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_dest_conversation ON canonical_guardian_deliveries(destination_conversation_id)`,
  );
}

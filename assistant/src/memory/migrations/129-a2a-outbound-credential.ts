import type { DrizzleDb } from '../db-connection.js';

/**
 * Add outbound_credential column to a2a_peer_connections.
 *
 * Stores the raw outbound credential token that this assistant uses to
 * HMAC-sign requests TO the peer. Previously only the hash was stored,
 * but outbound message signing requires the raw credential.
 */
export function migrateA2AOutboundCredential(database: DrizzleDb): void {
  try {
    database.run(/*sql*/ `ALTER TABLE a2a_peer_connections ADD COLUMN outbound_credential TEXT`);
  } catch {
    // Column already exists — idempotent
  }
}

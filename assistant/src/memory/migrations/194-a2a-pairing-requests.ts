import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the a2a_pairing_requests table for tracking A2A pairing handshake
 * state. Uses CREATE TABLE IF NOT EXISTS for idempotency.
 */
export function createA2aPairingRequestsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS a2a_pairing_requests (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      invite_code TEXT NOT NULL,
      remote_assistant_id TEXT NOT NULL,
      remote_gateway_url TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  // Unique index on invite_code for fast lookup during handshake validation.
  // Wrapped in try-catch for idempotency (index may already exist).
  try {
    database.run(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_pairing_invite_code
      ON a2a_pairing_requests (invite_code)
    `);
  } catch {
    // Index already exists — safe to ignore.
  }
}

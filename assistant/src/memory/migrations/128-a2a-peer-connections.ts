import type { DrizzleDb } from '../db-connection.js';

/**
 * Create the a2a_peer_connections table for bidirectional peer assistant connections.
 *
 * Stores the persistent connection state between two assistants: credential pairs,
 * peer gateway URL, protocol version, negotiated capabilities, granted scopes,
 * and lifecycle timestamps.
 *
 * The `inbound_credential` column stores the raw credential token that peer
 * assistants use to sign inbound requests. It is required for HMAC-SHA256
 * signature verification at the runtime layer. The `inbound_credential_hash`
 * column stores its SHA-256 hash for identification/revocation checks.
 */
export function createA2APeerConnectionsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS a2a_peer_connections (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      peer_assistant_id TEXT,
      peer_gateway_url TEXT NOT NULL,
      peer_display_name TEXT,
      invite_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      protocol_version TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      scopes TEXT NOT NULL DEFAULT '[]',
      outbound_credential_hash TEXT,
      inbound_credential_hash TEXT,
      inbound_credential TEXT,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revoked_reason TEXT,
      expires_at INTEGER
    )
  `);

  // For databases that already have the table from a prior migration run,
  // add the inbound_credential column if it doesn't exist.
  try {
    database.run(/*sql*/ `ALTER TABLE a2a_peer_connections ADD COLUMN inbound_credential TEXT`);
  } catch {
    // Column already exists — expected for fresh databases where CREATE TABLE
    // included it, or for databases that already ran this migration.
  }

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_a2a_peer_connections_status
      ON a2a_peer_connections(assistant_id, status)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_a2a_peer_connections_gateway_url
      ON a2a_peer_connections(peer_gateway_url)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_a2a_peer_connections_peer_assistant_id
      ON a2a_peer_connections(peer_assistant_id)
      WHERE peer_assistant_id IS NOT NULL`,
  );
}

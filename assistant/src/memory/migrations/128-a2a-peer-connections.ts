import type { DrizzleDb } from '../db-connection.js';

/**
 * Create the a2a_peer_connections table for bidirectional peer assistant connections.
 *
 * Stores the persistent connection state between two assistants: credential pairs,
 * peer gateway URL, protocol version, negotiated capabilities, granted scopes,
 * and lifecycle timestamps.
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
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revoked_reason TEXT,
      expires_at INTEGER
    )
  `);

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

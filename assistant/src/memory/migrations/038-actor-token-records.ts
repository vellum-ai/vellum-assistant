import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Create the actor_token_records table for hash-only actor token persistence.
 *
 * Stores the SHA-256 hash of each actor token alongside metadata for
 * verification and revocation. The raw token plaintext is never stored.
 *
 * NOTE: This table now lives in the gateway database.
 * See gateway/src/db/data-migrations/m0002-actor-token-tables-to-gateway.ts.
 */
export function createActorTokenRecordsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS actor_token_records (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      guardian_principal_id TEXT NOT NULL,
      hashed_device_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      issued_at INTEGER NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Unique active token per device binding
  if (tableHasColumn(database, "actor_token_records", "assistant_id")) {
    database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_tokens_active_device
      ON actor_token_records(assistant_id, guardian_principal_id, hashed_device_id)
      WHERE status = 'active'`);
  } else {
    database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_tokens_active_device
      ON actor_token_records(guardian_principal_id, hashed_device_id)
      WHERE status = 'active'`);
  }

  // Token hash lookup for verification
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_actor_tokens_hash
      ON actor_token_records(token_hash)
      WHERE status = 'active'`);
}

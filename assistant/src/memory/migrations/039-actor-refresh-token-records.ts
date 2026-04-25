import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Create the actor_refresh_token_records table for hash-only refresh token persistence.
 *
 * Stores the SHA-256 hash of each refresh token with family tracking,
 * device binding, and dual expiry (absolute + inactivity).
 * The raw token plaintext is never stored.
 *
 * NOTE: This table now lives in the gateway database.
 * See gateway/src/db/data-migrations/m0002-actor-token-tables-to-gateway.ts.
 */
export function createActorRefreshTokenRecordsTable(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS actor_refresh_token_records (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      family_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      guardian_principal_id TEXT NOT NULL,
      hashed_device_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      issued_at INTEGER NOT NULL,
      absolute_expires_at INTEGER NOT NULL,
      inactivity_expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Token hash lookup (any status — needed for replay detection)
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash
      ON actor_refresh_token_records(token_hash)`);

  // Unique active refresh token per device binding.
  // DROP first so that databases that already created the older non-unique
  // index with the same name get upgraded to UNIQUE.
  if (tableHasColumn(database, "actor_refresh_token_records", "assistant_id")) {
    database.run(
      /*sql*/ `DROP INDEX IF EXISTS idx_refresh_tokens_active_device`,
    );
    database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_active_device
      ON actor_refresh_token_records(assistant_id, guardian_principal_id, hashed_device_id)
      WHERE status = 'active'`);
  } else {
    database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_active_device
      ON actor_refresh_token_records(guardian_principal_id, hashed_device_id)
      WHERE status = 'active'`);
  }

  // Family lookup for replay detection (revoke entire family)
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family
      ON actor_refresh_token_records(family_id)`);
}

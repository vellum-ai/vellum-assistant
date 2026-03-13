import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Add a required contact_id column to assistant_ingress_invites.
 * Invites must be bound to the contact they were created for.
 * Legacy rows without a contact_id are deleted since they cannot
 * be redeemed correctly.
 *
 * Steps:
 *  1. Add the column as nullable.
 *  2. Delete legacy rows that have no contact binding (NULL).
 *  3. Rebuild the table to enforce NOT NULL (SQLite cannot ALTER COLUMN).
 */
export function migrateInviteContactId(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_invite_contact_id_v1", () => {
    const raw = getSqliteFrom(database);

    const cols = (
      raw.query(`PRAGMA table_info(assistant_ingress_invites)`).all() as Array<{
        name: string;
        notnull: number;
      }>
    ).map((c) => ({ name: c.name, notnull: c.notnull }));

    const col = cols.find((c) => c.name === "contact_id");

    // Step 1: Add the column as nullable
    if (!col) {
      raw.exec(
        /*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN contact_id TEXT`,
      );
    }

    // Step 2: Delete legacy rows with no contact binding
    raw.exec(
      /*sql*/ `DELETE FROM assistant_ingress_invites WHERE contact_id IS NULL OR contact_id = ''`,
    );

    // Step 3: Rebuild the table with NOT NULL on contact_id
    if (col && col.notnull === 1) return; // already NOT NULL

    raw.exec("PRAGMA foreign_keys = OFF");
    try {
      raw.exec(/*sql*/ `
          BEGIN;

          CREATE TABLE assistant_ingress_invites_new (
            id TEXT PRIMARY KEY,
            source_channel TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            created_by_session_id TEXT,
            note TEXT,
            max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
            use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
            expires_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            redeemed_by_external_user_id TEXT,
            redeemed_by_external_chat_id TEXT,
            redeemed_at INTEGER,
            expected_external_user_id TEXT,
            voice_code_hash TEXT,
            voice_code_digits INTEGER,
            invite_code_hash TEXT,
            friend_name TEXT,
            guardian_name TEXT,
            contact_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );

          INSERT INTO assistant_ingress_invites_new
          SELECT id, source_channel, token_hash, created_by_session_id, note,
                 max_uses, use_count, expires_at, status,
                 redeemed_by_external_user_id, redeemed_by_external_chat_id,
                 redeemed_at, expected_external_user_id, voice_code_hash,
                 voice_code_digits, invite_code_hash, friend_name, guardian_name,
                 contact_id, created_at, updated_at
          FROM assistant_ingress_invites;

          DROP TABLE assistant_ingress_invites;
          ALTER TABLE assistant_ingress_invites_new RENAME TO assistant_ingress_invites;

          CREATE UNIQUE INDEX IF NOT EXISTS idx_ingress_invites_token_hash
            ON assistant_ingress_invites(token_hash);
          CREATE INDEX IF NOT EXISTS idx_ingress_invites_channel_status
            ON assistant_ingress_invites(source_channel, status, expires_at);
          CREATE INDEX IF NOT EXISTS idx_ingress_invites_channel_created
            ON assistant_ingress_invites(source_channel, created_at);

          COMMIT;
        `);
    } catch (e) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      throw e;
    } finally {
      raw.exec("PRAGMA foreign_keys = ON");
    }
  });
}

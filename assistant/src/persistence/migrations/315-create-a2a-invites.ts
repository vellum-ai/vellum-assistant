import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Creates the `a2a_invites` table: daemon-local store for A2A invite tokens.
 *
 * A2A invites are peer-assistant bindings outside the human-trust ACL model,
 * so they live in the assistant DB rather than the gateway's `ingress_invites`
 * table. The table carries exactly the columns the A2A flow uses.
 *
 * Existing A2A rows are copied from `assistant_ingress_invites` (guarded on
 * the source table's existence) so in-flight invites survive. Source rows are
 * left in place — that table is dropped wholesale by a later migration.
 *
 * Idempotent: `IF NOT EXISTS` table creation and `INSERT OR IGNORE` copy.
 */
export function migrateCreateA2aInvitesTable(db: DrizzleDb): void {
  const raw = getSqliteFrom(db);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS a2a_invites (
      id                           TEXT PRIMARY KEY,
      token_hash                   TEXT NOT NULL,
      contact_id                   TEXT NOT NULL,
      max_uses                     INTEGER NOT NULL DEFAULT 1,
      use_count                    INTEGER NOT NULL DEFAULT 0,
      expires_at                   INTEGER NOT NULL,
      status                       TEXT NOT NULL DEFAULT 'active',
      redeemed_by_external_user_id TEXT,
      redeemed_at                  INTEGER,
      created_at                   INTEGER NOT NULL,
      updated_at                   INTEGER NOT NULL
    )
  `);
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_a2a_invites_token_hash ON a2a_invites(token_hash)`,
  );

  const sourceExists = raw
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_ingress_invites'`,
    )
    .get();
  if (!sourceExists) {
    return;
  }

  raw.exec(/*sql*/ `
    INSERT OR IGNORE INTO a2a_invites (
      id, token_hash, contact_id, max_uses, use_count, expires_at, status,
      redeemed_by_external_user_id, redeemed_at, created_at, updated_at
    )
    SELECT
      id, token_hash, contact_id, max_uses, use_count, expires_at, status,
      redeemed_by_external_user_id, redeemed_at, created_at, updated_at
    FROM assistant_ingress_invites
    WHERE source_channel = 'a2a'
  `);
}

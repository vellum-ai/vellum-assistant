import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v21: rename channel_verification_sessions back to
 * channel_guardian_verification_challenges and recreate old indexes.
 */
export function downRenameVerificationTable(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Check the new table exists before attempting anything
  const newTableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_verification_sessions'`,
    )
    .get();
  if (!newTableExists) return;

  // If the old table already exists, skip (already rolled back)
  const oldTableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_guardian_verification_challenges'`,
    )
    .get();
  if (oldTableExists) return;

  // Rename back to old name
  raw.exec(
    /*sql*/ `ALTER TABLE channel_verification_sessions RENAME TO channel_guardian_verification_challenges`,
  );

  // Drop new-style indexes and recreate old-style ones
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_lookup`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_active`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_identity`);
  raw.exec(
    /*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_destination`,
  );
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_bootstrap`);

  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_challenges_lookup ON channel_guardian_verification_challenges(channel, challenge_hash, status)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_active ON channel_guardian_verification_challenges(channel, status)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_identity ON channel_guardian_verification_challenges(channel, expected_external_user_id, expected_chat_id, status)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_destination ON channel_guardian_verification_challenges(channel, destination_address)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_bootstrap ON channel_guardian_verification_challenges(channel, bootstrap_token_hash, status)`,
  );
}

/**
 * One-shot migration: rename channel_guardian_verification_challenges →
 * channel_verification_sessions, including all indexes that reference the
 * old table name.
 */
export function migrateRenameVerificationTable(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_rename_verification_table_v1", () => {
    const raw = getSqliteFrom(database);

    // Check the old table exists before attempting anything
    const oldTableExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_guardian_verification_challenges'`,
      )
      .get();
    if (!oldTableExists) return;

    // If the new table already exists, the rename would collide — skip
    const newTableExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_verification_sessions'`,
      )
      .get();
    if (newTableExists) return;

    // Rename the physical table
    raw.exec(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges RENAME TO channel_verification_sessions`,
    );

    // Drop and recreate indexes that referenced the old table name.
    // SQLite automatically updates index table references on RENAME, but the
    // index names still reference the old naming convention — drop and recreate
    // with consistent names pointing at the new table.

    raw.exec(
      /*sql*/ `DROP INDEX IF EXISTS idx_channel_guardian_challenges_lookup`,
    );
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_active`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_identity`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_destination`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_bootstrap`);

    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_lookup ON channel_verification_sessions(channel, challenge_hash, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_active ON channel_verification_sessions(channel, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_identity ON channel_verification_sessions(channel, expected_external_user_id, expected_chat_id, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_destination ON channel_verification_sessions(channel, destination_address)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_bootstrap ON channel_verification_sessions(channel, bootstrap_token_hash, status)`,
    );
  });
}

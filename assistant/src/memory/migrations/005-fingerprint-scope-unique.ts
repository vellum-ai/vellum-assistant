import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Migrate from a column-level UNIQUE on fingerprint to a compound unique
 * index on (fingerprint, scope_id) so that the same item can exist in
 * different scopes independently.
 */
export function migrateMemoryItemsFingerprintScopeUnique(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_memory_items_fingerprint_scope_unique_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // Check if the old column-level UNIQUE constraint still exists by inspecting
  // the CREATE TABLE DDL for the word UNIQUE (the PK also creates an autoindex,
  // so we cannot rely on sqlite_autoindex_* presence alone).
  const tableDdl = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
    )
    .get() as { sql: string } | null;
  if (
    !tableDdl ||
    !tableDdl.sql.match(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
  ) {
    // No column-level UNIQUE on fingerprint — either fresh DB or already migrated.
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    return;
  }

  // Rebuild the table without the column-level UNIQUE constraint.
  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    // Create new table without UNIQUE on fingerprint — all other columns
    // match the latest schema (including migration-added columns).
    raw.exec(/*sql*/ `
      CREATE TABLE memory_items_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        fingerprint TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_used_at INTEGER,
        importance REAL,
        access_count INTEGER NOT NULL DEFAULT 0,
        valid_from INTEGER,
        invalid_at INTEGER,
        verification_state TEXT NOT NULL DEFAULT 'assistant_inferred',
        scope_id TEXT NOT NULL DEFAULT 'default'
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO memory_items_new
      SELECT id, kind, subject, statement, status, confidence, fingerprint,
             first_seen_at, last_seen_at, last_used_at, importance, access_count,
             valid_from, invalid_at, verification_state, scope_id
      FROM memory_items
    `);

    raw.exec(/*sql*/ `DROP TABLE memory_items`);
    raw.exec(/*sql*/ `ALTER TABLE memory_items_new RENAME TO memory_items`);

    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());

    raw.exec("COMMIT");
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
}

/**
 * Reverse the compound (fingerprint, scope_id) unique index change by rebuilding
 * memory_items with a column-level UNIQUE on fingerprint.
 *
 * WARNING: This is dangerous if data now relies on the compound constraint
 * (i.e., the same fingerprint exists in multiple scopes). In that case, the
 * rebuild will fail with a UNIQUE constraint violation. This is intentional —
 * it prevents silent data loss on rollback.
 */
export function downMemoryItemsFingerprintScopeUnique(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Check if the column-level UNIQUE already exists — if so, nothing to do.
  const tableDdl = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
    )
    .get() as { sql: string } | null;
  if (
    !tableDdl ||
    tableDdl.sql.match(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
  ) {
    return;
  }

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      CREATE TABLE memory_items_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_used_at INTEGER,
        importance REAL,
        access_count INTEGER NOT NULL DEFAULT 0,
        valid_from INTEGER,
        invalid_at INTEGER,
        verification_state TEXT NOT NULL DEFAULT 'assistant_inferred',
        scope_id TEXT NOT NULL DEFAULT 'default'
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO memory_items_new
      SELECT id, kind, subject, statement, status, confidence, fingerprint,
             first_seen_at, last_seen_at, last_used_at, importance, access_count,
             valid_from, invalid_at, verification_state, scope_id
      FROM memory_items
    `);

    raw.exec(/*sql*/ `DROP TABLE memory_items`);
    raw.exec(/*sql*/ `ALTER TABLE memory_items_new RENAME TO memory_items`);

    raw.exec("COMMIT");
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
}

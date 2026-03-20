import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const logger = getLogger("messages-fts");

/**
 * FTS5 virtual table for full-text search over messages.content.
 *
 * Content is stored as raw JSON in the messages table — the FTS tokenizer
 * handles it well enough for keyword search since the structural JSON tokens
 * (type, text, tool_use) are short common words that rarely matter as search
 * terms.  The existing buildExcerpt() in conversation-store handles extracting
 * readable text from JSON for display after matching.
 *
 * ## Trigger atomicity and failure modes
 *
 * SQLite triggers execute atomically within the triggering statement's
 * transaction. If the FTS trigger fails (e.g., corrupted FTS index), the
 * entire statement — including the base table INSERT/UPDATE/DELETE — is
 * rolled back. This means a trigger failure does NOT silently lose FTS
 * data; instead, it prevents the base operation from succeeding at all.
 *
 * The real risk is the reverse: a corrupted FTS virtual table will cause
 * ALL writes to the messages table to fail until the FTS table is rebuilt.
 * If this happens, `messages_fts` should be dropped and recreated, then
 * backfilled via `migrateMessagesFtsBackfill`.
 *
 * ## Auto-recovery from corruption
 *
 * After creating (or finding an existing) messages_fts table, we probe it
 * with a lightweight MATCH query that exercises the FTS inverted index
 * in O(1). If the probe throws SQLITE_CORRUPT_VTAB or SQLITE_CORRUPT,
 * we drop the shadow tables directly (since DROP TABLE on a corrupt
 * vtable can itself throw) and recreate it. The subsequent
 * `migrateMessagesFtsBackfill` call in db-init.ts will repopulate the
 * index from the messages table — no message data is lost.
 */
function isSqliteCorruptionError(err: unknown): boolean {
  const code =
    err != null && typeof err === "object" && "code" in err
      ? (err as { code: string }).code
      : undefined;
  return code === "SQLITE_CORRUPT_VTAB" || code === "SQLITE_CORRUPT";
}

/**
 * Drop all FTS5 shadow tables and triggers directly. This avoids going
 * through `DROP TABLE messages_fts` which itself can throw on a corrupt
 * vtable. The shadow table names follow the FTS5 naming convention:
 * `<table>_content`, `<table>_data`, `<table>_idx`, `<table>_docsize`,
 * `<table>_config`.
 */
function dropFtsShadowTables(raw: ReturnType<typeof getSqliteFrom>): void {
  const statements = [
    `DROP TRIGGER IF EXISTS messages_fts_ai`,
    `DROP TRIGGER IF EXISTS messages_fts_ad`,
    `DROP TRIGGER IF EXISTS messages_fts_au`,
    `DROP TABLE IF EXISTS messages_fts_config`,
    `DROP TABLE IF EXISTS messages_fts_docsize`,
    `DROP TABLE IF EXISTS messages_fts_content`,
    `DROP TABLE IF EXISTS messages_fts_idx`,
    `DROP TABLE IF EXISTS messages_fts_data`,
    `DROP TABLE IF EXISTS messages_fts`,
  ];
  for (const sql of statements) {
    try {
      raw.exec(sql);
    } catch {
      // Shadow table may itself be corrupt — ignore and continue
    }
  }
}

export function createMessagesFts(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      content
    )
  `);

  // Probe the FTS inverted index for corruption. A MATCH query exercises
  // the index structures (not just the content store), so it catches
  // corruption in shadow tables like _idx and _data. On empty tables
  // this returns null gracefully. O(1) with LIMIT 1.
  const raw = getSqliteFrom(database);
  try {
    raw
      .query(`SELECT * FROM messages_fts WHERE messages_fts MATCH 'a' LIMIT 1`)
      .get();
  } catch (err: unknown) {
    if (!isSqliteCorruptionError(err)) {
      throw err;
    }
    logger.warn(
      { err },
      "[messages-fts] Detected corrupt messages_fts virtual table — dropping and recreating",
    );
    // DROP TABLE on a corrupt vtable can itself throw, so drop the
    // FTS5 shadow tables directly to guarantee cleanup.
    dropFtsShadowTables(raw);
    database.run(/*sql*/ `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        content
      )
    `);
  }

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai
    AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content);
    END
  `);

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END
  `);

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS messages_fts_au
    AFTER UPDATE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
      INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content);
    END
  `);
}

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
 * we force-remove all shadow tables and the vtable entry (falling back
 * to `PRAGMA writable_schema` if DROP TABLE itself fails on the corrupt
 * vtable) and recreate it from scratch. The subsequent
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
 * Force-remove all FTS5 shadow tables, triggers, and the vtable entry.
 *
 * We drop each artifact individually so that a corrupt shadow table
 * doesn't block cleanup of the others. If `DROP TABLE messages_fts`
 * itself fails (FTS5's xDestroy hits a corrupt shadow table), we fall
 * back to `PRAGMA writable_schema` to delete the vtable entry directly
 * from `sqlite_schema`. Without this fallback, `CREATE VIRTUAL TABLE
 * IF NOT EXISTS` would be a no-op and the crash loop would persist.
 */
function dropFtsShadowTables(raw: ReturnType<typeof getSqliteFrom>): void {
  const drops = [
    `DROP TRIGGER IF EXISTS messages_fts_ai`,
    `DROP TRIGGER IF EXISTS messages_fts_ad`,
    `DROP TRIGGER IF EXISTS messages_fts_au`,
    `DROP TABLE IF EXISTS messages_fts_config`,
    `DROP TABLE IF EXISTS messages_fts_docsize`,
    `DROP TABLE IF EXISTS messages_fts_content`,
    `DROP TABLE IF EXISTS messages_fts_idx`,
    `DROP TABLE IF EXISTS messages_fts_data`,
  ];
  for (const sql of drops) {
    try {
      raw.exec(sql);
    } catch {
      // Shadow table may itself be corrupt — ignore and continue
    }
  }

  // Try the normal DROP TABLE path first (lets FTS5 clean up properly).
  try {
    raw.exec(`DROP TABLE IF EXISTS messages_fts`);
  } catch {
    // FTS5's xDestroy failed — force-remove the vtable entry from
    // sqlite_schema so CREATE VIRTUAL TABLE isn't a no-op.
    logger.warn(
      "[messages-fts] DROP TABLE messages_fts failed — removing vtable entry via writable_schema",
    );
    raw.exec(`PRAGMA writable_schema = ON`);
    try {
      raw.exec(
        `DELETE FROM sqlite_schema WHERE type = 'table' AND name = 'messages_fts'`,
      );
    } catch (schemaErr) {
      logger.error(
        { err: schemaErr },
        "[messages-fts] Failed to remove vtable entry from sqlite_schema",
      );
      throw schemaErr;
    } finally {
      raw.exec(`PRAGMA writable_schema = OFF`);
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
      CREATE VIRTUAL TABLE messages_fts USING fts5(
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

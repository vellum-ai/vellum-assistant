import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Rebuild `conversations` to drop the NOT NULL constraint on
 * `total_input_tokens` (the DEFAULT 0 is kept). Writers may now persist NULL
 * for an unknown input-token total; readers coalesce NULL to 0 at the row
 * mapper (`parseConversation`).
 *
 * SQLite cannot drop NOT NULL in place, so this is the standard rebuild:
 * create the new table from the live DDL with the constraint removed, copy
 * rows, drop, rename, and recreate the table's indexes. Deriving the new DDL
 * from `sqlite_master` (rather than a hand-written CREATE TABLE) keeps the
 * rebuild correct regardless of which column-adding migrations ran before it.
 *
 * Idempotent: a no-op once the constraint is gone.
 */
export function migrateConversationsTotalInputTokensNullable(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const ddl = raw
    .query(
      /*sql*/ `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'`,
    )
    .get() as { sql: string } | null;
  if (!ddl) {
    return;
  }

  const notNullPattern = /(total_input_tokens\s+INTEGER)\s+NOT\s+NULL/i;
  if (!notNullPattern.test(ddl.sql)) {
    return;
  }

  const headerPattern = /^CREATE TABLE\s+["'`[]?conversations["'`\]]?/i;
  if (!headerPattern.test(ddl.sql)) {
    throw new Error(
      "migration 348: unrecognized conversations DDL header; refusing to rebuild",
    );
  }
  const newDdl = ddl.sql
    .replace(notNullPattern, "$1")
    .replace(headerPattern, "CREATE TABLE conversations_new");

  // Indexes/triggers die with DROP TABLE; capture their DDL to recreate them.
  // Autoindexes (sql IS NULL) are rebuilt implicitly from table constraints.
  const dependentDdls = raw
    .query(
      /*sql*/ `SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = 'conversations' AND sql IS NOT NULL`,
    )
    .all() as Array<{ sql: string }>;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");
    raw.exec(newDdl);
    raw.exec(
      /*sql*/ `INSERT INTO conversations_new SELECT * FROM conversations`,
    );
    raw.exec(/*sql*/ `DROP TABLE conversations`);
    raw.exec(/*sql*/ `ALTER TABLE conversations_new RENAME TO conversations`);
    for (const { sql } of dependentDdls) {
      raw.exec(sql);
    }
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

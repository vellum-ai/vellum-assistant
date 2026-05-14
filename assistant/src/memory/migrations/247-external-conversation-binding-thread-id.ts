import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Add a provider thread anchor to external conversation bindings.
 *
 * Slack conversations are keyed by `(channel_id, thread_ts)`, while legacy
 * channels still use only `(source_channel, external_chat_id)`. SQLite treats
 * NULLs as distinct in unique indexes, so use two partial unique indexes:
 * one for legacy/no-thread bindings and one for threaded bindings.
 */
export function migrateExternalConversationBindingThreadId(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_conversation_bindings'`,
    )
    .get();
  if (!tableExists) return;

  const columns = raw
    .query(`PRAGMA table_info(external_conversation_bindings)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "external_thread_id")) {
    raw.exec(
      `ALTER TABLE external_conversation_bindings ADD COLUMN external_thread_id TEXT`,
    );
  }

  try {
    raw.exec("BEGIN");

    raw.exec(`DROP INDEX IF EXISTS idx_ext_conv_bindings_channel_chat_unique`);

    raw.exec(/*sql*/ `
      DELETE FROM external_conversation_bindings
      WHERE rowid NOT IN (
        SELECT rowid FROM (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY source_channel, external_chat_id, COALESCE(external_thread_id, '')
                   ORDER BY updated_at DESC, created_at DESC, rowid DESC
                 ) AS rn
          FROM external_conversation_bindings
        )
        WHERE rn = 1
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat_thread
      ON external_conversation_bindings(source_channel, external_chat_id, external_thread_id)
    `);

    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat_no_thread_unique
      ON external_conversation_bindings(source_channel, external_chat_id)
      WHERE external_thread_id IS NULL
    `);

    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat_thread_unique
      ON external_conversation_bindings(source_channel, external_chat_id, external_thread_id)
      WHERE external_thread_id IS NOT NULL
    `);

    raw.exec("COMMIT");
  } catch (err) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw err;
  }
}

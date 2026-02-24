import { getSqliteFrom, type DrizzleDb } from '../db-connection.js';

/**
 * One-shot migration: deduplicate external_conversation_bindings rows that
 * share the same (source_channel, external_chat_id), then create a unique
 * index to enforce the invariant at DB level.
 *
 * For each duplicate group, the binding with the newest updatedAt (then
 * createdAt) is kept; older duplicates are deleted.
 */
export function migrateExtConvBindingsChannelChatUnique(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // If the unique index already exists, nothing to do.
  const idxExists = raw.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_ext_conv_bindings_channel_chat_unique'`,
  ).get();
  if (idxExists) return;

  // Check if the table exists (first boot edge case).
  const tableExists = raw.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_conversation_bindings'`,
  ).get();
  if (!tableExists) return;

  // Remove duplicates: keep the row with the newest updatedAt, then createdAt.
  // Since conversation_id is the PK (rowid alias), we use it for ordering ties.
  try {
    raw.exec('BEGIN');

    raw.exec(/*sql*/ `
      DELETE FROM external_conversation_bindings
      WHERE rowid NOT IN (
        SELECT rowid FROM (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY source_channel, external_chat_id
                   ORDER BY updated_at DESC, created_at DESC, rowid DESC
                 ) AS rn
          FROM external_conversation_bindings
        )
        WHERE rn = 1
      )
    `);

    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat_unique
      ON external_conversation_bindings(source_channel, external_chat_id)
    `);

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

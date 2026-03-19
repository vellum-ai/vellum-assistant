import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Create the memory archive tables (memory_observations, memory_chunks,
 * memory_episodes) with prefetch indexes on scopeId, conversationId, and
 * createdAt.
 *
 * All statements use IF NOT EXISTS / IF NOT EXISTS guards so the migration
 * is safe to re-run on every startup.
 */
export function migrateMemoryArchiveTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // -- memory_observations --------------------------------------------------
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_observations (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT 'default',
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      modality TEXT NOT NULL DEFAULT 'text',
      source TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_observations_scope_id
    ON memory_observations (scope_id)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_observations_conversation_id
    ON memory_observations (conversation_id)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_observations_created_at
    ON memory_observations (created_at)
  `);

  // -- memory_chunks --------------------------------------------------------
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT 'default',
      observation_id TEXT NOT NULL REFERENCES memory_observations(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_scope_id
    ON memory_chunks (scope_id)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_observation_id
    ON memory_chunks (observation_id)
  `);

  raw.exec(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_chunks_content_hash
    ON memory_chunks (scope_id, content_hash)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_created_at
    ON memory_chunks (created_at)
  `);

  // -- memory_episodes ------------------------------------------------------
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_episodes (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT 'default',
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      source TEXT,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_scope_id
    ON memory_episodes (scope_id)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_conversation_id
    ON memory_episodes (conversation_id)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_created_at
    ON memory_episodes (created_at)
  `);
}

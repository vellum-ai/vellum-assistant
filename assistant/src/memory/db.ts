import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';
import { getDbPath, ensureDataDir } from '../util/platform.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    ensureDataDir();
    const sqlite = new Database(getDbPath());
    sqlite.exec('PRAGMA journal_mode=WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    db = drizzle(sqlite, { schema });
  }
  return db;
}

export function initializeDb(): void {
  const database = getDb();

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      decision TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Migrations — ALTER TABLE ADD COLUMN throws if column already exists
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN total_estimated_cost REAL NOT NULL DEFAULT 0`); } catch { /* already exists */ }

  migrateToolInvocationsFk(database);

  // Indexes for query performance on large datasets
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_tool_invocations_conversation_id ON tool_invocations(conversation_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)`);
}

/**
 * Migrate existing tool_invocations table to add FK constraint with ON DELETE CASCADE.
 * SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so we rebuild the table.
 * This is idempotent: it checks whether the FK already exists before migrating.
 */
function migrateToolInvocationsFk(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const row = raw.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_invocations'`).get() as { sql: string } | null;
  if (!row) return; // table doesn't exist yet (will be created above)

  // If the DDL already contains REFERENCES, the FK is in place
  if (row.sql.includes('REFERENCES')) return;

  raw.exec(/*sql*/ `
    CREATE TABLE tool_invocations_new (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      decision TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO tool_invocations_new SELECT * FROM tool_invocations;
    DROP TABLE tool_invocations;
    ALTER TABLE tool_invocations_new RENAME TO tool_invocations;
  `);
}

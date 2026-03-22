import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Rebuild memory_embeddings to make vector_json nullable.
 *
 * Pre-migration-100 databases created the table with `vector_json TEXT NOT NULL`.
 * Migration 024 switched new writes to vector_blob only (setting vector_json = null),
 * but never relaxed the NOT NULL constraint — causing SQLITE_CONSTRAINT_NOTNULL on
 * every new embedding insert.
 *
 * This migration rebuilds the table only when the constraint is still present.
 */
export function migrateEmbeddingsNullableVectorJson(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_embeddings_nullable_vector_json_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // Check if vector_json has a NOT NULL constraint
  const ddl = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'`,
    )
    .get() as { sql: string } | null;
  if (!ddl) {
    // Table doesn't exist yet — nothing to fix; core-tables will create it correctly.
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    return;
  }

  // Only rebuild if vector_json is declared NOT NULL in the actual DDL
  if (!isColumnNotNull(ddl.sql, "vector_json")) {
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    return;
  }

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      CREATE TABLE memory_embeddings_new (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT,
        vector_blob BLOB,
        content_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (target_type, target_id, provider, model)
      )
    `);
    raw.exec(/*sql*/ `
      INSERT OR IGNORE INTO memory_embeddings_new (
        id, target_type, target_id, provider, model, dimensions,
        vector_json, vector_blob, content_hash, created_at, updated_at
      )
      SELECT
        id, target_type, target_id, provider, model, dimensions,
        vector_json, vector_blob, content_hash, created_at, updated_at
      FROM memory_embeddings
      ORDER BY updated_at DESC
    `);
    raw.exec(/*sql*/ `DROP TABLE memory_embeddings`);
    raw.exec(
      /*sql*/ `ALTER TABLE memory_embeddings_new RENAME TO memory_embeddings`,
    );

    // Recreate the content_hash index destroyed by the DROP TABLE (the UNIQUE
    // constraint autoindex covers target_type+target_id+provider+model already)
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_content_hash ON memory_embeddings(content_hash, provider, model)`,
    );

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
 * Reverse v13: rebuild memory_embeddings with NOT NULL on vector_json.
 *
 * WARNING: Any rows with NULL vector_json will be lost — they cannot satisfy
 * the NOT NULL constraint. This is acceptable because the forward migration
 * only relaxed the constraint; rows written after the forward migration may
 * have NULL vector_json (relying on vector_blob instead).
 */
export function downEmbeddingsNullableVectorJson(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'`,
    )
    .get();
  if (!tableExists) return;

  // Check if vector_json already has NOT NULL — already rolled back
  const ddl = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'`,
    )
    .get() as { sql: string } | null;
  if (ddl && isColumnNotNull(ddl.sql, "vector_json")) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(/*sql*/ `
      CREATE TABLE memory_embeddings_new (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        vector_blob BLOB,
        content_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (target_type, target_id, provider, model)
      )
    `);
    // Only copy rows where vector_json is NOT NULL — rows with NULL cannot
    // satisfy the restored constraint and are lost.
    raw.exec(/*sql*/ `
      INSERT OR IGNORE INTO memory_embeddings_new (
        id, target_type, target_id, provider, model, dimensions,
        vector_json, vector_blob, content_hash, created_at, updated_at
      )
      SELECT
        id, target_type, target_id, provider, model, dimensions,
        vector_json, vector_blob, content_hash, created_at, updated_at
      FROM memory_embeddings
      WHERE vector_json IS NOT NULL
      ORDER BY updated_at DESC
    `);
    raw.exec(/*sql*/ `DROP TABLE memory_embeddings`);
    raw.exec(
      /*sql*/ `ALTER TABLE memory_embeddings_new RENAME TO memory_embeddings`,
    );

    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_content_hash ON memory_embeddings(content_hash, provider, model)`,
    );
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}

/** Check whether a column is declared NOT NULL in a CREATE TABLE DDL string. */
function isColumnNotNull(ddl: string, column: string): boolean {
  const pattern = new RegExp(`${column}\\s+\\w+.*?NOT\\s+NULL`, "i");
  return pattern.test(ddl);
}

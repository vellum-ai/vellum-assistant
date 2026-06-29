import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Add vector_blob BLOB column to memory_embeddings and backfill from vector_json.
 *
 * Existing rows store embedding vectors as JSON text (~4x larger than binary).
 * This migration adds a vector_blob column (Float32Array BLOB) and converts
 * all existing vector_json values into the compact binary format.
 *
 * After migration, new writes go to vector_blob only.
 * Reads prefer vector_blob and fall back to vector_json for safety.
 */
export function migrateEmbeddingVectorBlob(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_embedding_vector_blob_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // Add the column if it doesn't exist yet
  try {
    raw.exec(
      /*sql*/ `ALTER TABLE memory_embeddings ADD COLUMN vector_blob BLOB`,
    );
  } catch {
    /* already exists */
  }

  // Backfill: convert each JSON vector to a Float32Array BLOB
  const rows = raw
    .query(
      `SELECT id, vector_json FROM memory_embeddings WHERE vector_blob IS NULL AND vector_json IS NOT NULL`,
    )
    .all() as Array<{ id: string; vector_json: string }>;

  if (rows.length > 0) {
    const update = raw.prepare(
      `UPDATE memory_embeddings SET vector_blob = ? WHERE id = ?`,
    );
    raw.exec("BEGIN");
    try {
      for (const row of rows) {
        const parsed = JSON.parse(row.vector_json) as number[];
        const f32 = new Float32Array(parsed);
        const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
        update.run(buf, row.id);
      }

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
    }
  } else {
    // No rows to backfill, just record the checkpoint
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
  }
}

/**
 * Drop the vector_blob column from memory_embeddings.
 *
 * NOTE: Binary embedding data stored in vector_blob is lost on rollback.
 * Rows that still have vector_json will continue to work; rows that only
 * had vector_blob will lose their embedding vectors.
 *
 * SQLite does not support DROP COLUMN on all versions, so we rebuild the table.
 */
export function downEmbeddingVectorBlob(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Check if vector_blob column exists
  const hasColumn = raw
    .query(
      `SELECT 1 FROM pragma_table_info('memory_embeddings') WHERE name = 'vector_blob'`,
    )
    .get();
  if (!hasColumn) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    // Get the current columns minus vector_blob
    const columns = raw
      .query(`SELECT name FROM pragma_table_info('memory_embeddings')`)
      .all() as Array<{ name: string }>;
    const keepColumns = columns
      .map((c) => c.name)
      .filter((n) => n !== "vector_blob");

    // Get the current DDL to understand the table structure
    const ddl = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'`,
      )
      .get() as { sql: string } | null;
    if (!ddl) {
      raw.exec("ROLLBACK");
      return;
    }

    // Remove the vector_blob column definition from the DDL
    const newDdl = ddl.sql
      .replace(/,\s*vector_blob\s+BLOB/i, "")
      .replace("memory_embeddings", "memory_embeddings_new");

    raw.exec(newDdl);

    const colList = keepColumns.join(", ");
    raw.exec(/*sql*/ `
      INSERT INTO memory_embeddings_new (${colList})
      SELECT ${colList} FROM memory_embeddings
    `);

    raw.exec(/*sql*/ `DROP TABLE memory_embeddings`);
    raw.exec(
      /*sql*/ `ALTER TABLE memory_embeddings_new RENAME TO memory_embeddings`,
    );

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

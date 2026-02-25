import { getSqliteFrom, type DrizzleDb } from '../db-connection.js';

/**
 * Add vector_blob BLOB column to memory_embeddings and backfill from vector_json.
 *
 * Existing rows store embedding vectors as JSON text (~4x larger than binary).
 * This migration adds a vector_blob column (Float32Array BLOB) and converts
 * all existing vector_json values into the compact binary format.
 *
 * After migration, new writes go to vector_blob only (vector_json is set to NULL).
 * Reads prefer vector_blob and fall back to vector_json for safety.
 */
export function migrateEmbeddingVectorBlob(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'migration_embedding_vector_blob_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  // Add the column if it doesn't exist yet
  try { raw.exec(/*sql*/ `ALTER TABLE memory_embeddings ADD COLUMN vector_blob BLOB`); } catch { /* already exists */ }

  // Backfill: convert each JSON vector to a Float32Array BLOB
  const rows = raw.query(
    `SELECT id, vector_json FROM memory_embeddings WHERE vector_blob IS NULL AND vector_json IS NOT NULL`,
  ).all() as Array<{ id: string; vector_json: string }>;

  if (rows.length > 0) {
    const update = raw.prepare(
      `UPDATE memory_embeddings SET vector_blob = ?, vector_json = NULL WHERE id = ?`,
    );
    raw.exec('BEGIN');
    try {
      for (const row of rows) {
        const parsed = JSON.parse(row.vector_json) as number[];
        const f32 = new Float32Array(parsed);
        const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
        update.run(buf, row.id);
      }

      raw.query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      ).run(checkpointKey, Date.now());

      raw.exec('COMMIT');
    } catch (e) {
      try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw e;
    }
  } else {
    // No rows to backfill, just record the checkpoint
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());
  }
}

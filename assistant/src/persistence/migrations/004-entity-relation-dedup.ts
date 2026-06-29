import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot migration: merge duplicate relation edges so uniqueness can be
 * enforced on (source_entity_id, target_entity_id, relation).
 */
export function migrateMemoryEntityRelationDedup(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_memory_entity_relations_dedup_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // Drop the staging temp table if it was left behind by a previous failed
  // attempt in the same connection.  TEMP tables survive ROLLBACK (they live
  // in a separate SQLite schema) so a mid-migration exception can leave the
  // table present even after the transaction rolls back.  Clearing it here
  // makes re-entry safe without needing IF NOT EXISTS semantics on the full
  // CREATE ... AS SELECT.
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS temp.memory_entity_relation_merge`);

  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      CREATE TEMP TABLE memory_entity_relation_merge AS
      WITH ranked AS (
        SELECT
          source_entity_id,
          target_entity_id,
          relation,
          first_seen_at,
          last_seen_at,
          evidence,
          ROW_NUMBER() OVER (
            PARTITION BY source_entity_id, target_entity_id, relation
            ORDER BY last_seen_at DESC, first_seen_at DESC, id DESC
          ) AS rank_latest
        FROM memory_entity_relations
      )
      SELECT
        source_entity_id,
        target_entity_id,
        relation,
        MIN(first_seen_at) AS merged_first_seen_at,
        MAX(last_seen_at) AS merged_last_seen_at,
        MAX(CASE WHEN rank_latest = 1 THEN evidence ELSE NULL END) AS merged_evidence
      FROM ranked
      GROUP BY source_entity_id, target_entity_id, relation
    `);

    raw.exec(/*sql*/ `DELETE FROM memory_entity_relations`);

    raw.exec(/*sql*/ `
      INSERT INTO memory_entity_relations (
        id,
        source_entity_id,
        target_entity_id,
        relation,
        evidence,
        first_seen_at,
        last_seen_at
      )
      SELECT
        lower(hex(randomblob(16))),
        source_entity_id,
        target_entity_id,
        relation,
        merged_evidence,
        merged_first_seen_at,
        merged_last_seen_at
      FROM memory_entity_relation_merge
    `);

    raw.exec(/*sql*/ `DROP TABLE temp.memory_entity_relation_merge`);

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
}

/**
 * No-op down: deduplication is a lossy operation — deleted duplicate rows
 * cannot be restored. The forward migration merged rows by keeping the most
 * recent evidence per (source, target, relation) triple; the discarded rows
 * are permanently lost.
 */
export function downMemoryEntityRelationDedup(_database: DrizzleDb): void {
  // Intentionally empty — irreversible lossy migration.
}

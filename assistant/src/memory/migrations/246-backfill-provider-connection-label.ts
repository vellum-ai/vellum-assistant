import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot backfill: set `label = name` for any `provider_connections` row
 * whose `label` is NULL (or empty after trim). Migration 244 added the
 * `label` column as nullable with no default, so every row that existed
 * pre-244 (and any row created against an older client that didn't yet
 * write a label) ended up with NULL.
 *
 * Why this matters for users: in 0.8.x the editor modal renders Display
 * Name from `label` and shows the empty-state placeholder ("e.g. My
 * OpenAI") whenever it's null. Users who created connections before the
 * label field existed open the editor and see what looks like an empty
 * field, then conclude their data was wiped during the upgrade.
 *
 * The fix is to give every pre-feature row a sensible default — its own
 * connection name. The list view already falls back to `name` when label
 * is empty (see ProvidersSheet.swift `connectionRow`), so this brings the
 * editor into agreement with what's already on screen.
 *
 * Idempotency: guarded by `memory_checkpoints` so a second boot won't
 * re-clobber a label the user has intentionally cleared after the
 * backfill ran. New rows created post-backfill follow the normal
 * label-is-optional contract.
 */
export function migrateBackfillProviderConnectionLabel(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "backfill_provider_connection_label";

  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // Guard: skip if the table doesn't exist yet (first-boot edge case where
  // migration 243 hasn't run, e.g. fresh install ordering test harness).
  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'`,
    )
    .get();
  if (!tableExists) {
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    return;
  }

  // Guard: also skip if the label column hasn't been added yet (migration
  // 244 hasn't run). Treat as no-op + don't checkpoint, so the backfill
  // runs the next time it gets a chance against a populated schema.
  const columns = raw
    .query(`PRAGMA table_info(provider_connections)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "label")) {
    return;
  }

  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      UPDATE provider_connections
      SET label = name
      WHERE label IS NULL OR TRIM(label) = ''
    `);

    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());

    raw.exec("COMMIT");
  } catch (err) {
    raw.exec("ROLLBACK");
    throw err;
  }
}

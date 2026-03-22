import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v18: set contacts.last_interaction back to NULL.
 *
 * The forward migration backfilled last_interaction from channel data.
 * Rolling back simply clears the column — the data can be re-derived by
 * re-running the forward migration.
 */
export function downBackfillContactInteractionStats(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const colExists = raw
    .query(
      `SELECT 1 FROM pragma_table_info('contacts') WHERE name = 'last_interaction'`,
    )
    .get();
  if (!colExists) return;

  raw.exec(/*sql*/ `UPDATE contacts SET last_interaction = NULL`);
}

/**
 * Backfill contacts.last_interaction from the max lastSeenAt across each
 * contact's channels. interactionCount cannot be reliably derived from
 * existing data, so it stays at 0 and accumulates going forward.
 */
export function migrateBackfillContactInteractionStats(db: DrizzleDb): void {
  const raw = getSqliteFrom(db);
  const colExists = raw
    .query(
      `SELECT 1 FROM pragma_table_info('contacts') WHERE name = 'last_interaction'`,
    )
    .get();
  if (!colExists) return;

  withCrashRecovery(db, "backfill_contact_interaction_stats", () => {
    db.run(/*sql*/ `
      UPDATE contacts
      SET last_interaction = (
        SELECT MAX(last_seen_at)
        FROM contact_channels
        WHERE contact_id = contacts.id
          AND last_seen_at IS NOT NULL
      ),
      updated_at = CASE
        WHEN (SELECT MAX(last_seen_at) FROM contact_channels WHERE contact_id = contacts.id AND last_seen_at IS NOT NULL) IS NOT NULL
        THEN (SELECT MAX(last_seen_at) FROM contact_channels WHERE contact_id = contacts.id AND last_seen_at IS NOT NULL)
        ELSE updated_at
      END
      WHERE last_interaction IS NULL
        AND EXISTS (
          SELECT 1 FROM contact_channels
          WHERE contact_id = contacts.id AND last_seen_at IS NOT NULL
        )
    `);
  });
}

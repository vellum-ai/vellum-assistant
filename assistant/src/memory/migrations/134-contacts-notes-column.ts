import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v17: no-op — the original separate columns (relationship, importance,
 * response_expectation, preferred_tone) cannot be reliably restored from the
 * consolidated notes TEXT column.
 *
 * The forward migration concatenated multiple typed fields into a single
 * free-text notes field and then dropped the original columns. Parsing the
 * notes back into structured fields would be lossy and error-prone.
 */
export function downContactsNotesColumn(_database: DrizzleDb): void {
  // Lossy — original structured columns cannot be restored from notes text.
}

const log = getLogger("migration-134");

export function migrateContactsNotesColumn(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_contacts_notes_column_v1", () => {
    const raw = getSqliteFrom(database);

    try {
      raw.exec(/*sql*/ `ALTER TABLE contacts ADD COLUMN notes TEXT`);
    } catch {
      /* already exists */
    }

    // Check which legacy columns still exist — handles partial completion
    // if a previous run crashed after dropping some columns but not all.
    const cols = new Set(
      (
        raw.query(`PRAGMA table_info(contacts)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );

    const legacyCols = [
      "relationship",
      "importance",
      "response_expectation",
      "preferred_tone",
    ] as const;
    const remaining = legacyCols.filter((c) => cols.has(c));

    // Backfill notes from legacy columns if any are still present and notes
    // haven't been populated yet (only run once, before any columns are dropped).
    if (remaining.length === legacyCols.length) {
      const rows = raw
        .query(
          `SELECT id, relationship, importance, response_expectation, preferred_tone
       FROM contacts
       WHERE relationship IS NOT NULL
          OR importance != 0.5
          OR response_expectation IS NOT NULL
          OR preferred_tone IS NOT NULL`,
        )
        .all() as Array<{
        id: string;
        relationship: string | null;
        importance: number;
        response_expectation: string | null;
        preferred_tone: string | null;
      }>;

      const update = raw.prepare(`UPDATE contacts SET notes = ? WHERE id = ?`);

      for (const row of rows) {
        const parts: string[] = [];
        if (row.relationship) parts.push(`Relationship: ${row.relationship}`);
        if (row.importance !== 0.5) parts.push(`Importance: ${row.importance}`);
        if (row.response_expectation)
          parts.push(`Response expectation: ${row.response_expectation}`);
        if (row.preferred_tone)
          parts.push(`Preferred tone: ${row.preferred_tone}`);
        if (parts.length > 0) {
          update.run(parts.join("\n"), row.id);
        }
      }

      const migrated = rows.length;
      if (migrated > 0) {
        log.info({ migrated }, "Migrated contact metadata to notes field");
      }
    }

    // Drop indexes that reference columns we're about to remove.
    // Must happen before the column drops — SQLite rejects dropping a column
    // that is still referenced by an index.
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_contacts_importance`);

    // Drop each legacy column individually so partial completion is safe:
    // on crash recovery the loop picks up only the columns that remain.
    for (const col of remaining) {
      raw.exec(/*sql*/ `ALTER TABLE contacts DROP COLUMN ${col}`);
    }
  });
}

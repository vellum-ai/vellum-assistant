import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-134");

export function migrateContactsNotesColumn(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(/*sql*/ `ALTER TABLE contacts ADD COLUMN notes TEXT`);

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
    if (row.preferred_tone) parts.push(`Preferred tone: ${row.preferred_tone}`);
    if (parts.length > 0) {
      update.run(parts.join("\n"), row.id);
    }
  }

  const migrated = rows.length;
  if (migrated > 0) {
    log.info({ migrated }, "Migrated contact metadata to notes field");
  }

  raw.exec(/*sql*/ `ALTER TABLE contacts DROP COLUMN relationship`);
  raw.exec(/*sql*/ `ALTER TABLE contacts DROP COLUMN importance`);
  raw.exec(/*sql*/ `ALTER TABLE contacts DROP COLUMN response_expectation`);
  raw.exec(/*sql*/ `ALTER TABLE contacts DROP COLUMN preferred_tone`);
}

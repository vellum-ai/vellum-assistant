/**
 * Add assistant_id column to contacts table so guardian bindings
 * can be scoped per assistant.
 */

import type { DrizzleDb } from "../db-connection.js";

export function migrateContactsAssistantId(database: DrizzleDb): void {
  try {
    database.run(/*sql*/ `ALTER TABLE contacts ADD COLUMN assistant_id TEXT`);
  } catch {
    /* already exists */
  }

  // Backfill existing guardian contacts so they remain discoverable via
  // queries that filter on assistant_id = 'self'.  Without this, NULL = 'self'
  // evaluates to false in SQL and existing guardian bindings silently break.
  database.run(
    /*sql*/ `UPDATE contacts SET assistant_id = 'self' WHERE role = 'guardian' AND assistant_id IS NULL`,
  );
}

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
}

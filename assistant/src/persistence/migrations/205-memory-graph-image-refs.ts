import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateMemoryGraphImageRefs(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE memory_graph_nodes ADD COLUMN image_refs TEXT`);
  } catch {
    // Column already exists — idempotent
  }
}

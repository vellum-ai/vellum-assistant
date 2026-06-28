import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateCreateMemoryGraphNodeEdits(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS memory_graph_node_edits (
      id                TEXT PRIMARY KEY,
      node_id           TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      previous_content  TEXT NOT NULL,
      new_content       TEXT NOT NULL,
      source            TEXT NOT NULL,
      conversation_id   TEXT,
      created           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_graph_node_edits_node_id ON memory_graph_node_edits(node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_node_edits_created ON memory_graph_node_edits(created);
  `);
}

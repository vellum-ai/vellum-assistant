import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Create the memory graph tables: nodes, edges, and triggers.
 *
 * Uses CREATE TABLE IF NOT EXISTS so this is inherently idempotent
 * and does not need a registry entry.
 */
export function migrateCreateMemoryGraphTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // -- Nodes --
  raw.exec(`
    CREATE TABLE IF NOT EXISTS memory_graph_nodes (
      id                    TEXT PRIMARY KEY,
      content               TEXT NOT NULL,
      type                  TEXT NOT NULL,
      created               INTEGER NOT NULL,
      last_accessed         INTEGER NOT NULL,
      last_consolidated     INTEGER NOT NULL,
      emotional_charge      TEXT NOT NULL,
      fidelity              TEXT NOT NULL DEFAULT 'vivid',
      confidence            REAL NOT NULL,
      significance          REAL NOT NULL,
      stability             REAL NOT NULL DEFAULT 14,
      reinforcement_count   INTEGER NOT NULL DEFAULT 0,
      last_reinforced       INTEGER NOT NULL,
      source_conversations  TEXT NOT NULL DEFAULT '[]',
      source_type           TEXT NOT NULL DEFAULT 'inferred',
      narrative_role        TEXT,
      part_of_story         TEXT,
      scope_id              TEXT NOT NULL DEFAULT 'default'
    )
  `);

  // -- Edges --
  raw.exec(`
    CREATE TABLE IF NOT EXISTS memory_graph_edges (
      id              TEXT PRIMARY KEY,
      source_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      target_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      relationship    TEXT NOT NULL,
      weight          REAL NOT NULL DEFAULT 1.0,
      created         INTEGER NOT NULL
    )
  `);

  // -- Triggers --
  raw.exec(`
    CREATE TABLE IF NOT EXISTS memory_graph_triggers (
      id                   TEXT PRIMARY KEY,
      node_id              TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      type                 TEXT NOT NULL,
      schedule             TEXT,
      condition            TEXT,
      condition_embedding  BLOB,
      threshold            REAL,
      event_date           INTEGER,
      ramp_days            INTEGER,
      follow_up_days       INTEGER,
      recurring            INTEGER NOT NULL DEFAULT 0,
      consumed             INTEGER NOT NULL DEFAULT 0,
      cooldown_ms          INTEGER,
      last_fired           INTEGER
    )
  `);

  // -- Indexes (IF NOT EXISTS for idempotency) --
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_nodes_scope_id ON memory_graph_nodes(scope_id)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON memory_graph_nodes(type)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_nodes_fidelity ON memory_graph_nodes(fidelity)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_nodes_created ON memory_graph_nodes(created)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_nodes_significance ON memory_graph_nodes(significance)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON memory_graph_edges(source_node_id)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON memory_graph_edges(target_node_id)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_triggers_node_id ON memory_graph_triggers(node_id)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_graph_triggers_type ON memory_graph_triggers(type)`,
  );
}

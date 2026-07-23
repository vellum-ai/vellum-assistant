import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain the memory graph cluster from `main` into the memory DB.
 *
 * The four tables form one FK cluster — `memory_graph_edges`,
 * `memory_graph_triggers`, and `memory_graph_node_edits` each
 * `REFERENCES memory_graph_nodes(id) ON DELETE CASCADE` — so they move together
 * and the cascade is preserved by recreating it on the memory connection (see
 * {@link ensureMemoryGraphSchema}). Nodes drain first so the finished memory-side
 * tables are FK-consistent for live writes.
 *
 * Column lists are explicit (never `SELECT *`) so the copy is insensitive to the
 * physical column order left by the `ALTER TABLE … ADD COLUMN` history. The node
 * list carries the base `CREATE` columns (migration 202) plus `scope_id`
 * (also from 202), `event_date` (added by 202's own ALTER), and `image_refs`
 * (migration 205).
 */
export const MEMORY_GRAPH_NODES_RELOCATION: RelocationSpec = {
  table: "memory_graph_nodes",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "content",
    "type",
    "created",
    "last_accessed",
    "last_consolidated",
    "emotional_charge",
    "fidelity",
    "confidence",
    "significance",
    "stability",
    "reinforcement_count",
    "last_reinforced",
    "source_conversations",
    "source_type",
    "narrative_role",
    "part_of_story",
    "scope_id",
    "event_date",
    "image_refs",
  ],
};

export const MEMORY_GRAPH_EDGES_RELOCATION: RelocationSpec = {
  table: "memory_graph_edges",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "source_node_id",
    "target_node_id",
    "relationship",
    "weight",
    "created",
  ],
};

export const MEMORY_GRAPH_TRIGGERS_RELOCATION: RelocationSpec = {
  table: "memory_graph_triggers",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "node_id",
    "type",
    "schedule",
    "condition",
    "condition_embedding",
    "threshold",
    "event_date",
    "ramp_days",
    "follow_up_days",
    "recurring",
    "consumed",
    "cooldown_ms",
    "last_fired",
  ],
};

export const MEMORY_GRAPH_NODE_EDITS_RELOCATION: RelocationSpec = {
  table: "memory_graph_node_edits",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "node_id",
    "previous_content",
    "new_content",
    "source",
    "conversation_id",
    "created",
  ],
};

/**
 * Create the four memory graph tables on the memory connection. Idempotent
 * (`IF NOT EXISTS`) — the dedicated connection performs no DDL on open, so this
 * migration owns the schema.
 *
 * The intra-cluster `REFERENCES memory_graph_nodes(id) ON DELETE CASCADE`
 * clauses are recreated here: all four tables live in the same file, so the
 * cascade keeps working on the memory connection exactly as it did on main.
 * Nodes are created first so those references resolve at creation time.
 */
export function ensureMemoryGraphSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
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
      scope_id              TEXT NOT NULL DEFAULT 'default',
      event_date            INTEGER,
      image_refs            TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_graph_edges (
      id              TEXT PRIMARY KEY,
      source_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      target_node_id  TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      relationship    TEXT NOT NULL,
      weight          REAL NOT NULL DEFAULT 1.0,
      created         INTEGER NOT NULL
    );

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
    );

    CREATE TABLE IF NOT EXISTS memory_graph_node_edits (
      id                TEXT PRIMARY KEY,
      node_id           TEXT NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
      previous_content  TEXT NOT NULL,
      new_content       TEXT NOT NULL,
      source            TEXT NOT NULL,
      conversation_id   TEXT,
      created           INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_graph_nodes_scope_id ON memory_graph_nodes(scope_id);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON memory_graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_fidelity ON memory_graph_nodes(fidelity);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_created ON memory_graph_nodes(created);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_significance ON memory_graph_nodes(significance);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_event_date ON memory_graph_nodes(event_date);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON memory_graph_edges(source_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON memory_graph_edges(target_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_triggers_node_id ON memory_graph_triggers(node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_triggers_type ON memory_graph_triggers(type);
    CREATE INDEX IF NOT EXISTS idx_graph_node_edits_node_id ON memory_graph_node_edits(node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_node_edits_created ON memory_graph_node_edits(created);
  `);
}

/**
 * Move the memory graph cluster — nodes, edges, triggers, and node edits — into
 * the dedicated memory database (`assistant-memory.db`), so the graph hub store
 * and every consumer that reads these tables rides the memory connection.
 *
 * The four tables drain in FK-parent order (nodes first) into a schema that
 * preserves their intra-cluster `ON DELETE CASCADE`s. Registered with
 * `dependsOn` on every migration that reads or writes a graph table on main so
 * the move never outruns one where those rows are still expected on main —
 * including `migrateDeletePrivateConversations`, which deletes private-scoped
 * graph rows on main directly (not via a `conversations` cascade, of which the
 * graph has none). At runtime the graph stays out of the conversation-keyed
 * purge because it is scope-keyed, but that one-time cleanup migration must
 * still land before these rows leave main.
 */
export async function migrateMoveMemoryGraphTablesToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  // Nodes first (FK parent), then the three children, so an interrupted drain
  // never leaves a child row on the memory side without its node.
  await runMemoryTableRelocation(
    database,
    MEMORY_GRAPH_NODES_RELOCATION,
    ensureMemoryGraphSchema,
  );
  await runMemoryTableRelocation(
    database,
    MEMORY_GRAPH_EDGES_RELOCATION,
    ensureMemoryGraphSchema,
  );
  await runMemoryTableRelocation(
    database,
    MEMORY_GRAPH_TRIGGERS_RELOCATION,
    ensureMemoryGraphSchema,
  );
  await runMemoryTableRelocation(
    database,
    MEMORY_GRAPH_NODE_EDITS_RELOCATION,
    ensureMemoryGraphSchema,
  );
}

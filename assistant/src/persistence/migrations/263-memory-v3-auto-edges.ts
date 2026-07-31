import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Create the memory_v3_auto_edges table — the **learned** edge graph, a
 * distinct class from the curated `edges:` frontmatter graph.
 *
 * Each row is a weighted directed association `source_slug → target_slug` that
 * the edge-learning job (`memory_v3_edge_learning`) accrues from *used*
 * co-activations (migration 262's `memory_v3_coactivation` rows) and decays
 * over time. `weight` is a multiplicatively-decaying real; `last_reinforced_at`
 * is the wall-clock ms of the most recent reinforcement, used by the decay
 * pass to compute elapsed time per pair.
 *
 * Auto-edges are advisory: the read path consumes only above-threshold pairs
 * via edge-expansion's `extraAdjacency` seam, and high-weight pairs surface as
 * promotion *candidates* for the assistant to ratify into curated `edges:`
 * during consolidation. This table never auto-writes page frontmatter.
 *
 * `PRIMARY KEY(source_slug, target_slug)` makes each ordered pair unique, so
 * reinforce is a single UPSERT. The index on `(weight)` keeps the
 * above-threshold scan and top-N promotion-candidate read cheap as the learned
 * graph grows.
 */
export function migrateMemoryV3AutoEdges(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_auto_edges (
      source_slug TEXT NOT NULL,
      target_slug TEXT NOT NULL,
      weight REAL NOT NULL,
      last_reinforced_at INTEGER NOT NULL,
      PRIMARY KEY (source_slug, target_slug)
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_auto_edges_weight
      ON memory_v3_auto_edges (weight)
  `);
}

export function downMemoryV3AutoEdges(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_v3_auto_edges`);
}

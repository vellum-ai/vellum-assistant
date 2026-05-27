/**
 * Memory v3 — co-retrieval edge seeding.
 *
 * Warm-starts the learned association graph (`memory_v3_auto_edges`, migration
 * 263) from the v2 router's selection history. The live edge-learning job
 * (`edge-learning-job.ts`) only accrues edges from v3's own retrievals, which is
 * cold until v3 has run for a long time; the v2 router has thousands of turns of
 * co-selection data already. Seeding projects that history into the same table
 * the `aboveThreshold` read path already consumes, so the edge-expansion lane
 * can merge it (via `expandEdges`'s `extraAdjacency` seam) the moment it's wired.
 *
 * Signal: two pages that the router *selected together* on a turn are associated.
 * Scoring is **NPMI** (normalized pointwise mutual information), not raw
 * co-occurrence — NPMI discounts high-frequency pages, so an always-injected page
 * doesn't edge to everything it merely co-occurs with. A min co-occurrence floor
 * drops noise, and an "always-on" frequency ceiling drops pages selected on a
 * large fraction of all turns (heartbeat/now-md-style infrastructure) that carry
 * no associative signal.
 *
 * `buildCoretrievalGraph` is pure (no I/O) so it is unit-testable; the
 * `seedCoretrievalEdges` driver reads the rows and writes the table.
 */

import { getLogger } from "../../util/logger.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const log = getLogger("memory-v3-coretrieval-seed");

/** A pair must co-occur on at least this many turns to earn an edge. */
export const DEFAULT_MIN_COUNT = 5;
/**
 * A candidate *neighbor* selected on more than this fraction of all turns is
 * "always-on" infrastructure (co-occurs with everything) and is excluded — it
 * carries no associative signal, only base-rate noise.
 */
export const DEFAULT_MAX_NEIGHBOR_FREQ_RATIO = 0.4;
/** Neighbors kept per source node, ranked by NPMI descending. */
export const DEFAULT_TOP_K = 20;
/**
 * Flat weight each seeded edge is written at. Chosen above a typical read
 * threshold so seeded edges traverse immediately, and above a single live
 * reinforcement so the edge-learning decay doesn't age a fresh seed straight
 * out on its first pass.
 */
export const DEFAULT_SEED_WEIGHT = 2.0;

/** Tuning knobs for {@link buildCoretrievalGraph}. */
export interface CoretrievalGraphOptions {
  minCount: number;
  maxNeighborFreqRatio: number;
  topK: number;
}

/** Driver knobs: graph tuning plus the persisted seed weight. */
export interface SeedCoretrievalOptions extends CoretrievalGraphOptions {
  seedWeight: number;
}

export const DEFAULT_SEED_OPTIONS: SeedCoretrievalOptions = {
  minCount: DEFAULT_MIN_COUNT,
  maxNeighborFreqRatio: DEFAULT_MAX_NEIGHBOR_FREQ_RATIO,
  topK: DEFAULT_TOP_K,
  seedWeight: DEFAULT_SEED_WEIGHT,
};

/** One scored outgoing edge. */
export interface ScoredEdge {
  target: string;
  score: number;
}

/** Summary of one seeding run, for the CLI/route report. */
export interface SeedCoretrievalResult {
  turnsScanned: number;
  nodes: number;
  edgesWritten: number;
  avgDegree: number;
}

/**
 * Build the co-retrieval adjacency from per-turn selected-slug sets.
 *
 * Pure: takes the already-extracted selection sets (one array per turn) and
 * returns `source -> ScoredEdge[]` (top-K NPMI neighbors, heaviest first). Turns
 * with fewer than two distinct slugs contribute no pairs and are ignored.
 */
export function buildCoretrievalGraph(
  turns: ReadonlyArray<ReadonlyArray<string>>,
  options: CoretrievalGraphOptions = DEFAULT_SEED_OPTIONS,
): Map<string, ScoredEdge[]> {
  const sets = turns.map((t) => [...new Set(t)]).filter((s) => s.length >= 2);
  const n = sets.length;
  const graph = new Map<string, ScoredEdge[]>();
  if (n === 0) return graph;

  const freq = new Map<string, number>();
  const cooccur = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string) => {
    let row = cooccur.get(a);
    if (!row) cooccur.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + 1);
  };
  for (const slugs of sets) {
    for (const slug of slugs) freq.set(slug, (freq.get(slug) ?? 0) + 1);
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        bump(slugs[i], slugs[j]);
        bump(slugs[j], slugs[i]);
      }
    }
  }

  const freqCap = options.maxNeighborFreqRatio * n;
  for (const [source, neighbors] of cooccur) {
    const fSource = freq.get(source)!;
    const scored: ScoredEdge[] = [];
    for (const [target, pairCount] of neighbors) {
      if (pairCount < options.minCount) continue;
      const fTarget = freq.get(target)!;
      if (fTarget > freqCap) continue;
      // NPMI = pmi / -ln(p(a,b)), in [-1, 1]. Higher = stronger association.
      // p(a,b)=1 (the pair co-occurs on every turn) is perfect association — its
      // NPMI limit is 1, but the formula is 0/0, so pin it to avoid NaN.
      const pab = pairCount / n;
      if (pab >= 1) {
        scored.push({ target, score: 1 });
        continue;
      }
      const pmi = Math.log(pab / ((fSource / n) * (fTarget / n)));
      scored.push({ target, score: pmi / -Math.log(pab) });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) graph.set(source, scored.slice(0, options.topK));
  }
  return graph;
}

/**
 * Extract one selection set per v2 router turn from `memory_v2_activation_logs`.
 * The set is the router's *fresh* per-turn pick (`status === 'injected'`), which
 * is the co-selection signal we want — not the accumulated in-context carry-over.
 *
 * Best-effort: a missing table (db predates the activation log) or an unparseable
 * row yields no turns rather than throwing — the caller degrades to "no seed".
 */
function readRouterSelections(database: DrizzleDb): string[][] {
  const turns: string[][] = [];
  try {
    const raw = getSqliteFrom(database);
    const rows = raw
      .query(
        `SELECT concepts_json FROM memory_v2_activation_logs WHERE mode = 'router'`,
      )
      .all() as Array<{ concepts_json: string }>;
    for (const row of rows) {
      let concepts: unknown;
      try {
        concepts = JSON.parse(row.concepts_json);
      } catch {
        continue;
      }
      if (!Array.isArray(concepts)) continue;
      const selected = new Set<string>();
      for (const entry of concepts) {
        if (
          entry &&
          typeof entry === "object" &&
          (entry as { status?: unknown }).status === "injected" &&
          typeof (entry as { slug?: unknown }).slug === "string"
        ) {
          selected.add((entry as { slug: string }).slug);
        }
      }
      if (selected.size >= 2) turns.push([...selected]);
    }
  } catch (err) {
    log.warn(
      { err },
      "failed to read router selections for seeding; continuing",
    );
  }
  return turns;
}

/**
 * Build the co-retrieval graph from the v2 router history and persist it into
 * `memory_v3_auto_edges` at a flat seed weight.
 *
 * Idempotent: each edge is upserted with `weight = MAX(existing, seedWeight)`, so
 * re-running refreshes seeded edges to the seed weight without unbounded growth
 * and without lowering any weight a live reinforcement already drove higher.
 */
export function seedCoretrievalEdges(
  database: DrizzleDb,
  options: SeedCoretrievalOptions = DEFAULT_SEED_OPTIONS,
): SeedCoretrievalResult {
  const turns = readRouterSelections(database);
  const graph = buildCoretrievalGraph(turns, options);

  const now = Date.now();
  let edgesWritten = 0;
  try {
    const raw = getSqliteFrom(database);
    const upsert = raw.prepare(
      `INSERT INTO memory_v3_auto_edges
         (source_slug, target_slug, weight, last_reinforced_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(source_slug, target_slug) DO UPDATE SET
         weight = MAX(weight, ?),
         last_reinforced_at = ?`,
    );
    const apply = raw.transaction(() => {
      for (const [source, edges] of graph) {
        for (const edge of edges) {
          upsert.run(
            source,
            edge.target,
            options.seedWeight,
            now,
            options.seedWeight,
            now,
          );
          edgesWritten += 1;
        }
      }
    });
    apply();
  } catch (err) {
    log.warn({ err }, "failed to persist seeded co-retrieval edges");
  }

  return {
    turnsScanned: turns.length,
    nodes: graph.size,
    edgesWritten,
    avgDegree: graph.size > 0 ? edgesWritten / graph.size : 0,
  };
}

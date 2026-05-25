/**
 * Memory v3 — learned weighted auto-edge store.
 *
 * Read/write helpers over `memory_v3_auto_edges` (migration 263) — the
 * **learned** association graph, a distinct class from the curated `edges:`
 * frontmatter graph. Each row is a weighted directed pair `source → target`
 * that the edge-learning job accrues from *used* co-activations and decays over
 * wall-clock time.
 *
 * Three primitives:
 *   - {@link reinforce} — bump a pair's weight, but only for a *used*
 *     co-activation (we reinforce usefulness, not mere retrieval).
 *   - {@link decay} — multiplicatively decay all weights toward zero on a
 *     half-life schedule, so a pair that stops being reinforced fades. This is
 *     the rich-get-richer counterweight: weight is a leaky integrator, not a
 *     monotone counter.
 *   - {@link aboveThreshold} — project the learned graph to the
 *     `ReadonlyMap<source, ReadonlySet<target>>` adjacency that edge
 *     expansion's `extraAdjacency` seam consumes (only pairs at/above a weight
 *     threshold traverse).
 *
 * The decay model mirrors v2's injection-events EMA: `λ = ln 2 / halfLife`, and
 * a pair decays by `exp(-λ × elapsed)` since its `last_reinforced_at`.
 */

import { getLogger } from "../../util/logger.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const log = getLogger("memory-v3-auto-edges");

/** Weight added to a pair per *used* co-activation reinforcement. */
export const REINFORCE_INCREMENT = 1;

/** Weights below this after decay are pruned rather than kept as dead rows. */
export const PRUNE_FLOOR = 0.01;

/** A learned auto-edge, as read back from the table. */
export interface AutoEdgeRow {
  sourceSlug: string;
  targetSlug: string;
  weight: number;
  lastReinforcedAt: number;
}

/**
 * Reinforce the directed pair `source → target`: bump its weight by
 * {@link REINFORCE_INCREMENT} and stamp `last_reinforced_at = now`. **Only call
 * this for a *used* co-activation** — the edge graph encodes which associations
 * actually proved load-bearing for a turn, not which pages merely surfaced
 * together. (The caller decides usedness from the co-activation's `used` flag;
 * this primitive is unconditional so it stays composable.)
 *
 * UPSERT on the `(source, target)` primary key: a new pair starts at the
 * increment; an existing pair accrues on top of its current weight (after the
 * latest decay pass, since decay rewrites weight in place).
 *
 * Best-effort: a failed write must never abort the edge-learning job.
 */
export function reinforce(
  database: DrizzleDb,
  source: string,
  target: string,
  now: number,
): void {
  try {
    const raw = getSqliteFrom(database);
    raw
      .prepare(
        `INSERT INTO memory_v3_auto_edges
           (source_slug, target_slug, weight, last_reinforced_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(source_slug, target_slug) DO UPDATE SET
           weight = weight + ?,
           last_reinforced_at = ?`,
      )
      .run(source, target, REINFORCE_INCREMENT, now, REINFORCE_INCREMENT, now);
  } catch (err) {
    log.warn(
      { err, source, target },
      "failed to reinforce auto-edge; continuing",
    );
  }
}

/**
 * Multiplicatively decay every auto-edge weight toward zero on a half-life
 * schedule: `weight ← weight × exp(-λ × (now − last_reinforced_at))`, with
 * `λ = ln 2 / halfLifeMs`. A pair last reinforced one half-life ago halves; two
 * half-lives ago quarters; and so on. `last_reinforced_at` advances to `now`
 * so successive decay passes don't double-count the same elapsed interval.
 *
 * Pairs whose decayed weight falls below {@link PRUNE_FLOOR} are deleted so the
 * learned graph doesn't accumulate a long tail of effectively-dead edges.
 *
 * Returns the number of rows pruned, for the job's structured log.
 */
export function decay(
  database: DrizzleDb,
  now: number,
  halfLifeMs: number,
): number {
  if (halfLifeMs <= 0) return 0;
  const lambda = Math.LN2 / halfLifeMs;
  try {
    const raw = getSqliteFrom(database);
    const rows = raw
      .query(
        `SELECT source_slug, target_slug, weight, last_reinforced_at
           FROM memory_v3_auto_edges`,
      )
      .all() as Array<{
      source_slug: string;
      target_slug: string;
      weight: number;
      last_reinforced_at: number;
    }>;
    if (rows.length === 0) return 0;

    const update = raw.prepare(
      `UPDATE memory_v3_auto_edges
         SET weight = ?, last_reinforced_at = ?
         WHERE source_slug = ? AND target_slug = ?`,
    );
    const prune = raw.prepare(
      `DELETE FROM memory_v3_auto_edges
         WHERE source_slug = ? AND target_slug = ?`,
    );

    let pruned = 0;
    const apply = raw.transaction(() => {
      for (const row of rows) {
        // Future timestamps (clock skew) would amplify rather than decay — clamp
        // elapsed at 0 so decay only ever shrinks weight.
        const elapsed = Math.max(0, now - row.last_reinforced_at);
        const decayed = row.weight * Math.exp(-lambda * elapsed);
        if (decayed < PRUNE_FLOOR) {
          prune.run(row.source_slug, row.target_slug);
          pruned += 1;
        } else {
          update.run(decayed, now, row.source_slug, row.target_slug);
        }
      }
    });
    apply();
    return pruned;
  } catch (err) {
    log.warn({ err }, "failed to decay auto-edges; continuing");
    return 0;
  }
}

/**
 * Project the learned graph to the `extraAdjacency` shape edge expansion
 * consumes: `source → Set<target>` for every pair whose weight is at or above
 * `threshold`. Edge expansion thresholds nothing itself — it merges whatever
 * adjacency it's handed — so this read is where the weight cutoff is applied.
 *
 * Returns an empty map on any read failure so the caller (a best-effort read
 * lane) degrades to "no learned edges" rather than aborting retrieval.
 */
export function aboveThreshold(
  database: DrizzleDb,
  threshold: number,
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  try {
    const raw = getSqliteFrom(database);
    const rows = raw
      .query(
        `SELECT source_slug, target_slug
           FROM memory_v3_auto_edges
           WHERE weight >= ?
           ORDER BY source_slug ASC, target_slug ASC`,
      )
      .all(threshold) as Array<{ source_slug: string; target_slug: string }>;
    for (const row of rows) {
      let targets = adjacency.get(row.source_slug);
      if (!targets) {
        targets = new Set<string>();
        adjacency.set(row.source_slug, targets);
      }
      targets.add(row.target_slug);
    }
  } catch (err) {
    log.warn({ err, threshold }, "failed to read auto-edges; continuing");
  }
  return adjacency;
}

/**
 * Read the top-weight auto-edges, heaviest first, capped at `limit`. The
 * edge-learning job surfaces these as advisory promotion candidates for the
 * assistant to ratify into curated `edges:` during consolidation.
 */
export function topByWeight(database: DrizzleDb, limit: number): AutoEdgeRow[] {
  if (limit <= 0) return [];
  try {
    const raw = getSqliteFrom(database);
    const rows = raw
      .query(
        `SELECT source_slug, target_slug, weight, last_reinforced_at
           FROM memory_v3_auto_edges
           ORDER BY weight DESC, source_slug ASC, target_slug ASC
           LIMIT ?`,
      )
      .all(limit) as Array<{
      source_slug: string;
      target_slug: string;
      weight: number;
      last_reinforced_at: number;
    }>;
    return rows.map((r) => ({
      sourceSlug: r.source_slug,
      targetSlug: r.target_slug,
      weight: r.weight,
      lastReinforcedAt: r.last_reinforced_at,
    }));
  } catch (err) {
    log.warn({ err, limit }, "failed to read top auto-edges; continuing");
    return [];
  }
}

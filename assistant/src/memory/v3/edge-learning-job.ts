/**
 * Memory v3 — `memory_v3_edge_learning` job (fast lane, no LLM).
 *
 * Reconciles the raw co-activation log (`memory_v3_coactivation`, migration
 * 262) into the weighted learned-edge graph (`memory_v3_auto_edges`, migration
 * 263). One pass does three things:
 *
 *   1. **Decay** — multiplicatively age all existing auto-edge weights toward
 *      zero on a half-life schedule (the rich-get-richer counterweight: an edge
 *      that stops being reinforced fades, so a once-hot pair can't dominate the
 *      adjacency forever).
 *   2. **Reinforce** — for each recent co-activation whose `used` flag is set,
 *      bump the `source → target` weight. *Used-only*: we learn associations
 *      that proved load-bearing for a turn, not pairs that merely surfaced
 *      together. The watermark checkpoint advances so each co-activation is
 *      counted once.
 *   3. **Propose** — surface the top-weight auto-edges as advisory promotion
 *      *candidates* for the assistant to ratify into curated `edges:` during
 *      consolidation. This job PROPOSES; it never auto-writes page frontmatter.
 *      Diversity counterweight: candidates are capped and a single source's
 *      out-edges are bounded so one hub can't monopolize the slate.
 *
 * Decay runs before reinforce so a fresh reinforcement isn't immediately aged
 * by the same pass. The job is idempotent in effect: re-running with no new
 * co-activations only decays (which is itself elapsed-time-bounded).
 */

import { getLogger } from "../../util/logger.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "../checkpoints.js";
import type { DrizzleDb } from "../db-connection.js";
import { getDb } from "../db-connection.js";
import type { MemoryJob } from "../jobs-store.js";
import {
  type AutoEdgeRow,
  decay,
  reinforce,
  topByWeight,
} from "./auto-edges.js";
import { readCoactivations } from "./coactivation-store.js";

const log = getLogger("memory-v3-edge-learning");

/**
 * Half-life of auto-edge weight decay. Matches the v2 injection-score cadence
 * (3 days) — a pair reinforced 3 days ago and never since contributes half its
 * weight, 6 days ago a quarter.
 */
export const EDGE_DECAY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

/** Max promotion candidates surfaced per run (the diversity cap). */
export const MAX_PROMOTION_CANDIDATES = 20;

/** Max candidates contributed by any single source slug (anti-hub diversity). */
export const MAX_CANDIDATES_PER_SOURCE = 3;

/**
 * Minimum weight for an auto-edge to be eligible for promotion. A pair must
 * accrue more than a single reinforcement (which decays away) before it's worth
 * proposing as a curated edge.
 */
export const PROMOTION_WEIGHT_FLOOR = 1.5;

/** Checkpoint key for the high-water mark of reconciled co-activations. */
const WATERMARK_KEY = "memory_v3_edge_learning:coactivation_watermark";

/** Summary of one edge-learning pass, returned for the dispatcher log + tests. */
export interface EdgeLearningResult {
  /** Used co-activations reinforced this pass. */
  reinforced: number;
  /** Co-activations skipped because `used` was falsy. */
  skippedUnused: number;
  /** Auto-edges pruned by decay (fell below the floor). */
  pruned: number;
  /** Advisory promotion candidates, heaviest first, after the diversity cap. */
  candidates: AutoEdgeRow[];
}

/**
 * Run one edge-learning pass against `database`. Pure of LLM and workspace I/O —
 * the whole pass is bounded DB work, hence the fast lane.
 */
export function runEdgeLearning(
  database: DrizzleDb,
  now = Date.now(),
): EdgeLearningResult {
  // 1. Decay first so this pass's reinforcements aren't immediately aged.
  const pruned = decay(database, now, EDGE_DECAY_HALF_LIFE_MS);

  // 2. Reinforce from co-activations newer than the watermark. The watermark is
  //    a created_at boundary; `since` is inclusive so we nudge it forward by 1ms
  //    to avoid re-counting the boundary row.
  const watermark = parseInt(getMemoryCheckpoint(WATERMARK_KEY) ?? "0", 10);
  const since = watermark > 0 ? watermark + 1 : undefined;
  const coactivations = readCoactivations(database, since);

  let reinforced = 0;
  let skippedUnused = 0;
  let maxCreatedAt = watermark;
  for (const row of coactivations) {
    if (row.createdAt > maxCreatedAt) maxCreatedAt = row.createdAt;
    // Reinforce usefulness, not mere retrieval: skip co-activations the loop
    // (or a later usefulness reconciliation) did not mark as used.
    if (!row.used) {
      skippedUnused += 1;
      continue;
    }
    reinforce(database, row.sourceSlug, row.targetSlug, now);
    reinforced += 1;
  }
  if (maxCreatedAt > watermark) {
    setMemoryCheckpoint(WATERMARK_KEY, String(maxCreatedAt));
  }

  // 3. Propose promotion candidates: heaviest auto-edges above the floor, capped
  //    overall and per-source so a single hub can't monopolize the slate.
  const candidates = selectPromotionCandidates(
    topByWeight(database, MAX_PROMOTION_CANDIDATES * MAX_CANDIDATES_PER_SOURCE),
  );

  log.info(
    {
      reinforced,
      skippedUnused,
      pruned,
      candidateCount: candidates.length,
    },
    "v3 edge learning complete",
  );

  return { reinforced, skippedUnused, pruned, candidates };
}

/**
 * Apply the weight floor and the overall / per-source diversity caps to a
 * weight-sorted list of auto-edges. Input must already be sorted heaviest-first
 * (as {@link topByWeight} returns).
 */
function selectPromotionCandidates(sorted: AutoEdgeRow[]): AutoEdgeRow[] {
  const out: AutoEdgeRow[] = [];
  const perSource = new Map<string, number>();
  for (const edge of sorted) {
    if (out.length >= MAX_PROMOTION_CANDIDATES) break;
    if (edge.weight < PROMOTION_WEIGHT_FLOOR) continue;
    const count = perSource.get(edge.sourceSlug) ?? 0;
    if (count >= MAX_CANDIDATES_PER_SOURCE) continue;
    perSource.set(edge.sourceSlug, count + 1);
    out.push(edge);
  }
  return out;
}

/**
 * Job handler for `memory_v3_edge_learning`. Thin wrapper over
 * {@link runEdgeLearning} so the heavy lifting (and its tests) live in one
 * place. The job carries no payload — it always reconciles the whole recent
 * co-activation log.
 */
export function memoryV3EdgeLearningJob(_job: MemoryJob): EdgeLearningResult {
  return runEdgeLearning(getDb());
}

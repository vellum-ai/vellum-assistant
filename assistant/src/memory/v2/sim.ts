// ---------------------------------------------------------------------------
// Memory v2 — Hybrid dense + sparse similarity
// ---------------------------------------------------------------------------
//
// Computes per-page similarity scores against a query text by fusing dense
// (cosine) and sparse (BM25-style) channels via a normalized weighted sum.
// This is the building block the per-turn activation formula (`A_o`) uses to
// score candidate concept pages against the latest user message, the latest
// assistant message, and NOW context.
//
// Why weighted-sum fusion (not RRF):
//   The activation formula in §4 of the design doc multiplies similarity
//   scores by config-tunable coefficients (`c_user`, `c_assistant`, `c_now`)
//   and adds them together. RRF would discard the score magnitudes the
//   coefficients operate on — it returns a rank-based pseudo-score that does
//   not blend smoothly with `d · A(n, t)`. Hybrid sim therefore queries each
//   channel separately and fuses with the configured `dense_weight` /
//   `sparse_weight` (which the schema validates sum to 1.0).
//
// Sparse normalization:
//   Dense cosine similarity is already in [0, 1]. Qdrant's sparse score is
//   on a different, unbounded scale (it depends on query and document term
//   weights), so we divide by the per-batch maximum sparse score to bring
//   it into [0, 1] before fusing. This is the design doc's choice (§4) —
//   batch-relative normalization is sufficient because the score is consumed
//   only as a per-turn ordering signal, not compared across turns.

import type { AssistantConfig } from "../../config/types.js";
import { applyCorrectionIfCalibrated } from "../anisotropy.js";
import { embedWithBackend } from "../embedding-backend.js";
import { clampUnitInterval } from "../validation.js";
import { hybridQueryConceptPages } from "./qdrant.js";
import { generateBm25QueryEmbedding } from "./sparse-bm25.js";

/**
 * Clamp a value into the closed unit interval [0, 1]. Re-exported under the
 * design-doc name so call sites that mirror the formula in §4 read cleanly.
 */
export const clamp01 = clampUnitInterval;

/**
 * Built-in defaults for adaptive sparse weighting. Live here (not in the
 * config schema) so operators don't see two new knobs in their config until
 * they actually want to tune them.
 *
 * Below `MIN_SPREAD`, the sparse channel is treated as no-signal (its scores
 * are uniform across the candidate set, so it can't rank anything) and the
 * sparse weight collapses to 0. At or above `FULL_SPREAD`, sparse weight
 * stays at its configured value. Linear interpolation between.
 */
const ADAPTIVE_SPARSE_MIN_SPREAD = 0.2;
const ADAPTIVE_SPARSE_FULL_SPREAD = 0.5;

/**
 * Per-query effective dense + sparse weights, derived from the configured
 * base weights and the spread of normalized sparse scores across the hit
 * set. When the sparse channel can't discriminate (low spread or fewer
 * than two sparse-bearing candidates), its weight collapses and dense
 * weight is boosted to compensate so `dense + sparse` still equals
 * `baseDense + baseSparse` and `fused` stays interpretable as a [0, 1]
 * similarity.
 *
 * Pure function — exported so the diagnostic surface in
 * `memory-v2-routes.explain-similarity` can show the effective weights and
 * the measured spread alongside per-channel score statistics.
 */
export function effectiveWeights(
  hits: ReadonlyArray<{ sparseScore?: number }>,
  maxSparse: number,
  baseDense: number,
  baseSparse: number,
  config: AssistantConfig,
): { dense: number; sparse: number; spread: number } {
  // Short-circuit when the channel is already disabled or unscored. Returning
  // base weights here keeps `fused` numerically identical to today's output
  // for the no-sparse-signal cases the existing tests assume.
  if (baseSparse === 0 || maxSparse === 0) {
    return { dense: baseDense, sparse: baseSparse, spread: 0 };
  }
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const h of hits) {
    if (h.sparseScore === undefined) continue;
    const norm = h.sparseScore / maxSparse;
    if (norm < min) min = norm;
    if (norm > max) max = norm;
    count++;
  }
  // With < 2 sparse-bearing hits the spread is undefined — fall back to base
  // weights so single-hit retrievals still surface their sparse contribution
  // (and the existing fusion-math tests stay green).
  if (count < 2) {
    return { dense: baseDense, sparse: baseSparse, spread: 0 };
  }
  const spread = max - min;

  const minSpread =
    config.memory.v2.min_sparse_spread ?? ADAPTIVE_SPARSE_MIN_SPREAD;
  const fullSpread =
    config.memory.v2.full_sparse_spread ?? ADAPTIVE_SPARSE_FULL_SPREAD;
  // Degenerate config (full <= min): no interpolation range. Don't try to
  // adapt; trust the operator's base weights and report the measured spread
  // for diagnostics.
  if (fullSpread <= minSpread) {
    return { dense: baseDense, sparse: baseSparse, spread };
  }
  const factor = clamp01((spread - minSpread) / (fullSpread - minSpread));
  const sparse = baseSparse * factor;
  const dense = baseDense + (baseSparse - sparse);
  return { dense, sparse, spread };
}

/**
 * Compute hybrid (dense + sparse) similarity scores between a query text and
 * a fixed set of candidate concept-page slugs.
 *
 * Steps:
 *   1. Embed the query text (dense via the configured embedding backend,
 *      sparse via the in-process TF-IDF encoder).
 *   2. Run server-side dense + sparse queries against the v2 concept-page
 *      Qdrant collection, restricted to `candidateSlugs` so we don't waste
 *      query bandwidth on unrelated pages.
 *   3. Fuse: per slug, `score = clamp01(dense_weight · denseCosine +
 *      sparse_weight · normalizedSparse)`. Sparse scores are normalized by
 *      the per-batch maximum (so the largest is 1.0); slugs missing from a
 *      channel contribute 0 from that channel.
 *
 * Returns a `Map<slug, score>` containing only the candidate slugs that hit
 * in at least one channel. Slugs in `candidateSlugs` that miss both channels
 * are absent from the map; callers should treat absence as score = 0 (the
 * activation pipeline does this implicitly when reading back A_o).
 *
 * Edge cases:
 *   - Empty `candidateSlugs` → returns an empty map without touching Qdrant
 *     or the embedding backend.
 *   - Empty / whitespace-only `text` → returns an empty map without touching
 *     Qdrant or the embedding backend. The Gemini embedding API rejects empty
 *     content with HTTP 400, and short-circuiting here prevents the failure
 *     from cascading through `Promise.all` in `computeOwnActivation` (e.g.
 *     turn 1 has no prior assistant message, so its `simBatch` channel is
 *     called with `""`). Treating the channel's contribution as 0 is the
 *     same outcome a no-hit query would produce.
 */
export async function simBatch(
  text: string,
  candidateSlugs: readonly string[],
  config: AssistantConfig,
  options?: { signal?: AbortSignal },
): Promise<Map<string, number>> {
  if (candidateSlugs.length === 0) {
    return new Map();
  }
  if (text.trim().length === 0) {
    return new Map();
  }

  // Sparse uses BM25: the query side encodes binary occurrences per token,
  // and the stored doc vectors carry the IDF · TF-saturated weights — Qdrant
  // dot product then yields the BM25 score directly.
  throwIfAborted(options?.signal);
  const denseResult = await embedWithBackend(config, [text], {
    signal: options?.signal,
  });
  const denseVector = await applyCorrectionIfCalibrated(
    denseResult.vectors[0],
    denseResult.provider,
    denseResult.model,
  );
  throwIfAborted(options?.signal);
  const sparseVector = generateBm25QueryEmbedding(text);

  const hits = await hybridQueryConceptPages(
    denseVector,
    sparseVector,
    candidateSlugs.length,
    candidateSlugs,
  );

  if (hits.length === 0) {
    return new Map();
  }

  const maxSparse = computeMaxSparse(hits);
  const { dense_weight: baseDense, sparse_weight: baseSparse } =
    config.memory.v2;
  const { dense: denseWeight, sparse: sparseWeight } = effectiveWeights(
    hits,
    maxSparse,
    baseDense,
    baseSparse,
    config,
  );

  const scores = new Map<string, number>();
  for (const hit of hits) {
    scores.set(hit.slug, fuseHit(hit, maxSparse, denseWeight, sparseWeight));
  }

  return scores;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

/**
 * Per-batch sparse-score maximum used for normalization. Hits missing from
 * the sparse channel contribute 0 (handled by the `undefined` guard).
 */
function computeMaxSparse(
  hits: ReadonlyArray<{ sparseScore?: number }>,
): number {
  let max = 0;
  for (const hit of hits) {
    if (hit.sparseScore !== undefined && hit.sparseScore > max) {
      max = hit.sparseScore;
    }
  }
  return max;
}

/**
 * Fuse a single hit's dense + sparse scores into a normalized [0, 1] score
 * via `clamp01(dense_weight · dense + sparse_weight · sparse/maxSparse)`.
 * Missing-channel scores contribute 0.
 */
function fuseHit(
  hit: { denseScore?: number; sparseScore?: number },
  maxSparse: number,
  denseWeight: number,
  sparseWeight: number,
): number {
  const dense = hit.denseScore ?? 0;
  const sparseNormalized =
    hit.sparseScore !== undefined && maxSparse > 0
      ? hit.sparseScore / maxSparse
      : 0;
  return clamp01(denseWeight * dense + sparseWeight * sparseNormalized);
}

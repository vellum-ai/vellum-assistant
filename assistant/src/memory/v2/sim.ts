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
// Score normalization:
//   Qdrant returns cosine similarity in [-1, 1]. We clamp negative cosines
//   to 0 before fusion so anti-correlated documents contribute zero, rather
//   than a negative term that subtracts from the sparse channel and can
//   depress the fused score below the sparse-only floor. Positive cosines
//   pass through unchanged — affine-rescaling them into [0, 1] via
//   `(cos + 1) / 2` would halve every pairwise dense difference and shift
//   ranking toward the sparse channel, the opposite of intent. Qdrant's
//   sparse score is on a different, unbounded scale (it depends on query
//   and document term weights), so we divide by the per-batch maximum
//   sparse score to bring it into [0, 1] before fusing. This is the design
//   doc's choice (§4) — batch-relative normalization is sufficient because
//   the score is consumed only as a per-turn ordering signal, not compared
//   across turns.

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
 *      query bandwidth on unrelated pages. The query hits four channels per
 *      page: body dense + body sparse, and (for pages that have a summary
 *      embedded) summary dense + summary sparse.
 *   3. Fuse: per slug, score = `max(fused(body), fused(summary))`. Each
 *      half is `clamp01(dense_weight · denseCosine + sparse_weight ·
 *      normalizedSparse)` with sparse normalized by the per-batch maximum.
 *      Pages without a summary embedding fall back to body-only fusion —
 *      the summary half is undefined and the max collapses to the body
 *      score.
 *
 * Returns a `Map<slug, score>` containing only the candidate slugs that hit
 * in at least one channel. Slugs in `candidateSlugs` that miss every channel
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

  // Compute per-batch sparse maxima independently for the body and summary
  // channels so each side normalizes against its own scale. Mixing the two
  // — e.g. dividing every sparse score by the larger of the two maxima —
  // would punish whichever channel happened to have lower-magnitude scores
  // even when its hits were the best matches available.
  const maxBodySparse = computeMaxSparse(hits, (h) => h.sparseScore);
  const maxSummarySparse = computeMaxSparse(hits, (h) => h.summarySparseScore);
  const { dense_weight: baseDense, sparse_weight: baseSparse } =
    config.memory.v2;
  const { dense: bodyDenseWeight, sparse: bodySparseWeight } = effectiveWeights(
    hits.map((h) => ({ sparseScore: h.sparseScore })),
    maxBodySparse,
    baseDense,
    baseSparse,
    config,
  );
  const { dense: summaryDenseWeight, sparse: summarySparseWeight } =
    effectiveWeights(
      hits.map((h) => ({ sparseScore: h.summarySparseScore })),
      maxSummarySparse,
      baseDense,
      baseSparse,
      config,
    );

  const scores = new Map<string, number>();
  for (const hit of hits) {
    const bodyScore = fuseHalf(
      hit.denseScore,
      hit.sparseScore,
      maxBodySparse,
      bodyDenseWeight,
      bodySparseWeight,
    );
    const summaryScore = fuseHalf(
      hit.summaryDenseScore,
      hit.summarySparseScore,
      maxSummarySparse,
      summaryDenseWeight,
      summarySparseWeight,
    );
    // Pages without a summary embedding return undefined for both summary
    // channels; their `summaryScore` falls back to the body score so the
    // max collapses cleanly to body-only behavior.
    const score = Math.max(bodyScore ?? 0, summaryScore ?? bodyScore ?? 0);
    scores.set(hit.slug, score);
  }

  return scores;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

/**
 * Per-batch sparse-score maximum used for normalization. The accessor picks
 * which sparse channel to scan — `sparseScore` for the body channel,
 * `summarySparseScore` for the summary channel. Hits missing from the
 * channel contribute 0 (handled by the `undefined` guard).
 */
function computeMaxSparse<T>(
  hits: ReadonlyArray<T>,
  accessor: (hit: T) => number | undefined,
): number {
  let max = 0;
  for (const hit of hits) {
    const value = accessor(hit);
    if (value !== undefined && value > max) {
      max = value;
    }
  }
  return max;
}

/**
 * Fuse one half of a hit (body or summary) into a normalized [0, 1] score
 * via `clamp01(dense_weight · max(0, cosine) + sparse_weight ·
 * sparse/maxSparse)`. Negative cosines clamp to 0 so they don't subtract
 * from sparse; positive cosines pass through unchanged so the
 * operator-configured dense/sparse balance is preserved. Returns
 * `undefined` when neither channel hit — a signal the half had no match
 * at all, so the caller can fall back to the other half cleanly.
 *
 * Exported so the context-search adapter can reuse the same fusion math
 * for its own activation pipeline.
 */
export function fuseHalf(
  denseScore: number | undefined,
  sparseScore: number | undefined,
  maxSparse: number,
  denseWeight: number,
  sparseWeight: number,
): number | undefined {
  if (denseScore === undefined && sparseScore === undefined) return undefined;
  const dense = denseScore !== undefined ? Math.max(0, denseScore) : 0;
  const sparseNormalized =
    sparseScore !== undefined && maxSparse > 0 ? sparseScore / maxSparse : 0;
  return clamp01(denseWeight * dense + sparseWeight * sparseNormalized);
}

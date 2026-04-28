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
import {
  embedWithBackend,
  generateSparseEmbedding,
} from "../embedding-backend.js";
import { clampUnitInterval } from "../validation.js";
import { hybridQueryConceptPages } from "./qdrant.js";

/**
 * Clamp a value into the closed unit interval [0, 1]. Re-exported under the
 * design-doc name so call sites that mirror the formula in §4 read cleanly.
 */
export const clamp01 = clampUnitInterval;

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
 *   - Empty query text or all-zero sparse vector → still queries (dense may
 *     still hit), and the sparse contribution to fusion is zero.
 */
export async function simBatch(
  text: string,
  candidateSlugs: readonly string[],
  config: AssistantConfig,
): Promise<Map<string, number>> {
  if (candidateSlugs.length === 0) {
    return new Map();
  }

  // Sparse uses the shared TF-IDF encoder so the query and stored vectors
  // share a vocabulary with PKB indexing.
  const denseResult = await embedWithBackend(config, [text]);
  const denseVector = denseResult.vectors[0];
  const sparseVector = generateSparseEmbedding(text);

  const hits = await hybridQueryConceptPages(
    denseVector,
    sparseVector,
    candidateSlugs.length,
    candidateSlugs,
  );

  if (hits.length === 0) {
    return new Map();
  }

  // Per-batch sparse normalization: divide by the max sparse score so the
  // top hit is 1.0 and the rest scale down proportionally.
  let maxSparse = 0;
  for (const hit of hits) {
    if (hit.sparseScore !== undefined && hit.sparseScore > maxSparse) {
      maxSparse = hit.sparseScore;
    }
  }

  const { dense_weight: denseWeight, sparse_weight: sparseWeight } =
    config.memory.v2;

  const scores = new Map<string, number>();
  for (const hit of hits) {
    const dense = hit.denseScore ?? 0;
    const sparseNormalized =
      hit.sparseScore !== undefined && maxSparse > 0
        ? hit.sparseScore / maxSparse
        : 0;
    const fused = clamp01(
      denseWeight * dense + sparseWeight * sparseNormalized,
    );
    scores.set(hit.slug, fused);
  }

  return scores;
}

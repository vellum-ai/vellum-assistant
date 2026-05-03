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
import { embedWithBackend } from "../embedding-backend.js";
import { clampUnitInterval } from "../validation.js";
import { hybridQueryConceptPages } from "./qdrant.js";
import { hybridQuerySkills } from "./skill-qdrant.js";
import { generateBm25QueryEmbedding } from "./sparse-bm25.js";

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
  const denseResult = await embedWithBackend(config, [text]);
  const denseVector = denseResult.vectors[0];
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
  const { dense_weight: denseWeight, sparse_weight: sparseWeight } =
    config.memory.v2;

  const scores = new Map<string, number>();
  for (const hit of hits) {
    scores.set(hit.slug, fuseHit(hit, maxSparse, denseWeight, sparseWeight));
  }
  return scores;
}

/**
 * Compute hybrid (dense + sparse) similarity scores between a query text and
 * a fixed set of candidate skill ids. Mirrors `simBatch` but targets the
 * dedicated `memory_v2_skills` Qdrant collection via `hybridQuerySkills`.
 *
 * Differences from `simBatch`:
 *   - Keys are skill `id` values (not concept-page slugs).
 *   - Restricts the query to the caller's candidate ids server-side via
 *     `hybridQuerySkills`'s `restrictToIds` parameter. Without this, when the
 *     skills collection has more skills than `ids.length`, Qdrant would
 *     return its global top-K and candidate ids absent from that top-K would
 *     silently score 0 — corrupting the activation calculation.
 *
 * Returns a `Map<id, score>` of fused scores in [0, 1]. Ids that did not hit
 * either channel are absent from the map.
 *
 * Edge cases:
 *   - Empty `ids` → returns an empty map without touching Qdrant or the
 *     embedding backend.
 *   - Empty / whitespace-only `text` → returns an empty map without touching
 *     Qdrant or the embedding backend. Same rationale as {@link simBatch}:
 *     Gemini rejects empty content with HTTP 400, so the activation pipeline
 *     would otherwise fail on turn 1 (where the assistant-text channel is
 *     `""`). Treating the channel's contribution as 0 matches a no-hit
 *     query.
 */
export async function simSkillBatch(
  text: string,
  ids: readonly string[],
  config: AssistantConfig,
): Promise<Map<string, number>> {
  if (ids.length === 0) {
    return new Map();
  }
  if (text.trim().length === 0) {
    return new Map();
  }

  const denseResult = await embedWithBackend(config, [text]);
  const denseVector = denseResult.vectors[0];
  const sparseVector = generateBm25QueryEmbedding(text);

  const hits = await hybridQuerySkills(
    denseVector,
    sparseVector,
    ids.length,
    ids,
  );

  if (hits.length === 0) {
    return new Map();
  }

  // Defensive post-filter — `hybridQuerySkills` restricts server-side, so
  // every hit should already be in `ids`, but keep this guard so a buggy
  // payload (e.g. a missing/typoed id index) can't silently inject
  // out-of-set ids into the score map.
  const idSet = new Set(ids);
  const filtered = hits.filter((h) => idSet.has(h.id));
  if (filtered.length === 0) {
    return new Map();
  }

  const maxSparse = computeMaxSparse(filtered);
  const { dense_weight: denseWeight, sparse_weight: sparseWeight } =
    config.memory.v2;

  const scores = new Map<string, number>();
  for (const hit of filtered) {
    scores.set(hit.id, fuseHit(hit, maxSparse, denseWeight, sparseWeight));
  }
  return scores;
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

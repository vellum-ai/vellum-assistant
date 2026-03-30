import { generateSparseEmbedding } from "../embedding-backend.js";
import type { SparseEmbedding } from "../embedding-types.js";
import type { TieredCandidate } from "./tier-classifier.js";

/**
 * Compute cosine similarity between two sparse vectors.
 * Returns 0 if either vector has zero magnitude.
 */
function sparseCosine(a: SparseEmbedding, b: SparseEmbedding): number {
  // Build index→value map for vector b
  const bMap = new Map<number, number>();
  for (let i = 0; i < b.indices.length; i++) {
    bMap.set(b.indices[i]!, b.values[i]!);
  }

  // Compute dot product over shared indices
  let dotProduct = 0;
  for (let i = 0; i < a.indices.length; i++) {
    const bVal = bMap.get(a.indices[i]!);
    if (bVal !== undefined) {
      dotProduct += a.values[i]! * bVal;
    }
  }

  // Compute magnitudes
  let magA = 0;
  for (const v of a.values) magA += v * v;
  magA = Math.sqrt(magA);

  let magB = 0;
  for (const v of b.values) magB += v * v;
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

/**
 * Apply Maximal Marginal Relevance (MMR) diversity ranking to candidates.
 *
 * Items are re-ranked using a greedy selection loop that progressively
 * penalizes candidates whose text is similar to already-selected ones.
 * Non-item candidates (segments, summaries, media) pass through unpenalized
 * since they represent different conversation windows.
 *
 * @param candidates - Scored candidates from upstream ranking
 * @param penalty - Float 0..1. 0 = no diversity pressure, 1 = maximum
 * @returns Re-ranked candidates with adjusted finalScores
 */
export function applyMMR(
  candidates: TieredCandidate[],
  penalty: number,
): TieredCandidate[] {
  // Pre-compute sparse embeddings for all candidates
  const embeddings = candidates.map((c) => generateSparseEmbedding(c.text));

  // Separate items from non-items
  const items: { index: number; candidate: TieredCandidate }[] = [];
  const nonItems: TieredCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.type === "item") {
      items.push({ index: i, candidate: c });
    } else {
      nonItems.push(c);
    }
  }

  // If no items or no penalty, pass through in original order
  if (items.length === 0 || penalty === 0) {
    return candidates;
  }

  // Greedy MMR selection loop
  const selected: number[] = [];
  const remaining = new Set<number>(items.map((_, i) => i));
  const adjustedScores = new Map<number, number>();

  // Select the item with the highest finalScore first
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (const idx of remaining) {
    const score = items[idx]!.candidate.finalScore;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }
  selected.push(bestIdx);
  remaining.delete(bestIdx);
  adjustedScores.set(bestIdx, items[bestIdx]!.candidate.finalScore);

  // Iteratively select remaining items
  while (remaining.size > 0) {
    let nextBestIdx = -1;
    let nextBestScore = -Infinity;

    for (const idx of remaining) {
      const itemEmbIdx = items[idx]!.index;

      // Compute max similarity to any already-selected item
      let maxSim = 0;
      for (const selIdx of selected) {
        const selEmbIdx = items[selIdx]!.index;
        const sim = sparseCosine(
          embeddings[itemEmbIdx]!,
          embeddings[selEmbIdx]!,
        );
        if (sim > maxSim) maxSim = sim;
      }

      const adjustedScore =
        items[idx]!.candidate.finalScore * (1 - maxSim * penalty);
      if (adjustedScore > nextBestScore) {
        nextBestScore = adjustedScore;
        nextBestIdx = idx;
      }
    }

    selected.push(nextBestIdx);
    remaining.delete(nextBestIdx);
    adjustedScores.set(nextBestIdx, nextBestScore);
  }

  // Rebuild output: non-items first (original order), then items in selected order
  const result: TieredCandidate[] = [...nonItems];
  for (const idx of selected) {
    result.push({
      ...items[idx]!.candidate,
      finalScore: adjustedScores.get(idx)!,
    });
  }

  return result;
}

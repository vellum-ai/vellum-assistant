// ---------------------------------------------------------------------------
// Memory substrate — edge-graph activation spreading over the concept-page
// substrate.
// ---------------------------------------------------------------------------
//
// Implements the spread step of the activation formula (§4 of the design
// doc):
//
//   A(n, t+1) = [ A_o(n)
//               + k  · Σ_{m∈in1(n)} A_o(m)
//               + k² · Σ_{m∈in2(n)} A_o(m) ]
//             / (1 + k · #in1(n) + k² · #in2(n))
//
// Edges are directed: edge A→B means A's activation contributes to B's. The
// per-target BFS walks *incoming* adjacency, so `in1(n)` is the set of nodes
// with an edge A→n and `in2(n)` adds another hop in the same direction.
//
// Bounded in [0, 1]. Pure sources (no incoming edges within `hops`) reduce to
// A == A_o because both numerator and denominator collapse to `A_o(n)` and
// `1`, respectively.
//
// Consumed by both the v2 injection engine (`v2/activation.ts`) and the
// `memory` recall source (`context-search/sources/memory-v2.ts`), which runs
// whenever `usesConceptPageMemory()` holds — i.e. under v3 too.

import { clampUnitInterval } from "../validation.js";
import type { EdgeIndex } from "./edge-index.js";

interface SpreadActivationResult {
  /** Final activation value per slug after spreading. */
  final: Map<string, number>;
  /**
   * Per-slug spread delta: `final[slug] - own[slug]`. Captures how much
   * the spread step nudged each node above (or below) its own activation —
   * useful for inspector views that want to show graph contributions
   * separate from raw sim contributions. Always 0 when `hops == 0` or
   * `k == 0` because both short-circuit to `final == own`.
   */
  contribution: Map<string, number>;
}

/**
 * Apply 2-hop spreading activation with neighborhood normalization. Edges are
 * directed: an edge A→B means A's activation contributes to B's final value.
 *
 *   A(n) = [ A_o(n) + Σ_{r: |active_inR(n)| > 0} k^r · L2(active_inR(n)) ]
 *        / [ 1     + Σ_{r: |active_inR(n)| > 0} k^r ]
 *
 * `active_inR(n)` is the subset of structural predecessors at hop `r` that
 * also appear in `ownActivation` (i.e. made the candidate set). `L2(.)` is
 * the quadratic mean √(mean(A_o²)) — a mild bias toward strong outliers
 * compared to the arithmetic mean, without letting a single high-cosine
 * predecessor dominate the way `max` would.
 *
 * Hops with **no** active predecessors are dropped from BOTH numerator and
 * denominator so a high-in-degree hub with mostly-inactive neighbors stays
 * near `A_o` instead of being crushed by the structural count. A pure
 * source (no incoming edges, or every edge points at a non-candidate)
 * collapses to `A == A_o`.
 *
 * Bounded in [0, 1]: every `L2` term ≤ max active A_o ≤ 1, so the numerator
 * is at most `1 + Σ k^r` — exactly the denominator — so the ratio is at most
 * 1. `clampUnitInterval` guards against numerical drift and out-of-range
 * inputs.
 *
 * Pure function — no I/O. Reads the precomputed `incoming` map from
 * `edgeIndex` and runs a per-source BFS bounded by `hops`.
 */
export function spreadActivation(
  ownActivation: ReadonlyMap<string, number>,
  edgeIndex: EdgeIndex,
  k: number,
  hops: number,
): SpreadActivationResult {
  const final = new Map<string, number>();
  const contribution = new Map<string, number>();
  if (ownActivation.size === 0) {
    return { final, contribution };
  }

  // Short-circuit: with no spread the formula collapses to A == A_o.
  if (hops <= 0 || k <= 0) {
    for (const [slug, ownValue] of ownActivation) {
      final.set(slug, clampUnitInterval(ownValue));
      contribution.set(slug, 0);
    }
    return { final, contribution };
  }

  for (const [slug, ownValue] of ownActivation) {
    // Single bounded BFS from `slug` over incoming edges. `distance` maps
    // predecessor → hop count (1..hops). Source is excluded so it contributes
    // hop-0 only via `numerator = ownValue`.
    const distance = bfsPredecessorDistances(edgeIndex.incoming, slug, hops);

    // Bucket only predecessors that are in `ownActivation` (the candidate
    // set). Structural predecessors that didn't make the cut contribute
    // nothing — neither to the numerator nor the denominator — so hub
    // in-degree alone never penalizes a node.
    const ringActiveCounts: number[] = new Array(hops + 1).fill(0);
    const ringSquareSums: number[] = new Array(hops + 1).fill(0);
    for (const [predecessor, hop] of distance) {
      const predValue = ownActivation.get(predecessor);
      if (predValue === undefined) {
        continue;
      }
      ringActiveCounts[hop] += 1;
      ringSquareSums[hop] += predValue * predValue;
    }

    let numerator = ownValue;
    let denominator = 1;
    let kPow = 1;
    for (let r = 1; r <= hops; r++) {
      kPow *= k;
      if (ringActiveCounts[r] === 0) {
        continue;
      }
      const rms = Math.sqrt(ringSquareSums[r] / ringActiveCounts[r]);
      numerator += kPow * rms;
      denominator += kPow;
    }

    const finalValue = clampUnitInterval(numerator / denominator);
    final.set(slug, finalValue);
    contribution.set(slug, finalValue - ownValue);
  }

  return { final, contribution };
}

/**
 * Bounded BFS over the *incoming* adjacency map. Returns each reachable
 * predecessor's hop-distance in [1, maxHops] from `target` — i.e. nodes from
 * which a directed path of that length leads into `target`. The target itself
 * is excluded.
 */
function bfsPredecessorDistances(
  incoming: ReadonlyMap<string, ReadonlySet<string>>,
  target: string,
  maxHops: number,
): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier: string[] = [target];
  const visited = new Set<string>([target]);
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      const predecessors = incoming.get(node);
      if (!predecessors) {
        continue;
      }
      for (const predecessor of predecessors) {
        if (visited.has(predecessor)) {
          continue;
        }
        visited.add(predecessor);
        distance.set(predecessor, hop);
        next.push(predecessor);
      }
    }
    frontier = next;
  }
  return distance;
}

// ---------------------------------------------------------------------------
// Memory Graph — Scoring functions for retrieval
// ---------------------------------------------------------------------------

import type { MemoryEdge, MemoryNode, ScoredNode } from "./types.js";

// ---------------------------------------------------------------------------
// Temporal boost — cyclical similarity on hour / dayOfWeek / month
// ---------------------------------------------------------------------------

/**
 * Cyclical similarity between two points on a circle of given period.
 * Returns 1.0 when identical, -1.0 when opposite, continuous between.
 */
function cyclicalSimilarity(a: number, b: number, period: number): number {
  const angleA = (2 * Math.PI * a) / period;
  const angleB = (2 * Math.PI * b) / period;
  return (
    Math.cos(angleA) * Math.cos(angleB) + Math.sin(angleA) * Math.sin(angleB)
  );
}

/**
 * Compute a temporal boost for a memory node based on how similar its
 * creation time is to the current time across three cyclical dimensions.
 *
 * Returns a value roughly in [-1, 1] (weighted sum of three cos similarities).
 * In practice, used as a small additive modifier to retrieval scores.
 */
export function computeTemporalBoost(node: MemoryNode, now: Date): number {
  const created = new Date(node.created);

  const hourSim = cyclicalSimilarity(created.getHours(), now.getHours(), 24);
  const daySim = cyclicalSimilarity(created.getDay(), now.getDay(), 7);
  const monthSim = cyclicalSimilarity(created.getMonth(), now.getMonth(), 12);

  // Hour matters most (same time of day), day-of-week next, season least
  return 0.5 * hourSim + 0.3 * daySim + 0.2 * monthSim;
}

// ---------------------------------------------------------------------------
// Effective significance — Ebbinghaus forgetting curve with stability
// ---------------------------------------------------------------------------

/**
 * Compute the effective (decayed) significance of a memory node right now.
 *
 * Uses the Ebbinghaus forgetting curve: S(t) = S₀ × e^(-t/stability)
 * where t is days since last reinforcement.
 *
 * High stability (from many reinforcements) → very slow decay.
 * stability=14 (default) → after 2 weeks, ~37% remains.
 * stability=806 (10 reinforcements) → essentially permanent.
 */
export function computeEffectiveSignificance(
  node: MemoryNode,
  now: number,
): number {
  const elapsedMs = now - node.lastReinforced;
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  if (elapsedDays <= 0) return node.significance;
  return node.significance * Math.exp(-elapsedDays / node.stability);
}

// ---------------------------------------------------------------------------
// Activation spreading — BFS with decaying weight over edges
// ---------------------------------------------------------------------------

/**
 * Starting from a set of activated node IDs, spread activation through
 * the edge graph with decaying weight. Returns a map of nodeId → activation
 * boost for all nodes reachable within maxHops.
 *
 * Each hop reduces the weight by `decayFactor` (default 0.5).
 * Self-activation (start nodes) is not included in the output.
 */
export function computeActivationSpread(
  startNodeIds: string[],
  edges: MemoryEdge[],
  maxHops: number = 2,
  decayFactor: number = 0.5,
): Map<string, number> {
  // Build adjacency list (bidirectional — edges connect both ways)
  const adjacency = new Map<
    string,
    Array<{ neighbor: string; weight: number }>
  >();
  for (const edge of edges) {
    if (!adjacency.has(edge.sourceNodeId)) adjacency.set(edge.sourceNodeId, []);
    if (!adjacency.has(edge.targetNodeId)) adjacency.set(edge.targetNodeId, []);
    adjacency.get(edge.sourceNodeId)!.push({
      neighbor: edge.targetNodeId,
      weight: edge.weight,
    });
    adjacency.get(edge.targetNodeId)!.push({
      neighbor: edge.sourceNodeId,
      weight: edge.weight,
    });
  }

  const activation = new Map<string, number>();
  const startSet = new Set(startNodeIds);

  // BFS with decaying weight
  let frontier = startNodeIds.map((id) => ({ id, weight: 1.0 }));

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier: Array<{ id: string; weight: number }> = [];
    for (const { id, weight } of frontier) {
      const neighbors = adjacency.get(id);
      if (!neighbors) continue;

      for (const { neighbor, weight: edgeWeight } of neighbors) {
        if (startSet.has(neighbor)) continue; // Don't boost start nodes

        const spreadWeight = weight * edgeWeight * decayFactor;
        const current = activation.get(neighbor) ?? 0;
        // Take the max, not sum — prevents double-counting from multiple paths
        if (spreadWeight > current) {
          activation.set(neighbor, spreadWeight);
        }
        nextFrontier.push({ id: neighbor, weight: spreadWeight });
      }
    }
    frontier = nextFrontier;
  }

  return activation;
}

// ---------------------------------------------------------------------------
// Recency boost — linear decay over days
// ---------------------------------------------------------------------------

/**
 * Compute a recency boost for a memory node. Returns 1.0 for nodes created
 * right now, decaying linearly to 0.0 at `halfLifeDays` and beyond.
 *
 * This is distinct from temporalBoost (cyclical time-of-day similarity).
 * Recency ensures recent events surface at conversation start even when
 * their significance is moderate.
 */
export function computeRecencyBoost(
  node: MemoryNode,
  nowMs: number,
  halfLifeDays: number = 7,
): number {
  const elapsedDays = (nowMs - node.created) / (1000 * 60 * 60 * 24);
  if (elapsedDays <= 0) return 1.0;
  return Math.max(0, 1.0 - elapsedDays / (halfLifeDays * 2));
}

// ---------------------------------------------------------------------------
// Combined scoring
// ---------------------------------------------------------------------------

/** Weights for combining score components. */
export interface ScoringWeights {
  semanticSimilarity: number;
  effectiveSignificance: number;
  emotionalIntensity: number;
  temporalBoost: number;
  recencyBoost: number;
  triggerBoost: number;
  activationBoost: number;
}

/** Weights for context-load (conversation start): balanced across all signals. */
const DEFAULT_WEIGHTS: ScoringWeights = {
  semanticSimilarity: 0.25,
  effectiveSignificance: 0.15,
  emotionalIntensity: 0.15,
  temporalBoost: 0.05,
  recencyBoost: 0.15,
  triggerBoost: 0.15,
  activationBoost: 0.1,
};

/**
 * Weights for per-turn injection: heavily biased toward semantic similarity.
 * Per-turn injections should only surface memories directly relevant to
 * what's being discussed right now — not general high-significance memories.
 */
export const PER_TURN_WEIGHTS: ScoringWeights = {
  semanticSimilarity: 0.60,
  effectiveSignificance: 0.05,
  emotionalIntensity: 0.05,
  temporalBoost: 0.0,
  recencyBoost: 0.05,
  triggerBoost: 0.20,
  activationBoost: 0.05,
};

/**
 * Compute the final retrieval score for a candidate node.
 * All components should be in [0, 1] range before weighting.
 *
 * Recency boost (0.15) ensures recent events always surface at conversation
 * start — without it, the context block becomes a museum of greatest hits
 * with no awareness of what happened recently. The 14-day half-life means
 * events from the past week score 0.5-1.0, while events older than 2 weeks
 * contribute nothing via recency (they surface through significance, semantic
 * similarity, or triggers instead).
 */
export function scoreCandidate(
  node: MemoryNode,
  components: {
    semanticSimilarity: number;
    effectiveSignificance: number;
    emotionalIntensity: number;
    temporalBoost: number;
    recencyBoost: number;
    triggerBoost: number;
    activationBoost: number;
  },
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ScoredNode {
  const score =
    weights.semanticSimilarity * components.semanticSimilarity +
    weights.effectiveSignificance * components.effectiveSignificance +
    weights.emotionalIntensity * components.emotionalIntensity +
    weights.temporalBoost * Math.max(0, components.temporalBoost) +
    weights.recencyBoost * components.recencyBoost +
    weights.triggerBoost * components.triggerBoost +
    weights.activationBoost * components.activationBoost;

  return {
    node,
    score,
    scoreBreakdown: components,
  };
}

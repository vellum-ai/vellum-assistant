import { describe, expect, test } from "bun:test";

import {
  computeActivationSpread,
  computeEffectiveSignificance,
  computeRecencyBoost,
  computeTemporalBoost,
  DEFAULT_WEIGHTS,
  PER_TURN_WEIGHTS,
  PROCEDURAL_WEIGHTS,
  scoreCandidate,
  type ScoringWeights,
  weightsForContextLoad,
} from "./scoring.js";
import type { MemoryNode } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "node-1",
    content: "Test memory",
    type: "episodic",
    created: Date.now(),
    lastAccessed: Date.now(),
    lastConsolidated: Date.now(),
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0,
    },
    fidelity: "vivid",
    confidence: 0.8,
    significance: 0.5,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: Date.now(),
    sourceConversations: ["conv-1"],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "default",
    ...overrides,
  };
}

const DAY_MS = 1000 * 60 * 60 * 24;

// ---------------------------------------------------------------------------
// computeTemporalBoost
// ---------------------------------------------------------------------------

describe("computeTemporalBoost", () => {
  test("returns 1.0 when node created at exact same time-of-day/day/month", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    const node = makeNode({
      created: new Date("2024-06-15T10:00:00Z").getTime(),
    });
    // Same hour, same day-of-week might differ by year but same month
    // Hour: 10 vs 10 → sim=1.0, Month: June vs June → sim=1.0
    // Day: depends on year but same formula applies
    const boost = computeTemporalBoost(node, now);
    // Hour match (0.5×1.0) + Month match (0.2×1.0) = 0.7 + dayOfWeek contribution
    expect(boost).toBeGreaterThan(0.5);
  });

  test("returns near -1 when node created at opposite time of day", () => {
    // 0:00 vs 12:00 → opposite hours (12 apart on a 24 cycle)
    const now = new Date("2025-06-15T00:00:00Z");
    const node = makeNode({
      created: new Date("2025-06-15T12:00:00Z").getTime(),
    });
    const boost = computeTemporalBoost(node, now);
    // Hour: 0 vs 12 → sim=-1.0 (opposite), other components vary
    // 0.5 × (-1) = -0.5, plus day (same day → +0.3) and month (same → +0.2)
    // Net: -0.5 + 0.3 + 0.2 = 0.0 (ish)
    expect(boost).toBeLessThan(0.5);
  });

  test("hour component dominates the boost", () => {
    // Same hour, different day/month vs different hour, same day/month
    const now = new Date("2025-06-15T10:00:00Z");

    const sameHourNode = makeNode({
      created: new Date("2025-01-01T10:00:00Z").getTime(),
    });
    const diffHourNode = makeNode({
      created: new Date("2025-06-15T22:00:00Z").getTime(),
    });

    const sameHourBoost = computeTemporalBoost(sameHourNode, now);
    const diffHourBoost = computeTemporalBoost(diffHourNode, now);

    // Same hour should produce higher boost than same day/month but different hour
    expect(sameHourBoost).toBeGreaterThan(diffHourBoost);
  });

  test("returns a value in [-1, 1] range", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    for (let h = 0; h < 24; h++) {
      for (let d = 0; d < 7; d++) {
        // Create dates with varying hours and days
        const date = new Date(2025, d, h + 1, h, 0, 0);
        const node = makeNode({ created: date.getTime() });
        const boost = computeTemporalBoost(node, now);
        expect(boost).toBeGreaterThanOrEqual(-1);
        expect(boost).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveSignificance
// ---------------------------------------------------------------------------

describe("computeEffectiveSignificance", () => {
  test("returns full significance when no time has elapsed", () => {
    const now = Date.now();
    const node = makeNode({
      significance: 0.8,
      stability: 14,
      lastReinforced: now,
    });
    const eff = computeEffectiveSignificance(node, now);
    expect(eff).toBe(0.8);
  });

  test("returns full significance when elapsed is negative", () => {
    const now = Date.now();
    const node = makeNode({
      significance: 0.8,
      stability: 14,
      lastReinforced: now + 1000,
    });
    const eff = computeEffectiveSignificance(node, now);
    expect(eff).toBe(0.8);
  });

  test("decays to ~37% of original after one stability period", () => {
    const now = Date.now();
    const stability = 14;
    const node = makeNode({
      significance: 1.0,
      stability,
      lastReinforced: now - stability * DAY_MS,
    });
    const eff = computeEffectiveSignificance(node, now);
    // e^(-1) ≈ 0.3679
    expect(eff).toBeCloseTo(Math.exp(-1), 4);
  });

  test("high stability slows decay dramatically", () => {
    const now = Date.now();
    const elapsed = 14 * DAY_MS; // 14 days

    const lowStability = makeNode({
      significance: 1.0,
      stability: 14,
      lastReinforced: now - elapsed,
    });
    const highStability = makeNode({
      significance: 1.0,
      stability: 806, // ~10 reinforcements (14 × 1.5^10)
      lastReinforced: now - elapsed,
    });

    const lowEff = computeEffectiveSignificance(lowStability, now);
    const highEff = computeEffectiveSignificance(highStability, now);

    // Low stability: e^(-14/14) = e^(-1) ≈ 0.368
    expect(lowEff).toBeCloseTo(Math.exp(-1), 3);
    // High stability: e^(-14/806) ≈ 0.983 — essentially permanent
    expect(highEff).toBeGreaterThan(0.98);
    expect(highEff).toBeGreaterThan(lowEff);
  });

  test("zero significance stays zero regardless of time", () => {
    const now = Date.now();
    const node = makeNode({
      significance: 0,
      stability: 14,
      lastReinforced: now - 100 * DAY_MS,
    });
    const eff = computeEffectiveSignificance(node, now);
    expect(eff).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRecencyBoost
// ---------------------------------------------------------------------------

describe("computeRecencyBoost", () => {
  test("returns 1.0 for a node created right now", () => {
    const now = Date.now();
    const node = makeNode({ created: now });
    expect(computeRecencyBoost(node, now)).toBe(1.0);
  });

  test("returns 1.0 for a node created in the future (negative elapsed)", () => {
    const now = Date.now();
    const node = makeNode({ created: now + 1000 });
    expect(computeRecencyBoost(node, now)).toBe(1.0);
  });

  test("returns 0.5 at the half-life point", () => {
    const now = Date.now();
    const halfLifeDays = 7;
    const node = makeNode({ created: now - halfLifeDays * DAY_MS });
    const boost = computeRecencyBoost(node, now, halfLifeDays);
    expect(boost).toBeCloseTo(0.5, 5);
  });

  test("returns 0.0 at 2x the half-life", () => {
    const now = Date.now();
    const halfLifeDays = 7;
    const node = makeNode({ created: now - 2 * halfLifeDays * DAY_MS });
    const boost = computeRecencyBoost(node, now, halfLifeDays);
    expect(boost).toBe(0);
  });

  test("returns 0.0 for very old nodes (beyond 2x half-life)", () => {
    const now = Date.now();
    const halfLifeDays = 7;
    const node = makeNode({ created: now - 365 * DAY_MS });
    const boost = computeRecencyBoost(node, now, halfLifeDays);
    expect(boost).toBe(0);
  });

  test("linear decay between 0 and 2×halfLife days", () => {
    const now = Date.now();
    const halfLifeDays = 7;

    const boostAt3d = computeRecencyBoost(
      makeNode({ created: now - 3 * DAY_MS }),
      now,
      halfLifeDays,
    );
    const boostAt7d = computeRecencyBoost(
      makeNode({ created: now - 7 * DAY_MS }),
      now,
      halfLifeDays,
    );
    const boostAt10d = computeRecencyBoost(
      makeNode({ created: now - 10 * DAY_MS }),
      now,
      halfLifeDays,
    );

    expect(boostAt3d).toBeGreaterThan(boostAt7d);
    expect(boostAt7d).toBeGreaterThan(boostAt10d);
    expect(boostAt10d).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeActivationSpread
// ---------------------------------------------------------------------------

describe("computeActivationSpread", () => {
  test("returns empty map with no edges", () => {
    const result = computeActivationSpread(["a"], []);
    expect(result.size).toBe(0);
  });

  test("returns empty map with no start nodes", () => {
    const result = computeActivationSpread(
      [],
      [
        {
          id: "e1",
          sourceNodeId: "a",
          targetNodeId: "b",
          relationship: "reminds-of",
          weight: 1.0,
          created: Date.now(),
        },
      ],
    );
    expect(result.size).toBe(0);
  });

  test("spreads activation to direct neighbors", () => {
    const edges = [
      {
        id: "e1",
        sourceNodeId: "a",
        targetNodeId: "b",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
    ];
    const result = computeActivationSpread(["a"], edges, 1, 0.5);
    expect(result.has("b")).toBe(true);
    // weight: 1.0 × edgeWeight: 1.0 × decay: 0.5 = 0.5
    expect(result.get("b")).toBe(0.5);
  });

  test("does not include start nodes in output", () => {
    const edges = [
      {
        id: "e1",
        sourceNodeId: "a",
        targetNodeId: "b",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
    ];
    const result = computeActivationSpread(["a"], edges, 2, 0.5);
    expect(result.has("a")).toBe(false);
  });

  test("spreads bidirectionally", () => {
    const edges = [
      {
        id: "e1",
        sourceNodeId: "a",
        targetNodeId: "b",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
    ];
    // Start from b — should still reach a... except a is a start node? No, only b is start.
    // Wait, start from b, edge goes a→b, but it's bidirectional. So b→a is also traversable.
    // But we start from "b", so "b" is the start node. "a" is reachable.
    const result = computeActivationSpread(["b"], edges, 1, 0.5);
    expect(result.has("a")).toBe(true);
    expect(result.get("a")).toBe(0.5);
  });

  test("decays further with each hop", () => {
    const edges = [
      {
        id: "e1",
        sourceNodeId: "a",
        targetNodeId: "b",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
      {
        id: "e2",
        sourceNodeId: "b",
        targetNodeId: "c",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
    ];
    const result = computeActivationSpread(["a"], edges, 2, 0.5);
    // Hop 1: b gets 1.0 × 1.0 × 0.5 = 0.5
    expect(result.get("b")).toBe(0.5);
    // Hop 2: c gets 0.5 × 1.0 × 0.5 = 0.25
    expect(result.get("c")).toBe(0.25);
  });

  test("takes max activation across multiple paths", () => {
    const edges = [
      {
        id: "e1",
        sourceNodeId: "a",
        targetNodeId: "c",
        relationship: "reminds-of" as const,
        weight: 0.5,
        created: Date.now(),
      },
      {
        id: "e2",
        sourceNodeId: "b",
        targetNodeId: "c",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
    ];
    const result = computeActivationSpread(["a", "b"], edges, 1, 0.5);
    // From a: c gets 1.0 × 0.5 × 0.5 = 0.25
    // From b: c gets 1.0 × 1.0 × 0.5 = 0.5
    // Max wins: 0.5
    expect(result.get("c")).toBe(0.5);
  });

  test("edge weight scales activation", () => {
    const edges = [
      {
        id: "e1",
        sourceNodeId: "a",
        targetNodeId: "b",
        relationship: "reminds-of" as const,
        weight: 0.3,
        created: Date.now(),
      },
    ];
    const result = computeActivationSpread(["a"], edges, 1, 0.5);
    // 1.0 × 0.3 × 0.5 = 0.15
    expect(result.get("b")).toBeCloseTo(0.15, 10);
  });

  test("respects maxHops limit", () => {
    const edges = [
      {
        id: "e1",
        sourceNodeId: "a",
        targetNodeId: "b",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
      {
        id: "e2",
        sourceNodeId: "b",
        targetNodeId: "c",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
      {
        id: "e3",
        sourceNodeId: "c",
        targetNodeId: "d",
        relationship: "reminds-of" as const,
        weight: 1.0,
        created: Date.now(),
      },
    ];
    const result = computeActivationSpread(["a"], edges, 1, 0.5);
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(false);
    expect(result.has("d")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate
// ---------------------------------------------------------------------------

describe("scoreCandidate", () => {
  test("returns weighted sum of all components", () => {
    const node = makeNode();
    const components = {
      semanticSimilarity: 1.0,
      effectiveSignificance: 1.0,
      emotionalIntensity: 1.0,
      temporalBoost: 1.0,
      recencyBoost: 1.0,
      triggerBoost: 1.0,
      activationBoost: 1.0,
    };
    const result = scoreCandidate(node, components);
    // With default weights summing to 1.0, score should be 1.0
    expect(result.score).toBeCloseTo(1.0, 5);
    expect(result.node).toBe(node);
    expect(result.scoreBreakdown).toBe(components);
  });

  test("returns 0 when all components are 0", () => {
    const node = makeNode();
    const components = {
      semanticSimilarity: 0,
      effectiveSignificance: 0,
      emotionalIntensity: 0,
      temporalBoost: 0,
      recencyBoost: 0,
      triggerBoost: 0,
      activationBoost: 0,
    };
    const result = scoreCandidate(node, components);
    expect(result.score).toBe(0);
  });

  test("clamps negative temporalBoost to 0", () => {
    const node = makeNode();
    const components = {
      semanticSimilarity: 0,
      effectiveSignificance: 0,
      emotionalIntensity: 0,
      temporalBoost: -0.5,
      recencyBoost: 0,
      triggerBoost: 0,
      activationBoost: 0,
    };
    const result = scoreCandidate(node, components);
    // temporalBoost is clamped to 0 via Math.max(0, ...)
    expect(result.score).toBe(0);
  });

  test("uses custom weights when provided", () => {
    const node = makeNode();
    const components = {
      semanticSimilarity: 1.0,
      effectiveSignificance: 0,
      emotionalIntensity: 0,
      temporalBoost: 0,
      recencyBoost: 0,
      triggerBoost: 0,
      activationBoost: 0,
    };
    const customWeights: ScoringWeights = {
      semanticSimilarity: 0.5,
      effectiveSignificance: 0,
      emotionalIntensity: 0,
      temporalBoost: 0,
      recencyBoost: 0,
      triggerBoost: 0,
      activationBoost: 0,
    };
    const result = scoreCandidate(node, components, customWeights);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  test("PER_TURN_WEIGHTS heavily favor semantic similarity", () => {
    const node = makeNode();
    const components = {
      semanticSimilarity: 1.0,
      effectiveSignificance: 0,
      emotionalIntensity: 0,
      temporalBoost: 0,
      recencyBoost: 0,
      triggerBoost: 0,
      activationBoost: 0,
    };
    const result = scoreCandidate(node, components, PER_TURN_WEIGHTS);
    expect(result.score).toBe(0.6);
  });

  test("preserves scoreBreakdown for debugging", () => {
    const node = makeNode();
    const components = {
      semanticSimilarity: 0.9,
      effectiveSignificance: 0.7,
      emotionalIntensity: 0.3,
      temporalBoost: 0.1,
      recencyBoost: 0.5,
      triggerBoost: 0,
      activationBoost: 0.2,
    };
    const result = scoreCandidate(node, components);
    expect(result.scoreBreakdown.semanticSimilarity).toBe(0.9);
    expect(result.scoreBreakdown.effectiveSignificance).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// weightsForContextLoad + PROCEDURAL_WEIGHTS
// ---------------------------------------------------------------------------

describe("weightsForContextLoad", () => {
  test("returns PROCEDURAL_WEIGHTS for procedural nodes", () => {
    const node = makeNode({ type: "procedural" });
    expect(weightsForContextLoad(node)).toBe(PROCEDURAL_WEIGHTS);
  });

  test("returns DEFAULT_WEIGHTS for episodic nodes", () => {
    const node = makeNode({ type: "episodic" });
    expect(weightsForContextLoad(node)).toBe(DEFAULT_WEIGHTS);
  });

  test("returns DEFAULT_WEIGHTS for semantic/emotional/prospective/behavioral/narrative/shared nodes", () => {
    for (const type of [
      "semantic",
      "emotional",
      "prospective",
      "behavioral",
      "narrative",
      "shared",
    ] as const) {
      const node = makeNode({ type });
      expect(weightsForContextLoad(node)).toBe(DEFAULT_WEIGHTS);
    }
  });
});

describe("PROCEDURAL_WEIGHTS", () => {
  test("weights sum to 1.0", () => {
    const sum =
      PROCEDURAL_WEIGHTS.semanticSimilarity +
      PROCEDURAL_WEIGHTS.effectiveSignificance +
      PROCEDURAL_WEIGHTS.emotionalIntensity +
      PROCEDURAL_WEIGHTS.temporalBoost +
      PROCEDURAL_WEIGHTS.recencyBoost +
      PROCEDURAL_WEIGHTS.triggerBoost +
      PROCEDURAL_WEIGHTS.activationBoost;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  test("zeroes out emotionalIntensity and temporalBoost", () => {
    // Procedural memories have no emotional charge and no time-of-day pattern
    // by nature — grading on these signals is just dead weight.
    expect(PROCEDURAL_WEIGHTS.emotionalIntensity).toBe(0);
    expect(PROCEDURAL_WEIGHTS.temporalBoost).toBe(0);
  });

  test("weights semanticSimilarity and effectiveSignificance more heavily than DEFAULT_WEIGHTS", () => {
    expect(PROCEDURAL_WEIGHTS.semanticSimilarity).toBeGreaterThan(
      DEFAULT_WEIGHTS.semanticSimilarity,
    );
    expect(PROCEDURAL_WEIGHTS.effectiveSignificance).toBeGreaterThan(
      DEFAULT_WEIGHTS.effectiveSignificance,
    );
  });

  test("procedural node outscores otherwise-identical episodic node under type-aware weights", () => {
    // A procedural memory with zero emotional charge, zero recency, zero
    // trigger — all dead signals — should still surface under PROCEDURAL_WEIGHTS
    // thanks to semantic relevance and significance. Under DEFAULT_WEIGHTS the
    // same signals would leave ~45% of the budget dead.
    const proceduralNode = makeNode({ type: "procedural" });
    const episodicNode = makeNode({ id: "node-2", type: "episodic" });

    // Components a procedural memory typically carries: semantic hit + stable
    // significance, but no emotional charge, no recency, no trigger.
    const proceduralComponents = {
      semanticSimilarity: 0.8,
      effectiveSignificance: 0.7,
      emotionalIntensity: 0,
      temporalBoost: 0.5, // neutral
      recencyBoost: 0,
      triggerBoost: 0,
      activationBoost: 0,
    };

    const proceduralScore = scoreCandidate(
      proceduralNode,
      proceduralComponents,
      weightsForContextLoad(proceduralNode),
    ).score;
    const episodicScore = scoreCandidate(
      episodicNode,
      proceduralComponents,
      weightsForContextLoad(episodicNode),
    ).score;

    expect(proceduralScore).toBeGreaterThan(episodicScore);
  });

  test("episodic node with full signal still outscores procedural with only semantic signal", () => {
    // The change must NOT break episodic retrieval: an episodic memory with
    // emotional charge + recency + moderate significance should still outrank
    // a procedural memory that only has semantic relevance.
    const episodicNode = makeNode({ type: "episodic" });
    const proceduralNode = makeNode({ id: "node-2", type: "procedural" });

    const episodicComponents = {
      semanticSimilarity: 0.5,
      effectiveSignificance: 0.6,
      emotionalIntensity: 0.7,
      temporalBoost: 0.6,
      recencyBoost: 0.9,
      triggerBoost: 0.4,
      activationBoost: 0.3,
    };

    const proceduralComponents = {
      semanticSimilarity: 0.5,
      effectiveSignificance: 0.3,
      emotionalIntensity: 0,
      temporalBoost: 0.5,
      recencyBoost: 0,
      triggerBoost: 0,
      activationBoost: 0,
    };

    const episodicScore = scoreCandidate(
      episodicNode,
      episodicComponents,
      weightsForContextLoad(episodicNode),
    ).score;
    const proceduralScore = scoreCandidate(
      proceduralNode,
      proceduralComponents,
      weightsForContextLoad(proceduralNode),
    ).score;

    expect(episodicScore).toBeGreaterThan(proceduralScore);
  });
});

// ---------------------------------------------------------------------------
// Regression: DEFAULT_WEIGHTS behavior unchanged
// ---------------------------------------------------------------------------

describe("DEFAULT_WEIGHTS (regression)", () => {
  test("weights sum to 1.0", () => {
    const sum =
      DEFAULT_WEIGHTS.semanticSimilarity +
      DEFAULT_WEIGHTS.effectiveSignificance +
      DEFAULT_WEIGHTS.emotionalIntensity +
      DEFAULT_WEIGHTS.temporalBoost +
      DEFAULT_WEIGHTS.recencyBoost +
      DEFAULT_WEIGHTS.triggerBoost +
      DEFAULT_WEIGHTS.activationBoost;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  test("preserves exact weight values", () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      semanticSimilarity: 0.25,
      effectiveSignificance: 0.15,
      emotionalIntensity: 0.15,
      temporalBoost: 0.05,
      recencyBoost: 0.15,
      triggerBoost: 0.15,
      activationBoost: 0.1,
    });
  });

  test("scoreCandidate without weights argument uses DEFAULT_WEIGHTS", () => {
    // Backwards-compat: existing callers that pass no weights argument should
    // continue to get DEFAULT_WEIGHTS scoring.
    const node = makeNode({ type: "episodic" });
    const components = {
      semanticSimilarity: 1.0,
      effectiveSignificance: 1.0,
      emotionalIntensity: 1.0,
      temporalBoost: 1.0,
      recencyBoost: 1.0,
      triggerBoost: 1.0,
      activationBoost: 1.0,
    };
    const implicit = scoreCandidate(node, components).score;
    const explicit = scoreCandidate(node, components, DEFAULT_WEIGHTS).score;
    expect(implicit).toBe(explicit);
  });
});

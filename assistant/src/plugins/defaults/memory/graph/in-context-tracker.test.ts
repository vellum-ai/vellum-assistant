import { describe, expect, test } from "bun:test";

import { InContextTracker } from "./in-context-tracker.js";
import type { MemoryNode, ScoredNode } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 1000 * 60 * 60 * 24;

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "node-1",
    content: "Test memory content.",
    type: "episodic",
    created: Date.now() - 5 * DAY_MS,
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
    ...overrides,
  };
}

function makeScored(nodeOverrides: Partial<MemoryNode> = {}): ScoredNode {
  return {
    node: makeNode(nodeOverrides),
    score: 0.5,
    scoreBreakdown: {
      semanticSimilarity: 0.5,
      effectiveSignificance: 0.5,
      emotionalIntensity: 0,
      temporalBoost: 0,
      recencyBoost: 0.5,
      triggerBoost: 0,
      activationBoost: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// InContextTracker
// ---------------------------------------------------------------------------

describe("InContextTracker", () => {
  test("tracks added node IDs", () => {
    const tracker = new InContextTracker();
    tracker.add(["a", "b"]);
    expect(tracker.isInContext("a")).toBe(true);
    expect(tracker.isInContext("b")).toBe(true);
    expect(tracker.isInContext("c")).toBe(false);
  });

  test("filters out nodes already in context", () => {
    const tracker = new InContextTracker();
    tracker.add(["a"]);

    const candidates: ScoredNode[] = [
      makeScored({ id: "a" }),
      makeScored({ id: "b" }),
      makeScored({ id: "c" }),
    ];
    const filtered = tracker.filterNew(candidates);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((c) => c.node.id)).toEqual(["b", "c"]);
  });

  test("advances turn counter", () => {
    const tracker = new InContextTracker();
    expect(tracker.getTurn()).toBe(0);
    tracker.advanceTurn();
    expect(tracker.getTurn()).toBe(1);
    tracker.advanceTurn();
    expect(tracker.getTurn()).toBe(2);
  });

  test("records injection log with turn numbers", () => {
    const tracker = new InContextTracker();
    tracker.add(["a"]);
    tracker.advanceTurn();
    tracker.add(["b"]);

    const log = tracker.getLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({ nodeId: "a", turn: 0 });
    expect(log[1]).toEqual({ nodeId: "b", turn: 1 });
  });

  test("returns all active node IDs", () => {
    const tracker = new InContextTracker();
    tracker.add(["a", "b"]);
    tracker.advanceTurn();
    tracker.add(["c"]);

    const active = tracker.getActiveNodeIds();
    expect(active.sort()).toEqual(["a", "b", "c"]);
  });

  test("evicts compacted turns", () => {
    const tracker = new InContextTracker();
    tracker.add(["a"]);
    tracker.advanceTurn();
    tracker.add(["b"]);
    tracker.advanceTurn();
    tracker.add(["c"]);

    // Evict turns 0 and 1
    tracker.evictCompactedTurns(1);

    expect(tracker.isInContext("a")).toBe(false);
    expect(tracker.isInContext("b")).toBe(false);
    expect(tracker.isInContext("c")).toBe(true);
  });

  test("keeps nodes that appear in both compacted and non-compacted turns", () => {
    const tracker = new InContextTracker();
    tracker.add(["a"]);
    tracker.advanceTurn();
    tracker.add(["a"]); // same node re-injected in turn 1

    // Evict turn 0 only
    tracker.evictCompactedTurns(0);

    // "a" should still be in context because it was also injected in turn 1
    expect(tracker.isInContext("a")).toBe(true);
  });

  test("eviction cleans up log entries", () => {
    const tracker = new InContextTracker();
    tracker.add(["a"]);
    tracker.advanceTurn();
    tracker.add(["b"]);

    tracker.evictCompactedTurns(0);

    const log = tracker.getLog();
    expect(log).toHaveLength(1);
    expect(log[0].nodeId).toBe("b");
  });

  test("evicting with upToTurn=0 only evicts turn 0", () => {
    const tracker = new InContextTracker();
    tracker.add(["a"]);
    tracker.advanceTurn();
    tracker.add(["b"]);
    tracker.advanceTurn();
    tracker.add(["c"]);

    tracker.evictCompactedTurns(0);

    expect(tracker.isInContext("a")).toBe(false);
    expect(tracker.isInContext("b")).toBe(true);
    expect(tracker.isInContext("c")).toBe(true);
  });
});

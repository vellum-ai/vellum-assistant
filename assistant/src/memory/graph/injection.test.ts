import { describe, expect, test } from "bun:test";

import {
  assembleContextBlock,
  assembleInjectionBlock,
  formatEventDate,
  InContextTracker,
} from "./injection.js";
import type { MemoryNode, ScoredNode } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 1000 * 60 * 60 * 24;
const HOUR_MS = 1000 * 60 * 60;

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
    scopeId: "default",
    ...overrides,
  };
}

function makeScored(
  nodeOverrides: Partial<MemoryNode> = {},
  scoreOverrides: Partial<ScoredNode["scoreBreakdown"]> = {},
): ScoredNode {
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
      ...scoreOverrides,
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

// ---------------------------------------------------------------------------
// assembleContextBlock
// ---------------------------------------------------------------------------

describe("assembleContextBlock", () => {
  test("returns empty string for no nodes", () => {
    expect(assembleContextBlock([])).toBe("");
  });

  test("omits the legacy `What I Remember Right Now` heading", () => {
    const result = assembleContextBlock([makeScored()]);
    expect(result).not.toContain("## What I Remember Right Now");
  });

  test("puts prospective nodes under Active Threads", () => {
    const result = assembleContextBlock([
      makeScored({ type: "prospective", content: "Deploy the service." }),
    ]);
    expect(result).toContain("### Active Threads");
    expect(result).toContain("Deploy the service.");
  });

  test("puts trigger-boosted nodes under What Today Means", () => {
    const result = assembleContextBlock([
      makeScored({ content: "Anniversary today." }, { triggerBoost: 0.5 }),
    ]);
    expect(result).toContain("### What Today Means");
    expect(result).toContain("Anniversary today.");
  });

  test("puts recent emotional nodes under Right Now", () => {
    const result = assembleContextBlock([
      makeScored({
        type: "emotional",
        content: "Feeling great about the launch.",
        created: Date.now() - HOUR_MS, // 1 hour ago, within 2-day recency
      }),
    ]);
    expect(result).toContain("### Right Now");
    expect(result).toContain("Feeling great about the launch.");
  });

  test("puts very recent non-emotional nodes under Right Now", () => {
    const result = assembleContextBlock([
      makeScored({
        type: "episodic",
        content: "Just finished the meeting.",
        created: Date.now() - HOUR_MS, // 1 hour ago, within 4-hour very-recent window
      }),
    ]);
    expect(result).toContain("### Right Now");
    expect(result).toContain("Just finished the meeting.");
  });

  test("puts older general nodes under On My Mind", () => {
    const result = assembleContextBlock([
      makeScored({
        type: "semantic",
        content: "User works at Acme Corp.",
        created: Date.now() - 30 * DAY_MS,
      }),
    ]);
    expect(result).toContain("### On My Mind");
    expect(result).toContain("User works at Acme Corp.");
  });

  test("includes serendipity section when provided", () => {
    const result = assembleContextBlock([], {
      serendipityNodes: [makeScored({ content: "Random old memory." })],
    });
    expect(result).toContain("### Serendipity");
    expect(result).toContain("Random old memory.");
  });

  test("formats nodes with relative age", () => {
    const result = assembleContextBlock([
      makeScored({
        content: "Something happened.",
        created: Date.now() - 5 * DAY_MS,
      }),
    ]);
    expect(result).toContain("5d ago");
  });

  test("limits Active Threads to 5 entries", () => {
    const nodes = Array.from({ length: 8 }, (_, i) =>
      makeScored({
        id: `p-${i}`,
        type: "prospective",
        content: `Task ${i}.`,
      }),
    );
    const result = assembleContextBlock(nodes);
    // Count how many "Task" entries appear in Active Threads
    const threadSection = result
      .split("### Active Threads")[1]
      ?.split("###")[0];
    const taskMatches = threadSection?.match(/Task \d+\./g) ?? [];
    expect(taskMatches.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// assembleInjectionBlock
// ---------------------------------------------------------------------------

describe("assembleInjectionBlock", () => {
  test("returns empty string for no nodes", () => {
    expect(assembleInjectionBlock([])).toBe("");
  });

  test("formats each node as a bullet with age", () => {
    const result = assembleInjectionBlock([
      makeScored({
        content: "Memory A.",
        created: Date.now() - 3 * DAY_MS,
      }),
      makeScored({
        id: "node-2",
        content: "Memory B.",
        created: Date.now() - 10 * DAY_MS,
      }),
    ]);
    expect(result).toContain("- (3d ago) Memory A.");
    expect(result).toContain("- (10d ago) Memory B.");
  });

  test("joins multiple entries with newlines", () => {
    const result = assembleInjectionBlock([
      makeScored({ content: "A." }),
      makeScored({ id: "node-2", content: "B." }),
    ]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Upcoming section
// ---------------------------------------------------------------------------

describe("assembleContextBlock — Upcoming section", () => {
  test("node with future eventDate appears in Upcoming, not On My Mind", () => {
    const futureDate = Date.now() + 3 * DAY_MS;
    const result = assembleContextBlock([
      makeScored({
        content: "Doctor appointment.",
        eventDate: futureDate,
        created: Date.now() - 2 * DAY_MS,
      }),
    ]);
    expect(result).toContain("### Upcoming");
    expect(result).toContain("Doctor appointment.");
    expect(result).not.toContain("### On My Mind");
  });

  test("upcoming nodes are sorted by eventDate ascending (soonest first)", () => {
    const result = assembleContextBlock([
      makeScored({
        id: "far",
        content: "Far event.",
        eventDate: Date.now() + 10 * DAY_MS,
        created: Date.now() - DAY_MS,
      }),
      makeScored({
        id: "near",
        content: "Near event.",
        eventDate: Date.now() + 2 * DAY_MS,
        created: Date.now() - DAY_MS,
      }),
      makeScored({
        id: "mid",
        content: "Mid event.",
        eventDate: Date.now() + 5 * DAY_MS,
        created: Date.now() - DAY_MS,
      }),
    ]);
    const upcomingSection = result.split("### Upcoming")[1]?.split("###")[0];
    expect(upcomingSection).toBeDefined();
    const nearIdx = upcomingSection!.indexOf("Near event.");
    const midIdx = upcomingSection!.indexOf("Mid event.");
    const farIdx = upcomingSection!.indexOf("Far event.");
    expect(nearIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(farIdx);
  });

  test("node with future eventDate AND triggerBoost > 0 goes to What Today Means, not Upcoming", () => {
    const futureDate = Date.now() + DAY_MS;
    const result = assembleContextBlock([
      makeScored(
        {
          content: "Birthday party tomorrow.",
          eventDate: futureDate,
          created: Date.now() - 5 * DAY_MS,
        },
        { triggerBoost: 0.5 },
      ),
    ]);
    expect(result).toContain("### What Today Means");
    expect(result).toContain("Birthday party tomorrow.");
    expect(result).not.toContain("### Upcoming");
  });

  test("node with past eventDate goes to On My Mind, not Upcoming", () => {
    const pastDate = Date.now() - 2 * DAY_MS;
    const result = assembleContextBlock([
      makeScored({
        content: "Concert last week.",
        eventDate: pastDate,
        created: Date.now() - 10 * DAY_MS,
      }),
    ]);
    expect(result).toContain("### On My Mind");
    expect(result).toContain("Concert last week.");
    expect(result).not.toContain("### Upcoming");
  });
});

// ---------------------------------------------------------------------------
// formatEventDate
// ---------------------------------------------------------------------------

describe("formatEventDate", () => {
  test("formats a date happening today with (today) relative", () => {
    // Use noon today to have a time component
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const result = formatEventDate(today.getTime());
    expect(result).toContain("(today)");
    expect(result).toContain("12:00 PM");
  });

  test("formats a date happening tomorrow with (tomorrow) relative", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const result = formatEventDate(tomorrow.getTime());
    expect(result).toContain("(tomorrow)");
    expect(result).toContain("9:00 AM");
  });

  test("formats a date several days out with (in Xd) relative", () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    future.setHours(0, 0, 0, 0); // midnight = date-only
    const result = formatEventDate(future.getTime());
    expect(result).toContain("(in 5d)");
    // Midnight should not include a time part
    expect(result).not.toMatch(/\d+:\d+ [AP]M/);
  });

  test("formats a date with non-zero minutes correctly", () => {
    const future = new Date();
    future.setDate(future.getDate() + 3);
    future.setHours(14, 30, 0, 0);
    const result = formatEventDate(future.getTime());
    expect(result).toContain("2:30 PM");
    expect(result).toContain("(in 3d)");
  });

  test("formats weeks-out dates with (in Xw) relative", () => {
    const future = new Date();
    future.setDate(future.getDate() + 21);
    future.setHours(0, 0, 0, 0);
    const result = formatEventDate(future.getTime());
    expect(result).toContain("(in 3w)");
  });

  test("formats months-out dates with (in Xmo) relative", () => {
    const future = new Date();
    future.setDate(future.getDate() + 90);
    future.setHours(0, 0, 0, 0);
    const result = formatEventDate(future.getTime());
    expect(result).toContain("(in 3mo)");
  });

  // --- Past date handling ---

  test("yesterday (diffDays === -1) shows (today)", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const result = formatEventDate(yesterday.getTime());
    expect(result).toContain("(today)");
  });

  test("2 days ago shows (2d ago)", () => {
    const past = new Date();
    past.setDate(past.getDate() - 2);
    past.setHours(0, 0, 0, 0);
    const result = formatEventDate(past.getTime());
    expect(result).toContain("(2d ago)");
  });

  test("10 days ago shows (10d ago)", () => {
    const past = new Date();
    past.setDate(past.getDate() - 10);
    past.setHours(0, 0, 0, 0);
    const result = formatEventDate(past.getTime());
    expect(result).toContain("(10d ago)");
  });

  test("3 weeks ago shows (3w ago)", () => {
    const past = new Date();
    past.setDate(past.getDate() - 21);
    past.setHours(0, 0, 0, 0);
    const result = formatEventDate(past.getTime());
    expect(result).toContain("(3w ago)");
  });

  test("3 months ago shows (3mo ago)", () => {
    const past = new Date();
    past.setDate(past.getDate() - 90);
    past.setHours(0, 0, 0, 0);
    const result = formatEventDate(past.getTime());
    expect(result).toContain("(3mo ago)");
  });

  test("never produces 'in -' for any past date", () => {
    for (let d = -1; d >= -365; d -= 7) {
      const past = new Date();
      past.setDate(past.getDate() + d);
      past.setHours(0, 0, 0, 0);
      const result = formatEventDate(past.getTime());
      expect(result).not.toContain("in -");
    }
  });
});

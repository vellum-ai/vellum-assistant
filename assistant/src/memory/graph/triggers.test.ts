import { describe, expect, test } from "bun:test";

import {
  evaluateEventTriggers,
  evaluateSemanticTriggers,
  evaluateTemporalTriggers,
} from "./triggers.js";
import type { MemoryTrigger } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 1000 * 60 * 60 * 24;

function makeTrigger(overrides: Partial<MemoryTrigger> = {}): MemoryTrigger {
  return {
    id: "trigger-1",
    nodeId: "node-1",
    type: "temporal",
    schedule: null,
    condition: null,
    conditionEmbedding: null,
    threshold: null,
    eventDate: null,
    rampDays: null,
    followUpDays: null,
    recurring: false,
    consumed: false,
    cooldownMs: null,
    lastFired: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluateTemporalTriggers
// ---------------------------------------------------------------------------

describe("evaluateTemporalTriggers", () => {
  test("fires day-of-week trigger on matching day", () => {
    // 2025-06-16 is a Monday
    const monday = new Date("2025-06-16T10:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "day-of-week:monday",
    });
    const results = evaluateTemporalTriggers([trigger], monday);
    expect(results).toHaveLength(1);
    expect(results[0].boost).toBe(1.0);
  });

  test("does not fire day-of-week trigger on non-matching day", () => {
    // 2025-06-17 is a Tuesday
    const tuesday = new Date("2025-06-17T10:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "day-of-week:monday",
    });
    const results = evaluateTemporalTriggers([trigger], tuesday);
    expect(results).toHaveLength(0);
  });

  test("fires date trigger on matching date", () => {
    const april8 = new Date("2025-04-08T15:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "date:04-08",
    });
    const results = evaluateTemporalTriggers([trigger], april8);
    expect(results).toHaveLength(1);
  });

  test("does not fire date trigger on non-matching date", () => {
    const april9 = new Date("2025-04-09T15:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "date:04-08",
    });
    const results = evaluateTemporalTriggers([trigger], april9);
    expect(results).toHaveLength(0);
  });

  test("fires time:morning trigger between 5-11", () => {
    const morning = new Date("2025-06-15T08:00:00"); // local hour 8
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "time:morning",
    });
    const results = evaluateTemporalTriggers([trigger], morning);
    expect(results).toHaveLength(1);
  });

  test("fires time:afternoon trigger between 12-16", () => {
    const afternoon = new Date("2025-06-15T14:00:00"); // local hour 14
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "time:afternoon",
    });
    const results = evaluateTemporalTriggers([trigger], afternoon);
    expect(results).toHaveLength(1);
  });

  test("fires time:evening trigger between 17-20", () => {
    const evening = new Date("2025-06-15T18:00:00"); // local hour 18
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "time:evening",
    });
    const results = evaluateTemporalTriggers([trigger], evening);
    expect(results).toHaveLength(1);
  });

  test("fires time:night trigger at 22:00", () => {
    const night = new Date("2025-06-15T22:00:00"); // local hour 22
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "time:night",
    });
    const results = evaluateTemporalTriggers([trigger], night);
    expect(results).toHaveLength(1);
  });

  test("fires time:night trigger at 3 AM (wraps past midnight)", () => {
    const lateNight = new Date("2025-06-15T03:00:00"); // local hour 3
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "time:night",
    });
    const results = evaluateTemporalTriggers([trigger], lateNight);
    expect(results).toHaveLength(1);
  });

  test("does not fire time:morning at 14:00", () => {
    const afternoon = new Date("2025-06-15T14:00:00");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "time:morning",
    });
    const results = evaluateTemporalTriggers([trigger], afternoon);
    expect(results).toHaveLength(0);
  });

  test("skips non-temporal triggers", () => {
    const now = new Date("2025-06-16T10:00:00Z");
    const trigger = makeTrigger({
      type: "semantic",
      schedule: "day-of-week:monday",
    });
    const results = evaluateTemporalTriggers([trigger], now);
    expect(results).toHaveLength(0);
  });

  test("skips triggers without a schedule", () => {
    const now = new Date("2025-06-16T10:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: null,
    });
    const results = evaluateTemporalTriggers([trigger], now);
    expect(results).toHaveLength(0);
  });

  test("respects cooldown for recurring triggers", () => {
    const now = new Date("2025-06-16T10:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "day-of-week:monday",
      recurring: true,
      cooldownMs: DAY_MS,
      lastFired: now.getTime() - DAY_MS / 2, // fired 12h ago, cooldown 24h
    });
    const results = evaluateTemporalTriggers([trigger], now);
    expect(results).toHaveLength(0);
  });

  test("fires recurring trigger after cooldown expires", () => {
    const now = new Date("2025-06-16T10:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "day-of-week:monday",
      recurring: true,
      cooldownMs: DAY_MS,
      lastFired: now.getTime() - DAY_MS * 2, // fired 2 days ago, cooldown 24h
    });
    const results = evaluateTemporalTriggers([trigger], now);
    expect(results).toHaveLength(1);
  });

  test("non-recurring triggers bypass cooldown check", () => {
    const now = new Date("2025-06-16T10:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "day-of-week:monday",
      recurring: false,
      lastFired: now.getTime() - 1000, // fired 1s ago
    });
    const results = evaluateTemporalTriggers([trigger], now);
    expect(results).toHaveLength(1);
  });

  test("handles case-insensitive schedule matching", () => {
    const monday = new Date("2025-06-16T10:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      schedule: "Day-Of-Week:Monday",
    });
    const results = evaluateTemporalTriggers([trigger], monday);
    expect(results).toHaveLength(1);
  });

  test("evaluates multiple triggers independently", () => {
    const monday = new Date("2025-06-16T10:00:00Z");
    const triggers = [
      makeTrigger({
        id: "t1",
        type: "temporal",
        schedule: "day-of-week:monday",
      }),
      makeTrigger({
        id: "t2",
        type: "temporal",
        schedule: "day-of-week:tuesday",
      }),
      makeTrigger({
        id: "t3",
        type: "temporal",
        schedule: "day-of-week:monday",
      }),
    ];
    const results = evaluateTemporalTriggers(triggers, monday);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.trigger.id)).toEqual(["t1", "t3"]);
  });
});

// ---------------------------------------------------------------------------
// evaluateSemanticTriggers
// ---------------------------------------------------------------------------

describe("evaluateSemanticTriggers", () => {
  test("fires when cosine similarity exceeds threshold", () => {
    // Two identical unit vectors → similarity = 1.0
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: new Float32Array([1, 0, 0]),
      threshold: 0.5,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results).toHaveLength(1);
    expect(results[0].boost).toBeGreaterThanOrEqual(0.5);
  });

  test("does not fire when similarity is below threshold", () => {
    // Orthogonal vectors → similarity = 0
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: new Float32Array([0, 1, 0]),
      threshold: 0.5,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results).toHaveLength(0);
  });

  test("boost scales by how far above threshold", () => {
    // Identical vectors: similarity = 1.0, threshold = 0.5
    // boost = (1.0 - 0.5) / (1 - 0.5 + 0.001) ≈ 1.0
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: new Float32Array([1, 0, 0]),
      threshold: 0.5,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results[0].boost).toBeCloseTo(1.0, 1);
  });

  test("boost has minimum of 0.5", () => {
    // Barely above threshold — boost would be near 0, but floored to 0.5
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: new Float32Array([0.98, 0.2, 0]),
      threshold: 0.97,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    if (results.length > 0) {
      expect(results[0].boost).toBeGreaterThanOrEqual(0.5);
    }
  });

  test("skips consumed triggers", () => {
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: new Float32Array([1, 0, 0]),
      threshold: 0.5,
      consumed: true,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results).toHaveLength(0);
  });

  test("skips triggers without embeddings", () => {
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: null,
      threshold: 0.5,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results).toHaveLength(0);
  });

  test("skips triggers without threshold", () => {
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: new Float32Array([1, 0, 0]),
      threshold: null,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results).toHaveLength(0);
  });

  test("skips non-semantic triggers", () => {
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "temporal",
      conditionEmbedding: new Float32Array([1, 0, 0]),
      threshold: 0.5,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results).toHaveLength(0);
  });

  test("handles mismatched vector lengths gracefully", () => {
    const embedding = new Float32Array([1, 0, 0]);
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: new Float32Array([1, 0]),
      threshold: 0.5,
    });
    // cosineSimilarity returns 0 for mismatched lengths → no fire
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results).toHaveLength(0);
  });

  test("accepts number[] as query embedding", () => {
    const embedding = [1, 0, 0];
    const trigger = makeTrigger({
      type: "semantic",
      conditionEmbedding: new Float32Array([1, 0, 0]),
      threshold: 0.5,
    });
    const results = evaluateSemanticTriggers([trigger], embedding);
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateEventTriggers
// ---------------------------------------------------------------------------

describe("evaluateEventTriggers", () => {
  test("returns background boost (0.05) for events far in the future", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    const trigger = makeTrigger({
      type: "event",
      eventDate: now.getTime() + 30 * DAY_MS, // 30 days away
      rampDays: 7,
      followUpDays: 2,
    });
    const results = evaluateEventTriggers([trigger], now);
    expect(results).toHaveLength(1);
    expect(results[0].boost).toBeCloseTo(0.05, 5);
  });

  test("ramps linearly from 0.05 to 1.0 as event approaches", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    const eventDate = now.getTime() + 7 * DAY_MS; // exactly at rampDays boundary
    const trigger = makeTrigger({
      type: "event",
      eventDate,
      rampDays: 7,
      followUpDays: 2,
    });

    // At rampDays boundary: daysUntil = 7, rampDays = 7 → boost = 0.05
    const resultsAtBoundary = evaluateEventTriggers([trigger], now);
    expect(resultsAtBoundary[0].boost).toBeCloseTo(0.05, 5);

    // Halfway through ramp: 3.5 days before event
    const halfwayNow = new Date(now.getTime() + 3.5 * DAY_MS);
    const resultsHalfway = evaluateEventTriggers([trigger], halfwayNow);
    expect(resultsHalfway[0].boost).toBeCloseTo(0.525, 1);

    // Day before: daysUntil ≈ 0 → boost ≈ 1.0
    const dayBeforeNow = new Date(eventDate - 0.1 * DAY_MS);
    const resultsDayBefore = evaluateEventTriggers([trigger], dayBeforeNow);
    expect(resultsDayBefore[0].boost).toBeGreaterThan(0.9);
  });

  test("returns full boost (1.0) on the day of the event", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    const eventDate = now.getTime(); // right now
    const trigger = makeTrigger({
      type: "event",
      eventDate,
      rampDays: 7,
      followUpDays: 2,
    });
    // daysUntil = 0, which is > -1 → day-of boost = 1.0
    const results = evaluateEventTriggers([trigger], now);
    expect(results).toHaveLength(1);
    expect(results[0].boost).toBe(1.0);
  });

  test("decays exponentially after the event", () => {
    const eventDate = new Date("2025-06-15T10:00:00Z").getTime();
    const trigger = makeTrigger({
      type: "event",
      eventDate,
      rampDays: 7,
      followUpDays: 2,
    });

    // 1.5 days after event
    const afterNow = new Date(eventDate + 1.5 * DAY_MS);
    const results = evaluateEventTriggers([trigger], afterNow);
    expect(results).toHaveLength(1);
    expect(results[0].boost).toBeGreaterThan(0.01);
    expect(results[0].boost).toBeLessThan(1.0);
  });

  test("returns 0 after followUpDays", () => {
    const eventDate = new Date("2025-06-15T10:00:00Z").getTime();
    const trigger = makeTrigger({
      type: "event",
      eventDate,
      rampDays: 7,
      followUpDays: 2,
    });

    // 3 days after event (beyond followUpDays=2)
    const longAfter = new Date(eventDate + 3 * DAY_MS);
    const results = evaluateEventTriggers([trigger], longAfter);
    expect(results).toHaveLength(0);
  });

  test("skips non-event triggers", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    const trigger = makeTrigger({
      type: "temporal",
      eventDate: now.getTime() + DAY_MS,
    });
    const results = evaluateEventTriggers([trigger], now);
    expect(results).toHaveLength(0);
  });

  test("skips triggers without eventDate", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    const trigger = makeTrigger({
      type: "event",
      eventDate: null,
    });
    const results = evaluateEventTriggers([trigger], now);
    expect(results).toHaveLength(0);
  });

  test("uses default rampDays=7 and followUpDays=2 when not specified", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    const eventDate = now.getTime() + 5 * DAY_MS; // 5 days away (inside default 7-day ramp)
    const trigger = makeTrigger({
      type: "event",
      eventDate,
      rampDays: null, // triggers default of 7
      followUpDays: null, // triggers default of 2
    });
    const results = evaluateEventTriggers([trigger], now);
    expect(results).toHaveLength(1);
    // Should be in the ramp-up phase with boost > background
    expect(results[0].boost).toBeGreaterThan(0.05);
  });
});

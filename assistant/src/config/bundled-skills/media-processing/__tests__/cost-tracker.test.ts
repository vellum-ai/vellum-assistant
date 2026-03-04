import { describe, expect, it } from "bun:test";

import { CostTracker } from "../services/cost-tracker.js";

describe("CostTracker", () => {
  it("accumulates costs across multiple segments", () => {
    const tracker = new CostTracker();

    tracker.record({
      segmentId: "seg-001",
      model: "gemini-2.5-flash",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });

    tracker.record({
      segmentId: "seg-002",
      model: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 1_000_000,
    });

    const summary = tracker.getSummary();
    expect(summary.segmentCount).toBe(2);
    expect(summary.totalInputTokens).toBe(1_000_000);
    expect(summary.totalOutputTokens).toBe(1_000_000);
    // $0.15 for 1M input + $0.60 for 1M output = $0.75
    expect(summary.totalEstimatedUSD).toBeCloseTo(0.75, 6);
  });

  it("computes per-entry costs using Gemini 2.5 Flash pricing", () => {
    const tracker = new CostTracker();

    const entry = tracker.record({
      segmentId: "seg-010",
      model: "gemini-2.5-flash",
      inputTokens: 200_000,
      outputTokens: 50_000,
    });

    // Input: 200k * ($0.15 / 1M) = $0.03
    // Output: 50k * ($0.60 / 1M) = $0.03
    // Total: $0.06
    expect(entry.estimatedUSD).toBeCloseTo(0.06, 6);
    expect(entry.segmentId).toBe("seg-010");
    expect(entry.model).toBe("gemini-2.5-flash");
  });

  it("returns an empty summary when no entries have been recorded", () => {
    const tracker = new CostTracker();
    const summary = tracker.getSummary();

    expect(summary.segmentCount).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalEstimatedUSD).toBe(0);
    expect(summary.entries).toHaveLength(0);
  });

  it("preserves entry order in summary", () => {
    const tracker = new CostTracker();

    tracker.record({
      segmentId: "a",
      model: "m",
      inputTokens: 100,
      outputTokens: 200,
    });
    tracker.record({
      segmentId: "b",
      model: "m",
      inputTokens: 300,
      outputTokens: 400,
    });
    tracker.record({
      segmentId: "c",
      model: "m",
      inputTokens: 500,
      outputTokens: 600,
    });

    const ids = tracker.getSummary().entries.map((e) => e.segmentId);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

import { describe, expect, test } from "bun:test";

import type { ComparisonReport } from "../../../../plugins/defaults/memory/v2/harness/runner.js";
import {
  renderComparisonReport,
  renderTurnTrace,
} from "../memory-v2-compare-render.js";

function sampleReport(): ComparisonReport {
  return {
    ks: [5, 10],
    turnsConsidered: 3,
    turnsScored: 1,
    turnsSkipped: 2,
    perTurn: [
      {
        conversationId: "c1",
        turn: 7,
        byRetriever: {
          router: {
            groundTruth: ["a", "b"],
            selected: ["a", "x"],
            hits: ["a"],
            misses: ["b"],
            extras: ["x"],
            recallAtK: { 5: 0.5, 10: 0.5 },
            hitsByLane: { tier1: 1 },
            failureReason: null,
          },
        },
      },
    ],
    retrievers: [
      {
        name: "router",
        aggregate: {
          turns: 1,
          meanRecallAtK: { 5: 0.5, 10: 0.5 },
          failureRate: 0,
        },
      },
    ],
  };
}

describe("memory v2 compare — renderComparisonReport", () => {
  test("renders turn counts, recall@k, and per-lane attribution", () => {
    const out = renderComparisonReport(sampleReport());
    expect(out).toContain("considered 3, scored 1, skipped 2");
    expect(out).toContain("Retriever: router");
    expect(out).toContain("recall@5: 0.500");
    expect(out).toContain("recall@10: 0.500");
    expect(out).toContain("failures: 0.0%");
    expect(out).toContain("hits by lane: tier1=1");
  });

  test("renders mean cost when present", () => {
    const report = sampleReport();
    report.retrievers[0]!.aggregate.meanCostUsd = 0.0123;
    expect(renderComparisonReport(report)).toContain("mean cost: $0.0123");
  });

  test("handles a report with no scored turns", () => {
    const out = renderComparisonReport({
      ks: [5],
      turnsConsidered: 4,
      turnsScored: 0,
      turnsSkipped: 4,
      perTurn: [],
      retrievers: [
        {
          name: "router",
          aggregate: { turns: 0, meanRecallAtK: { 5: 0 }, failureRate: 0 },
        },
      ],
    });
    expect(out).toContain("No turns scored");
  });
});

describe("memory v2 compare — renderTurnTrace", () => {
  test("renders the per-retriever breakdown for a scored turn", () => {
    const out = renderTurnTrace(sampleReport(), "c1", 7);
    expect(out).toContain("Turn c1:7");
    expect(out).toContain("Retriever: router");
    expect(out).toContain("selected (2): a, x");
    expect(out).toContain("hits (1): a");
    expect(out).toContain("misses (1): b");
    expect(out).toContain("extras (1): x");
    expect(out).toContain("(no descent trace — tier-based retriever)");
  });

  test("explains when the requested turn was not scored", () => {
    const out = renderTurnTrace(sampleReport(), "c1", 999);
    expect(out).toContain("not found");
    expect(out).toContain("turnsSkipped=2");
  });
});

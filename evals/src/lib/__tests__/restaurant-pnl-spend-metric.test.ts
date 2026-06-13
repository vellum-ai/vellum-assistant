import { describe, expect, test } from "bun:test";

import scoreLargestCategoryFound from "../../../benchmarks/personal-intelligence/tests/restaurant-pnl-spend/metrics/largest-category-found";
import { appendTranscriptTurn, ensureRunArtifacts } from "../metrics";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-pnl-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

describe("restaurant-pnl-spend largest-category-found metric", () => {
  test("scores 1 for a terse correct answer", async () => {
    // GIVEN the assistant answers with just the correct category
    const runId = await freshRunId("terse");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Labor.",
      emittedAt: "now",
    });

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId });

    // THEN it earns full marks (the question already frames "largest")
    expect(result.name).toBe("largest-category-found");
    expect(result.score).toBe(1);
  });

  test("scores 1 for a verbose correct answer that also lists other categories", async () => {
    // GIVEN the assistant names Labor as largest while listing runners-up
    const runId = await freshRunId("verbose");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content:
        "Your largest spend category was Labor at $48,200, ahead of Food & Beverage at $31,450.",
      emittedAt: "now",
    });

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId });

    // THEN naming other categories as runners-up does not fail it
    expect(result.score).toBe(1);
  });

  test("scores 0 when a different category is claimed as the largest", async () => {
    // GIVEN the assistant claims the wrong category is biggest
    const runId = await freshRunId("wrong");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Your biggest spend category was Rent.",
      emittedAt: "now",
    });

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId });

    // THEN it fails with a wrong-category reason
    expect(result.score).toBe(0);
    expect(result.reason).toMatch(/different category/i);
  });

  test("scores 0 when the assistant cannot find the spreadsheet", async () => {
    // GIVEN the assistant reports it found nothing
    const runId = await freshRunId("notfound");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "I couldn't find a P&L spreadsheet in your workspace.",
      emittedAt: "now",
    });

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId });

    // THEN it earns no credit
    expect(result.score).toBe(0);
  });

  test("grades the final answer turn, not an in-passing mention while working", async () => {
    // GIVEN the assistant mentions "labor" mid-work but ultimately fails to answer
    const runId = await freshRunId("inpassing");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Let me open your labor line and the rest of the sheet.",
      emittedAt: "t1",
    });
    // AND the final turn names no category
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "I couldn't find the spreadsheet after all.",
      emittedAt: "t2",
    });

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId });

    // THEN the in-passing mention does not earn credit
    expect(result.score).toBe(0);
  });
});

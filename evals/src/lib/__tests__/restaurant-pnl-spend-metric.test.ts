import { describe, expect, test } from "bun:test";

import scoreLargestCategoryFound, {
  type ClaimedCategoryClassifier,
} from "../../../benchmarks/personal-intelligence/tests/restaurant-pnl-spend/metrics/largest-category-found";
import {
  appendAssistantEvents,
  appendTranscriptTurn,
  ensureRunArtifacts,
} from "../metrics";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-pnl-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

/** A classifier that records the answer it saw and returns a fixed verdict. */
function stubClassifier(verdict: string): {
  classify: ClaimedCategoryClassifier;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    classify: async (answer) => {
      seen.push(answer);
      return verdict;
    },
  };
}

describe("restaurant-pnl-spend largest-category-found metric", () => {
  test("scores 1 when the judge classifies the answer as Labor", async () => {
    // GIVEN the assistant answers and the judge reads it as claiming Labor
    const runId = await freshRunId("labor");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Your largest spend category was Labor at $48,069.",
      emittedAt: "now",
    });
    const judge = stubClassifier("Labor");

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId }, judge.classify);

    // THEN it earns full marks and reports the expected category
    expect(result.name).toBe("largest-category-found");
    expect(result.score).toBe(1);
    expect(result.metadata).toMatchObject({ claimedCategory: "Labor" });
  });

  test("scores 0 when the judge classifies a different category as largest", async () => {
    // GIVEN the assistant claims the wrong category is biggest
    const runId = await freshRunId("wrong");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Your biggest spend category was Rent.",
      emittedAt: "now",
    });
    const judge = stubClassifier("Rent");

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId }, judge.classify);

    // THEN it fails with a wrong-category reason
    expect(result.score).toBe(0);
    expect(result.reason).toMatch(/instead of Labor/i);
  });

  test("scores 0 when the judge finds no largest-category claim", async () => {
    // GIVEN the assistant reports it found nothing
    const runId = await freshRunId("notfound");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "I couldn't find a P&L spreadsheet in your workspace.",
      emittedAt: "now",
    });
    const judge = stubClassifier("none");

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId }, judge.classify);

    // THEN it earns no credit
    expect(result.score).toBe(0);
  });

  test("scores 0 with no answer turn, without invoking the judge", async () => {
    // GIVEN a run with no assistant turn at all
    const runId = await freshRunId("empty");
    const judge = stubClassifier("Labor");

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId }, judge.classify);

    // THEN it scores 0 and never calls the (paid) judge
    expect(result.score).toBe(0);
    expect(judge.seen).toHaveLength(0);
  });

  test("judges the folded final message, not a single streamed delta", async () => {
    // GIVEN a Vellum-style run where the final answer arrives as several
    // assistant_text_delta events whose last fragment is only the amount
    const runId = await freshRunId("deltas");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      {
        message: { type: "assistant_text_delta", text: "Your largest spend " },
        emittedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        message: { type: "assistant_text_delta", text: "category was Labor" },
        emittedAt: "2026-01-01T00:00:02.000Z",
      },
      {
        message: { type: "assistant_text_delta", text: " at $48,069." },
        emittedAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
    const judge = stubClassifier("Labor");

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId }, judge.classify);

    // THEN the judge receives the coalesced answer, not the trailing delta
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]).toBe(
      "Your largest spend category was Labor at $48,069.",
    );
    expect(result.score).toBe(1);
  });

  test("judges the final answer turn, not an in-passing mention while working", async () => {
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
    const judge = stubClassifier("none");

    // WHEN the metric scores the run
    const result = await scoreLargestCategoryFound({ runId }, judge.classify);

    // THEN only the final turn is judged and the in-passing mention earns nothing
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]).toBe("I couldn't find the spreadsheet after all.");
    expect(result.score).toBe(0);
  });
});

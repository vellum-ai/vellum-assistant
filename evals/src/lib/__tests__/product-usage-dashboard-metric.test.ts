import { describe, expect, test } from "bun:test";

import scoreHighestTokenModel from "../../../benchmarks/personal-intelligence/tests/product-usage-dashboard/metrics/highest-token-model";
import scoreDashboardDelivered from "../../../benchmarks/personal-intelligence/tests/product-usage-dashboard/metrics/dashboard-delivered";
import {
  appendAssistantEvents,
  appendTranscriptTurn,
  ensureRunArtifacts,
} from "../metrics";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-usage-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

/** A classifier that records what it saw and returns a fixed verdict. */
function stubClassifier(verdict: string): {
  classify: (text: string) => Promise<string>;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    classify: async (text) => {
      seen.push(text);
      return verdict;
    },
  };
}

describe("product-usage-dashboard highest-token-model metric", () => {
  test("scores 1 when the judge classifies the answer as claude-sonnet-4-6", async () => {
    // GIVEN the assistant answers and the judge reads it as claiming sonnet
    const runId = await freshRunId("sonnet");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "claude-sonnet-4-6 used the most tokens — 677k overall.",
      emittedAt: "now",
    });
    const judge = stubClassifier("claude-sonnet-4-6");

    // WHEN the metric scores the run
    const result = await scoreHighestTokenModel({ runId }, judge.classify);

    // THEN it earns full marks and reports the expected model
    expect(result.name).toBe("highest-token-model");
    expect(result.score).toBe(1);
    expect(result.metadata).toMatchObject({
      claimedModel: "claude-sonnet-4-6",
    });
  });

  test("scores 0 when the judge classifies a different model as top", async () => {
    // GIVEN the assistant names the wrong leader
    const runId = await freshRunId("wrong");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "gpt-4o used the most tokens overall.",
      emittedAt: "now",
    });
    const judge = stubClassifier("gpt-4o");

    // WHEN the metric scores the run
    const result = await scoreHighestTokenModel({ runId }, judge.classify);

    // THEN it fails with a wrong-model reason
    expect(result.score).toBe(0);
    expect(result.reason).toMatch(/instead of claude-sonnet-4-6/i);
  });

  test("scores 0 when the judge finds no top-model claim", async () => {
    // GIVEN the assistant only describes the dashboard without a leader
    const runId = await freshRunId("none");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Here's your dashboard with a bar per model.",
      emittedAt: "now",
    });
    const judge = stubClassifier("none");

    // WHEN the metric scores the run
    const result = await scoreHighestTokenModel({ runId }, judge.classify);

    // THEN it earns no credit
    expect(result.score).toBe(0);
  });

  test("scores 0 with no answer turn, without invoking the judge", async () => {
    // GIVEN a run with no assistant turn at all
    const runId = await freshRunId("empty");
    const judge = stubClassifier("claude-sonnet-4-6");

    // WHEN the metric scores the run
    const result = await scoreHighestTokenModel({ runId }, judge.classify);

    // THEN it scores 0 and never calls the (paid) judge
    expect(result.score).toBe(0);
    expect(judge.seen).toHaveLength(0);
  });

  test("judges the folded final message, not a single streamed delta", async () => {
    // GIVEN a Vellum-style run where the final answer arrives as several
    // assistant_text_delta events whose last fragment is only the count
    const runId = await freshRunId("deltas");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which model used the most tokens?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      {
        message: {
          type: "assistant_text_delta",
          text: "claude-sonnet-4-6 leads ",
        },
        emittedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        message: { type: "assistant_text_delta", text: "with 677k tokens" },
        emittedAt: "2026-01-01T00:00:02.000Z",
      },
      {
        message: { type: "assistant_text_delta", text: " overall." },
        emittedAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
    const judge = stubClassifier("claude-sonnet-4-6");

    // WHEN the metric scores the run
    const result = await scoreHighestTokenModel({ runId }, judge.classify);

    // THEN the judge receives the coalesced answer, not the trailing delta
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]).toBe(
      "claude-sonnet-4-6 leads with 677k tokens overall.",
    );
    expect(result.score).toBe(1);
  });
});

describe("product-usage-dashboard dashboard-delivered metric", () => {
  test("scores 1 when the judge reports a dashboard was delivered", async () => {
    // GIVEN the assistant says it built and saved a dashboard file
    const runId = await freshRunId("delivered");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "I saved an interactive dashboard to product-usage.html.",
      emittedAt: "now",
    });
    const judge = stubClassifier("dashboard");

    // WHEN the metric scores the run
    const result = await scoreDashboardDelivered({ runId }, judge.classify);

    // THEN it earns full marks
    expect(result.name).toBe("dashboard-delivered");
    expect(result.score).toBe(1);
    expect(result.metadata).toMatchObject({ outcome: "dashboard" });
  });

  test("scores 0 when the judge reports a text-only analysis", async () => {
    // GIVEN the assistant only replied with a written table
    const runId = await freshRunId("analysis");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Here are the totals as a table: ...",
      emittedAt: "now",
    });
    const judge = stubClassifier("analysis_only");

    // WHEN the metric scores the run
    const result = await scoreDashboardDelivered({ runId }, judge.classify);

    // THEN it earns no credit and explains the text-only outcome
    expect(result.score).toBe(0);
    expect(result.reason).toMatch(/text only/i);
  });

  test("scores 0 when the judge reports nothing was delivered", async () => {
    // GIVEN the assistant could not read the export
    const runId = await freshRunId("nothing");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "I couldn't find product-usage.csv in your workspace.",
      emittedAt: "now",
    });
    const judge = stubClassifier("nothing");

    // WHEN the metric scores the run
    const result = await scoreDashboardDelivered({ runId }, judge.classify);

    // THEN it earns no credit
    expect(result.score).toBe(0);
  });

  test("scores 0 with no response, without invoking the judge", async () => {
    // GIVEN a run where the assistant never produced any text
    const runId = await freshRunId("silent");
    const judge = stubClassifier("dashboard");

    // WHEN the metric scores the run
    const result = await scoreDashboardDelivered({ runId }, judge.classify);

    // THEN it scores 0 and never calls the (paid) judge
    expect(result.score).toBe(0);
    expect(judge.seen).toHaveLength(0);
  });

  test("passes the whole assistant side of the conversation to the judge", async () => {
    // GIVEN the artifact is announced on an earlier turn than the closing summary
    const runId = await freshRunId("narration");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "I built product-usage.html with a bar chart per model.",
      emittedAt: "2026-01-01T00:00:01.000Z",
    });
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which model used the most tokens?",
      emittedAt: "2026-01-01T00:00:02.000Z",
    });
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "claude-sonnet-4-6, by a wide margin.",
      emittedAt: "2026-01-01T00:00:03.000Z",
    });
    const judge = stubClassifier("dashboard");

    // WHEN the metric scores the run
    const result = await scoreDashboardDelivered({ runId }, judge.classify);

    // THEN the judge sees both assistant messages joined, in order
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]).toContain("product-usage.html");
    expect(judge.seen[0]).toContain("claude-sonnet-4-6, by a wide margin.");
    expect(result.score).toBe(1);
  });
});

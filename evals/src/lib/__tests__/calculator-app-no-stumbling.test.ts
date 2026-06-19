import { afterEach, describe, expect, test } from "bun:test";

import scoreNoStumbling, {
  type StumbleClassifier,
} from "../../../benchmarks/personal-intelligence/tests/calculator-app/metrics/no-stumbling";
import {
  appendAssistantEvents,
  appendTranscriptTurn,
  ensureRunArtifacts,
} from "../metrics";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-calc-stumble-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

/** Mock the judge transport to return one forced `report_stumbling` tool call. */
function mockJudgeFetch(input: Record<string, unknown>): void {
  globalThis.fetch = (async (_url: string | URL | Request) =>
    new Response(
      JSON.stringify({
        content: [{ type: "tool_use", name: "report_stumbling", input }],
      }),
      { status: 200 },
    )) as typeof fetch;
}

/** A classifier that records the narration it saw and returns a fixed verdict. */
function stubClassifier(verdict: boolean): {
  classify: StumbleClassifier;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    classify: async (narration) => {
      seen.push(narration);
      return verdict;
    },
  };
}

describe("calculator-app no-stumbling metric", () => {
  test("scores 1 when the judge finds no stumbling", async () => {
    // GIVEN an assistant that narrated only routine progress
    const runId = await freshRunId("clean");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Here is your calculator. Let me add the operation buttons.",
      emittedAt: "now",
    });
    const judge = stubClassifier(false);

    // WHEN the metric scores the run
    const result = await scoreNoStumbling({ runId }, judge.classify);

    // THEN it earns full marks
    expect(result.name).toBe("no-stumbling");
    expect(result.score).toBe(1);
    expect(result.metadata).toMatchObject({ stumbled: false });
  });

  test("scores 0 when the judge finds stumbling", async () => {
    // GIVEN an assistant that admitted a failed attempt to the user
    const runId = await freshRunId("stumble");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "That didn't work, let me try a different approach.",
      emittedAt: "now",
    });
    const judge = stubClassifier(true);

    // WHEN the metric scores the run
    const result = await scoreNoStumbling({ runId }, judge.classify);

    // THEN it fails
    expect(result.score).toBe(0);
    expect(result.metadata).toMatchObject({ stumbled: true });
  });

  test("scores 0 with no assistant response, without invoking the judge", async () => {
    // GIVEN a run with no assistant turn at all
    const runId = await freshRunId("empty");
    const judge = stubClassifier(false);

    // WHEN the metric scores the run
    const result = await scoreNoStumbling({ runId }, judge.classify);

    // THEN it scores 0 and never calls the (paid) judge
    expect(result.score).toBe(0);
    expect(judge.seen).toHaveLength(0);
  });

  test("judges visible narration only, excluding internal thinking", async () => {
    // GIVEN a run whose thinking admits a retry but whose visible text does not
    const runId = await freshRunId("thinking");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Build me a calculator.",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      {
        message: {
          type: "assistant_thinking_delta",
          thinking: "That didn't work, let me try another approach.",
        },
        emittedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        message: {
          type: "assistant_text_delta",
          text: "Here's your working calculator with a screenshot.",
        },
        emittedAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    const judge = stubClassifier(false);

    // WHEN the metric scores the run
    await scoreNoStumbling({ runId }, judge.classify);

    // THEN the judge sees only the visible text, not the internal thinking
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]).toBe(
      "Here's your working calculator with a screenshot.",
    );
    expect(judge.seen[0]).not.toContain("That didn't work");
  });

  test("folds the per-delta stream into one narration before judging", async () => {
    // GIVEN a Vellum-style run whose narration arrives as several text deltas
    const runId = await freshRunId("deltas");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Build me a calculator.",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      {
        message: { type: "assistant_text_delta", text: "Let me " },
        emittedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        message: { type: "assistant_text_delta", text: "build that for you." },
        emittedAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    const judge = stubClassifier(false);

    // WHEN the metric scores the run
    await scoreNoStumbling({ runId }, judge.classify);

    // THEN the judge receives the coalesced narration, not separate fragments
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]).toBe("Let me build that for you.");
  });

  describe("default Haiku judge", () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    });

    test("returns the judge's boolean verdict", async () => {
      // GIVEN the judge reports stumbling via a well-formed verdict
      const runId = await freshRunId("default-stumble");
      await appendTranscriptTurn(runId, {
        role: "assistant",
        content: "That didn't work; let me try again.",
        emittedAt: "now",
      });
      process.env.ANTHROPIC_API_KEY = "test-key";
      mockJudgeFetch({ stumbled: true });

      // WHEN the metric scores the run with the default judge
      const result = await scoreNoStumbling({ runId });

      // THEN it fails on the judge's verdict
      expect(result.score).toBe(0);
      expect(result.metadata).toMatchObject({ stumbled: true });
    });

    test("fails closed when the judge returns a non-boolean verdict", async () => {
      // GIVEN a malformed verdict that omits the boolean (e.g. judge error)
      const runId = await freshRunId("default-malformed");
      await appendTranscriptTurn(runId, {
        role: "assistant",
        content: "Here is your calculator.",
        emittedAt: "now",
      });
      process.env.ANTHROPIC_API_KEY = "test-key";
      mockJudgeFetch({});

      // WHEN/THEN the metric surfaces the failure instead of crediting the run
      await expect(scoreNoStumbling({ runId })).rejects.toThrow(
        /non-boolean verdict/,
      );
    });
  });
});

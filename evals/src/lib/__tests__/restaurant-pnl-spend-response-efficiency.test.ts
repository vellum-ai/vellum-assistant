import { describe, expect, test } from "bun:test";

import scoreResponseEfficiency from "../../../benchmarks/personal-intelligence/tests/restaurant-pnl-spend/metrics/response-efficiency";
import {
  appendAssistantEvents,
  appendTranscriptTurn,
  ensureRunArtifacts,
} from "../metrics";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-pnl-eff-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

function deltaEvent(text: string, second: number) {
  return {
    message: { type: "assistant_text_delta" as const, text },
    emittedAt: `2026-01-01T00:00:0${second}.000Z`,
  };
}

describe("restaurant-pnl-spend response-efficiency metric", () => {
  test("scores 1 for a single streamed answer, counting it as one response not one per delta", async () => {
    // GIVEN a Vellum-style run whose one answer streams as several deltas
    const runId = await freshRunId("baseline");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEvent("Your largest spend ", 1),
      deltaEvent("category was Labor", 2),
      deltaEvent(" at $48,069.", 3),
    ]);

    // WHEN the metric scores the run
    const result = await scoreResponseEfficiency({ runId });

    // THEN the folded single reply earns full marks at the baseline of 1
    expect(result.name).toBe("response-efficiency");
    expect(result.score).toBe(1);
    expect(result.metadata?.responses).toBe(1);
  });

  test("decays as the inverse ratio for extra responses past the baseline", async () => {
    // GIVEN three separate assistant replies, each split into deltas, with
    // simulator turns in between so they fold into distinct responses
    const runId = await freshRunId("triple");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Open the sheet.",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEvent("On ", 1),
      deltaEvent("it.", 2),
    ]);
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "And the largest category?",
      emittedAt: "2026-01-01T00:00:03.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEvent("Checking ", 4),
      deltaEvent("now.", 5),
    ]);
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Well?",
      emittedAt: "2026-01-01T00:00:06.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEvent("It was ", 7),
      deltaEvent("Labor.", 8),
    ]);

    // WHEN the metric scores the run
    const result = await scoreResponseEfficiency({ runId });

    // THEN three responses score min(1, 1/3) and the count is surfaced
    expect(result.metadata?.responses).toBe(3);
    expect(result.score).toBeCloseTo(1 / 3, 5);
  });

  test("scores 0 when the assistant never responds", async () => {
    // GIVEN a run with only a simulator turn and no assistant output
    const runId = await freshRunId("noanswer");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });

    // WHEN the metric scores the run
    const result = await scoreResponseEfficiency({ runId });

    // THEN there is no efficiency to credit
    expect(result.score).toBe(0);
    expect(result.metadata?.responses).toBe(0);
  });
});

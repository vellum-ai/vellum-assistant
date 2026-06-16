import { describe, expect, test } from "bun:test";

import scoreRuntimeEfficiency from "../../../benchmarks/personal-intelligence/tests/restaurant-pnl-spend/metrics/runtime-efficiency";
import {
  appendAssistantEvents,
  appendTranscriptTurn,
  ensureRunArtifacts,
} from "../metrics";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-pnl-runtime-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

function deltaEventAt(text: string, emittedAt: string) {
  return {
    message: { type: "assistant_text_delta" as const, text },
    emittedAt,
  };
}

describe("restaurant-pnl-spend runtime-efficiency metric", () => {
  test("scores 1 for a conversation that resolves within the one-minute baseline", async () => {
    // GIVEN a run whose answer streams 30s after the question lands
    const runId = await freshRunId("baseline");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEventAt("Your largest spend ", "2026-01-01T00:00:29.000Z"),
      deltaEventAt("category was Labor.", "2026-01-01T00:00:30.000Z"),
    ]);

    // WHEN the metric scores the run
    const result = await scoreRuntimeEfficiency({ runId });

    // THEN a sub-minute conversation earns full marks
    expect(result.name).toBe("runtime-efficiency");
    expect(result.score).toBe(1);
    expect(result.metadata?.elapsedMs).toBe(30_000);
  });

  test("decays as the inverse ratio when the conversation runs past the baseline", async () => {
    // GIVEN a run whose answer lands two minutes after the question
    const runId = await freshRunId("slow");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEventAt("Labor, at $48,069.", "2026-01-01T00:02:00.000Z"),
    ]);

    // WHEN the metric scores the run
    const result = await scoreRuntimeEfficiency({ runId });

    // THEN a two-minute conversation scores min(1, 60s / 120s)
    expect(result.metadata?.elapsedMs).toBe(120_000);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  test("measures the agent's last output even when its events carry no timestamp", async () => {
    // GIVEN a Hermes-style run whose single-shot event has no emittedAt, so the
    // assistant transcript turn is the only timestamped end of the conversation
    const runId = await freshRunId("hermes");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      { message: { type: "message_chunk" as const, text: "Labor." } },
    ]);
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "Labor.",
      emittedAt: "2026-01-01T00:00:45.000Z",
    });

    // WHEN the metric scores the run
    const result = await scoreRuntimeEfficiency({ runId });

    // THEN the span is measured to the transcript turn and stays under baseline
    expect(result.metadata?.elapsedMs).toBe(45_000);
    expect(result.score).toBe(1);
  });

  test("scores 0 when there is no measurable conversation span", async () => {
    // GIVEN a run with only a simulator turn and no assistant output
    const runId = await freshRunId("noanswer");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });

    // WHEN the metric scores the run
    const result = await scoreRuntimeEfficiency({ runId });

    // THEN there is no runtime to credit
    expect(result.score).toBe(0);
    expect(result.metadata?.elapsedMs).toBeNull();
  });
});

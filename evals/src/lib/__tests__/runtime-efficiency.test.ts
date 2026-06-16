import { describe, expect, test } from "bun:test";

import { makeRuntimeEfficiencyMetric } from "../common-metrics/runtime-efficiency";
import {
  appendAssistantEvents,
  appendTranscriptTurn,
  ensureRunArtifacts,
} from "../metrics";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-runtime-efficiency-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

function deltaEventAt(text: string, emittedAt: string) {
  return {
    message: { type: "assistant_text_delta" as const, text },
    emittedAt,
  };
}

describe("makeRuntimeEfficiencyMetric", () => {
  test("scores 1 for a conversation that resolves within the baseline", async () => {
    // GIVEN a metric baselined to ten minutes
    const score = makeRuntimeEfficiencyMetric({ baselineMs: 600_000 });
    // AND a run whose answer streams 30s after the question lands
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
    const result = await score({ runId });

    // THEN a sub-baseline conversation earns full marks
    expect(result.name).toBe("runtime-efficiency");
    expect(result.score).toBe(1);
    expect(result.metadata?.elapsedMs).toBe(30_000);
    expect(result.metadata?.baselineMs).toBe(600_000);
  });

  test("decays as the inverse ratio when the conversation runs past the baseline", async () => {
    // GIVEN a metric baselined to ten minutes
    const score = makeRuntimeEfficiencyMetric({ baselineMs: 600_000 });
    // AND a run whose answer lands twenty minutes after the question
    const runId = await freshRunId("slow");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEventAt("Labor, at $48,069.", "2026-01-01T00:20:00.000Z"),
    ]);

    // WHEN the metric scores the run
    const result = await score({ runId });

    // THEN a twenty-minute conversation scores min(1, 10min / 20min)
    expect(result.metadata?.elapsedMs).toBe(1_200_000);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  test("baseline is parameterized: the same span scores differently per baseline", async () => {
    // GIVEN a run whose answer lands two minutes after the question
    const runId = await freshRunId("param");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEventAt("Labor.", "2026-01-01T00:02:00.000Z"),
    ]);

    // WHEN the same span is scored against a one-minute and a ten-minute baseline
    const tight = await makeRuntimeEfficiencyMetric({ baselineMs: 60_000 })({
      runId,
    });
    const loose = await makeRuntimeEfficiencyMetric({ baselineMs: 600_000 })({
      runId,
    });

    // THEN the tighter baseline penalizes the same run while the looser one credits it
    expect(tight.score).toBeCloseTo(0.5, 5);
    expect(loose.score).toBe(1);
  });

  test("uses a caller-supplied metric name", async () => {
    // GIVEN a metric built with a custom name
    const score = makeRuntimeEfficiencyMetric({
      baselineMs: 60_000,
      name: "completed-quickly",
    });
    // AND a run with a measurable span
    const runId = await freshRunId("named");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Go.",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      deltaEventAt("Done.", "2026-01-01T00:00:30.000Z"),
    ]);

    // WHEN the metric scores the run
    const result = await score({ runId });

    // THEN the result carries the custom name
    expect(result.name).toBe("completed-quickly");
  });

  test("measures the agent's last output even when its events carry no timestamp", async () => {
    // GIVEN a metric baselined to ten minutes
    const score = makeRuntimeEfficiencyMetric({ baselineMs: 600_000 });
    // AND a Hermes-style run whose single-shot event has no emittedAt, so the
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
    const result = await score({ runId });

    // THEN the span is measured to the transcript turn and stays under baseline
    expect(result.metadata?.elapsedMs).toBe(45_000);
    expect(result.score).toBe(1);
  });

  test("scores 0 when there is no measurable conversation span", async () => {
    // GIVEN a metric baselined to ten minutes
    const score = makeRuntimeEfficiencyMetric({ baselineMs: 600_000 });
    // AND a run with only a simulator turn and no assistant output
    const runId = await freshRunId("noanswer");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });

    // WHEN the metric scores the run
    const result = await score({ runId });

    // THEN there is no runtime to credit
    expect(result.score).toBe(0);
    expect(result.metadata?.elapsedMs).toBeNull();
  });
});

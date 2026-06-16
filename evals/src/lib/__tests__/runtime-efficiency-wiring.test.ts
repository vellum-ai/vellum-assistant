import { describe, expect, test } from "bun:test";

import calculatorRuntimeEfficiency from "../../../benchmarks/personal-intelligence/tests/calculator-app/metrics/runtime-efficiency";
import restaurantRuntimeEfficiency from "../../../benchmarks/personal-intelligence/tests/restaurant-pnl-spend/metrics/runtime-efficiency";
import {
  appendAssistantEvents,
  appendTranscriptTurn,
  ensureRunArtifacts,
} from "../metrics";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-runtime-wiring-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

describe("runtime-efficiency baselines wired per test", () => {
  test("restaurant-pnl-spend baselines to one minute", async () => {
    // GIVEN a two-minute conversation
    const runId = await freshRunId("restaurant");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did I spend the most on?",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      {
        message: { type: "assistant_text_delta" as const, text: "Labor." },
        emittedAt: "2026-01-01T00:02:00.000Z",
      },
    ]);

    // WHEN the restaurant runtime metric scores it
    const result = await restaurantRuntimeEfficiency({ runId });

    // THEN it is baselined to one minute, so two minutes scores min(1, 1/2)
    expect(result.name).toBe("runtime-efficiency");
    expect(result.metadata?.baselineMs).toBe(60_000);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  test("calculator-app baselines to ten minutes", async () => {
    // GIVEN a two-minute conversation
    const runId = await freshRunId("calculator");
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Build me a calculator.",
      emittedAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      {
        message: { type: "assistant_text_delta" as const, text: "Done." },
        emittedAt: "2026-01-01T00:02:00.000Z",
      },
    ]);

    // WHEN the calculator runtime metric scores it
    const result = await calculatorRuntimeEfficiency({ runId });

    // THEN it is baselined to ten minutes, so two minutes earns full marks
    expect(result.name).toBe("runtime-efficiency");
    expect(result.metadata?.baselineMs).toBe(600_000);
    expect(result.score).toBe(1);
  });
});

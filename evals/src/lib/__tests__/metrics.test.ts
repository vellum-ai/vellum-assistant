import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  appendTranscriptTurn,
  ensureRunArtifacts,
  readUsage,
  runMetrics,
  writeUsage,
} from "../metrics";
import type { TestDef } from "../test-def";
import scoreAssistantCost from "../../../tests/timeline-recall/metrics/assistant-cost";
import scoreDateMentioned from "../../../tests/timeline-recall/metrics/date-mentioned";

const testDef: TestDef = {
  id: "timeline-recall",
  specPath: "/tmp/SPEC.md",
  setupPath: "/tmp/setup.json",
  setupCommands: [],
  metricsDir: "/tmp/metrics",
  metricPaths: [],
};

async function freshRunId(name: string): Promise<string> {
  const runId = `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

describe("timeline-recall metrics", () => {
  test("date metric scores 1 when assistant names March 14", async () => {
    const runId = await freshRunId("date-pass");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "You mentioned it on March 14.",
      emittedAt: "now",
    });

    const result = await scoreDateMentioned({ runId });

    expect(result.score).toBe(1);
    expect(result).not.toHaveProperty("passed");
  });

  test("date metric scores 0 when assistant does not name the date", async () => {
    const runId = await freshRunId("date-fail");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "I cannot find it.",
      emittedAt: "now",
    });

    const result = await scoreDateMentioned({ runId });

    expect(result.score).toBe(0);
  });

  test("cost metric scores negative assistant cost", async () => {
    const runId = await freshRunId("cost");
    await writeUsage(runId, { requests: [], totalCostUsd: 0.0123 });

    const result = await scoreAssistantCost({ runId });

    expect(result.name).toBe("assistant-cost-usd");
    expect(result.score).toBe(-0.0123);
    expect(await readUsage(runId)).toMatchObject({ totalCostUsd: 0.0123 });
  });

  test("runs metric files in parallel", async () => {
    const runId = await freshRunId("parallel");
    const dir = resolve(`.runs/${runId}-metrics`);
    await Bun.write(
      `${dir}/a.ts`,
      'export default async () => { await new Promise((r) => setTimeout(r, 80)); return { name: "a", score: 1 }; };',
    );
    await Bun.write(
      `${dir}/b.ts`,
      'export default async () => { await new Promise((r) => setTimeout(r, 80)); return { name: "b", score: 1 }; };',
    );

    const start = Date.now();
    const results = await runMetrics({
      test: { ...testDef, metricPaths: [`${dir}/a.ts`, `${dir}/b.ts`] },
      runId,
    });

    expect(results.map((r) => r.name).sort()).toEqual(["a", "b"]);
    expect(Date.now() - start).toBeLessThan(140);
    await rm(dir, { recursive: true, force: true });
  });
});

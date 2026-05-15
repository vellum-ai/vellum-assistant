import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import {
  createMetricContext,
  metricArtifactPaths,
  runMetrics,
  writeMetricArtifacts,
} from "../metrics";
import type { Profile } from "../profile";
import type { TestDef } from "../test-def";
import scoreAssistantCost from "../../../tests/timeline-recall/metrics/assistant-cost";
import scoreDateMentioned from "../../../tests/timeline-recall/metrics/date-mentioned";

const profile: Profile = {
  id: "vellum-bare",
  manifest: { species: "vellum" },
  workspaceDir: "/tmp/profile",
};

const testDef: TestDef = {
  id: "timeline-recall",
  specPath: "/tmp/SPEC.md",
  setupPath: "/tmp/setup.json",
  setupMessages: [],
  metricsDir: "/tmp/metrics",
  metricPaths: [],
};

async function context() {
  const artifactDir = await mkdtemp(join(tmpdir(), "evals-metrics-"));
  return {
    artifactDir,
    metricContext: createMetricContext({
      profile,
      test: testDef,
      runId: "run-1",
      artifactDir,
    }),
  };
}

describe("timeline-recall metrics", () => {
  test("date metric scores 1 when assistant names March 14", async () => {
    const { artifactDir, metricContext } = await context();
    await writeMetricArtifacts(metricArtifactPaths(artifactDir), {
      transcript: [
        {
          role: "assistant",
          content: "You mentioned it on March 14.",
          emittedAt: "now",
          phase: "eval",
        },
      ],
      assistantEvents: [],
      simulatorMessages: [],
      usage: { requests: [] },
    });

    const result = await scoreDateMentioned(metricContext);

    expect(result.score).toBe(1);
    expect(result).not.toHaveProperty("passed");
  });

  test("date metric scores 0 when assistant does not name the date", async () => {
    const { artifactDir, metricContext } = await context();
    await writeMetricArtifacts(metricArtifactPaths(artifactDir), {
      transcript: [
        {
          role: "assistant",
          content: "I cannot find it.",
          emittedAt: "now",
          phase: "eval",
        },
      ],
      assistantEvents: [],
      simulatorMessages: [],
      usage: { requests: [] },
    });

    const result = await scoreDateMentioned(metricContext);

    expect(result.score).toBe(0);
  });

  test("cost metric scores negative assistant cost", async () => {
    const { artifactDir, metricContext } = await context();
    await writeMetricArtifacts(metricArtifactPaths(artifactDir), {
      transcript: [],
      assistantEvents: [],
      simulatorMessages: [],
      usage: { requests: [], totalCostUsd: 0.0123 },
    });

    const result = await scoreAssistantCost(metricContext);

    expect(result.name).toBe("assistant-cost-usd");
    expect(result.score).toBe(-0.0123);
  });

  test("runs metric files in parallel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-parallel-"));
    const metricA = join(dir, "a.ts");
    const metricB = join(dir, "b.ts");
    await Bun.write(
      metricA,
      'export default async () => { await new Promise((r) => setTimeout(r, 80)); return { name: "a", score: 1 }; };',
    );
    await Bun.write(
      metricB,
      'export default async () => { await new Promise((r) => setTimeout(r, 80)); return { name: "b", score: 1 }; };',
    );
    const metricContext = createMetricContext({
      profile,
      test: { ...testDef, metricPaths: [metricA, metricB] },
      runId: "run-1",
      artifactDir: dir,
    });

    const start = Date.now();
    const results = await runMetrics(metricContext);

    expect(results.map((r) => r.name).sort()).toEqual(["a", "b"]);
    expect(Date.now() - start).toBeLessThan(140);
  });
});

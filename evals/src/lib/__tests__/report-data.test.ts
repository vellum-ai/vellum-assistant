import { rm } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  appendAssistantEvents,
  appendSimulatorMessage,
  appendTranscriptTurn,
  ensureRunArtifacts,
  readMetricResults,
  readRunMetadata,
  runArtifacts,
  writeMetricResults,
  writeRunMetadata,
  writeUsage,
} from "../metrics";
import { listReportRuns, readReportRun } from "../report-data";

async function freshRunId(name: string): Promise<string> {
  const runId = `test-report-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

describe("report data", () => {
  test("persists run metadata and metric results for report cards", async () => {
    const runId = await freshRunId("persist");
    const artifacts = runArtifacts(runId);

    await writeRunMetadata(runId, {
      runId,
      profileId: "p1",
      testId: "t1",
      status: "completed",
      startedAt: "2026-05-15T12:00:00.000Z",
      completedAt: "2026-05-15T12:00:01.000Z",
      artifactDir: artifacts.runDir,
    });
    await writeMetricResults(runId, [
      { name: "accuracy", score: 1, reason: "matched" },
      { name: "cost", score: -0.25, reason: "spent tokens" },
    ]);

    expect(await readRunMetadata(runId)).toMatchObject({
      profileId: "p1",
      testId: "t1",
      status: "completed",
    });
    expect(await readMetricResults(runId)).toHaveLength(2);
  });

  test("summarizes run artifacts for the HTML report", async () => {
    const runId = await freshRunId("summary");
    const artifacts = runArtifacts(runId);

    await writeRunMetadata(runId, {
      runId,
      profileId: "p2",
      testId: "t1",
      status: "completed",
      startedAt: "2026-05-15T12:00:00.000Z",
      completedAt: "2026-05-15T12:00:02.000Z",
      artifactDir: artifacts.runDir,
    });
    await writeMetricResults(runId, [
      { name: "memory", score: 1 },
      { name: "cost", score: -0.1 },
    ]);
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "What did I say?",
      emittedAt: "2026-05-15T12:00:00.000Z",
    });
    await appendAssistantEvents(runId, [
      { message: { type: "assistant_text_delta", text: "March 14" } },
    ]);
    await appendSimulatorMessage(runId, { content: "What did I say?" });
    await writeUsage(runId, {
      requests: [{ model: "test" }],
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCostUsd: 0.001,
    });

    const detail = await readReportRun(runId);
    expect(detail).toMatchObject({
      runId,
      profileId: "p2",
      testId: "t1",
      status: "completed",
      metricCount: 2,
      scoreTotal: 0.9,
      transcriptTurns: 1,
      assistantEventCount: 1,
      simulatorMessageCount: 1,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCostUsd: 0.001,
    });
    expect(detail.metrics.map((metric) => metric.name)).toEqual([
      "memory",
      "cost",
    ]);

    const summaries = await listReportRuns();
    expect(summaries.find((summary) => summary.runId === runId)).toMatchObject({
      profileId: "p2",
      scoreTotal: 0.9,
    });
  });

  test("falls back for legacy artifact directories without run.json", async () => {
    const runId = await freshRunId("legacy");
    await rm(runArtifacts(runId).metadataPath, { force: true });

    const detail = await readReportRun(runId);

    expect(detail.status).toBe("unknown");
    expect(detail.metadata).toMatchObject({
      runId,
      profileId: "unknown",
      testId: "unknown",
      status: "unknown",
    });
  });
});

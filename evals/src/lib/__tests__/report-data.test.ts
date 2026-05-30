import { rm } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  appendAssistantEvents,
  appendProgressEvent,
  appendSimulatorMessage,
  appendTranscriptTurn,
  ensureRunArtifacts,
  readMetricResults,
  readRunMetadata,
  runArtifacts,
  writeIngestAssistantEvents,
  writeMetricResults,
  writeRunMetadata,
  writeUsage,
} from "../metrics";
import {
  findExecutionRunId,
  listReportSessions,
  readReportRun,
  readReportSession,
  readTestInSession,
  type ReportSessionSummary,
} from "../report-data";

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
      sessionId: `session-${runId}`,
      sessionLabel: "smoke",
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
      sessionId: `session-${runId}`,
      sessionLabel: "smoke",
    });
    expect(await readMetricResults(runId)).toHaveLength(2);
  });

  test("readReportRun surfaces ingest-turn events separately from question-turn events", async () => {
    // V2 contract: `assistant-events.json` and `ingest-assistant-events.json`
    // are siblings; the report exposes them as two distinct arrays so the
    // memory-formation work doesn't dilute the "agent's answer to the
    // question" view (and vice versa).
    const runId = await freshRunId("ingest-events");
    const artifacts = runArtifacts(runId);
    await writeRunMetadata(runId, {
      runId,
      sessionId: `session-${runId}`,
      profileId: "p1",
      testId: "t1",
      status: "completed",
      startedAt: "2026-05-15T12:00:00.000Z",
      artifactDir: artifacts.runDir,
    });
    await appendAssistantEvents(runId, [
      {
        message: { type: "assistant_text_delta", text: "answer" },
        emittedAt: "2026-05-15T12:00:02.000Z",
      },
    ]);
    await writeIngestAssistantEvents(runId, [
      {
        message: { type: "assistant_text_delta", text: "memory-formation" },
        emittedAt: "2026-05-15T12:00:01.000Z",
      },
    ]);

    const detail = await readReportRun(runId);
    expect(detail.assistantEvents).toHaveLength(1);
    expect(detail.assistantEvents[0]?.message).toMatchObject({
      text: "answer",
    });
    expect(detail.ingestAssistantEvents).toHaveLength(1);
    expect(detail.ingestAssistantEvents[0]?.message).toMatchObject({
      text: "memory-formation",
    });
  });

  test("readReportRun defaults ingestAssistantEvents to [] for legacy V1-shaped runs", async () => {
    // Older runs predate `ingest-assistant-events.json`. The reader must
    // not throw — it returns the empty default that
    // `ensureRunArtifacts` already writes for new runs.
    const runId = await freshRunId("ingest-legacy");
    const artifacts = runArtifacts(runId);
    await writeRunMetadata(runId, {
      runId,
      sessionId: `session-${runId}`,
      profileId: "p1",
      testId: "t1",
      status: "completed",
      startedAt: "2026-05-15T12:00:00.000Z",
      artifactDir: artifacts.runDir,
    });
    await rm(artifacts.ingestAssistantEventsPath, { force: true });

    const detail = await readReportRun(runId);
    expect(detail.ingestAssistantEvents).toEqual([]);
  });

  test("readReportRun returns persisted progress events", async () => {
    const runId = await freshRunId("progress");
    const artifacts = runArtifacts(runId);

    await writeRunMetadata(runId, {
      runId,
      sessionId: `session-${runId}`,
      profileId: "p1",
      testId: "t1",
      status: "completed",
      startedAt: "2026-05-15T12:00:00.000Z",
      completedAt: "2026-05-15T12:00:02.000Z",
      artifactDir: artifacts.runDir,
    });
    await appendProgressEvent(runId, {
      step: "hatch",
      status: "start",
      message: "Hatching assistant",
      emittedAt: "2026-05-15T12:00:00.500Z",
    });
    await appendProgressEvent(runId, {
      step: "hatch",
      status: "done",
      message: "Assistant ready",
      emittedAt: "2026-05-15T12:00:01.250Z",
    });

    const detail = await readReportRun(runId);
    expect(detail.progressEvents).toHaveLength(2);
    expect(detail.progressEvents[0]).toMatchObject({
      step: "hatch",
      status: "start",
    });
    expect(detail.progressEvents[1]).toMatchObject({
      step: "hatch",
      status: "done",
    });
  });

  test("summarizes run artifacts for the HTML report", async () => {
    const runId = await freshRunId("summary");
    const artifacts = runArtifacts(runId);

    await writeRunMetadata(runId, {
      runId,
      sessionId: `session-${runId}`,
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
      scoreTotal: 0.45,
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
  });

  test("falls back for legacy artifact directories without run.json", async () => {
    const runId = await freshRunId("legacy");
    await rm(runArtifacts(runId).metadataPath, { force: true });

    const detail = await readReportRun(runId);

    expect(detail.status).toBe("unknown");
    expect(detail.sessionId).toBe(runId);
    expect(detail.metadata).toMatchObject({
      runId,
      profileId: "unknown",
      testId: "unknown",
      status: "unknown",
    });
  });

  test("listReportSessions groups runs by sessionId and aggregates scores", async () => {
    const sessionTag = `session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runIdA = await freshRunId("session-a");
    const runIdB = await freshRunId("session-b");

    await Promise.all([
      writeRunMetadata(runIdA, {
        runId: runIdA,
        sessionId: sessionTag,
        sessionLabel: "compare",
        profileId: "p1",
        testId: "t1",
        status: "completed",
        startedAt: "2026-05-15T12:00:00.000Z",
        completedAt: "2026-05-15T12:00:01.000Z",
        artifactDir: runArtifacts(runIdA).runDir,
      }),
      writeRunMetadata(runIdB, {
        runId: runIdB,
        sessionId: sessionTag,
        sessionLabel: "compare",
        profileId: "p2",
        testId: "t1",
        status: "completed",
        startedAt: "2026-05-15T12:00:02.000Z",
        completedAt: "2026-05-15T12:00:03.000Z",
        artifactDir: runArtifacts(runIdB).runDir,
      }),
    ]);

    await writeMetricResults(runIdA, [{ name: "acc", score: 1 }]);
    await writeMetricResults(runIdB, [{ name: "acc", score: 0.5 }]);

    const sessions = await listReportSessions();
    const match = sessions.find((session) => session.sessionId === sessionTag);
    expect(match).toBeDefined();
    const expected: Partial<ReportSessionSummary> = {
      sessionId: sessionTag,
      sessionLabel: "compare",
      runCount: 2,
      status: "completed",
      profileIds: ["p1", "p2"],
      testIds: ["t1"],
      scoreTotal: 0.75,
    };
    expect(match).toMatchObject(expected);
  });

  test("readReportSession returns per-profile aggregates + per-test entries", async () => {
    const sessionTag = `session-detail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runIdA = await freshRunId("detail-a");
    const runIdB = await freshRunId("detail-b");
    const runIdC = await freshRunId("detail-c");

    await Promise.all([
      writeRunMetadata(runIdA, {
        runId: runIdA,
        sessionId: sessionTag,
        profileId: "p1",
        testId: "t1",
        status: "completed",
        startedAt: "2026-05-15T12:00:00.000Z",
        artifactDir: runArtifacts(runIdA).runDir,
      }),
      writeRunMetadata(runIdB, {
        runId: runIdB,
        sessionId: sessionTag,
        profileId: "p2",
        testId: "t1",
        status: "completed",
        startedAt: "2026-05-15T12:00:01.000Z",
        artifactDir: runArtifacts(runIdB).runDir,
      }),
      writeRunMetadata(runIdC, {
        runId: runIdC,
        sessionId: sessionTag,
        profileId: "p1",
        testId: "t2",
        status: "failed",
        startedAt: "2026-05-15T12:00:02.000Z",
        artifactDir: runArtifacts(runIdC).runDir,
      }),
    ]);

    await writeMetricResults(runIdA, [{ name: "acc", score: 1 }]);
    await writeMetricResults(runIdB, [{ name: "acc", score: 0.6 }]);
    await writeMetricResults(runIdC, [{ name: "acc", score: 0 }]);

    const session = await readReportSession(sessionTag);
    expect(session).toBeDefined();
    expect(session?.status).toBe("partial");
    expect(session?.profiles).toHaveLength(2);

    const p1 = session?.profiles.find((p) => p.profileId === "p1");
    expect(p1).toMatchObject({
      runCount: 2,
      scoreTotal: 0.5,
      completedCount: 1,
      failedCount: 1,
    });
    expect(p1).not.toHaveProperty("scoreAverage");

    expect(session?.tests).toHaveLength(2);
    const t1 = session?.tests.find((t) => t.testId === "t1");
    expect(t1?.profiles.map((p) => p.profileId)).toEqual(["p1", "p2"]);
    // t1 has two runs at 1.0 and 0.6 → equal-weighted mean is 0.8, NOT
    // 1.6 (the old per-profile sum that would render as 160%).
    expect(t1?.scoreTotal).toBeCloseTo(0.8, 10);
    const t2 = session?.tests.find((t) => t.testId === "t2");
    expect(t2?.scoreTotal).toBe(0);
  });

  test("readTestInSession exposes per-profile metrics for the test page", async () => {
    const sessionTag = `session-test-detail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runIdA = await freshRunId("test-detail-a");
    const runIdB = await freshRunId("test-detail-b");

    await Promise.all([
      writeRunMetadata(runIdA, {
        runId: runIdA,
        sessionId: sessionTag,
        profileId: "p1",
        testId: "t1",
        status: "completed",
        artifactDir: runArtifacts(runIdA).runDir,
      }),
      writeRunMetadata(runIdB, {
        runId: runIdB,
        sessionId: sessionTag,
        profileId: "p2",
        testId: "t1",
        status: "completed",
        artifactDir: runArtifacts(runIdB).runDir,
      }),
    ]);

    await writeMetricResults(runIdA, [
      { name: "acc", score: 1 },
      { name: "cost", score: -0.1 },
    ]);
    await writeMetricResults(runIdB, [
      { name: "acc", score: 0.5 },
      { name: "cost", score: -0.2 },
    ]);

    const test = await readTestInSession(sessionTag, "t1");
    expect(test).toBeDefined();
    expect(test?.profiles).toHaveLength(2);
    const p2 = test?.profiles.find((p) => p.profileId === "p2");
    expect(p2?.scoreTotal).toBe(0.15);
    expect(p2?.metrics.map((m) => m.name)).toEqual(["acc", "cost"]);
  });

  test("findExecutionRunId resolves (sessionId, testId, profileId)", async () => {
    const sessionTag = `session-find-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runId = await freshRunId("find");

    await writeRunMetadata(runId, {
      runId,
      sessionId: sessionTag,
      profileId: "p1",
      testId: "t1",
      status: "completed",
      artifactDir: runArtifacts(runId).runDir,
    });

    expect(await findExecutionRunId(sessionTag, "t1", "p1")).toBe(runId);
    expect(
      await findExecutionRunId(sessionTag, "t1", "missing"),
    ).toBeUndefined();
  });

  test("listReportSessions surfaces 'abandoned' for sessions whose only terminal runs are abandoned", async () => {
    // Codex P2: deriveSessionStatus used to fall through to 'unknown' when
    // every run was abandoned, hiding the actual outcome on the index page.
    // The scavenger now marks stuck runs abandoned — make sure the index
    // does not lie about it.
    const sessionTag = `session-abandoned-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runId = await freshRunId("abandoned");
    await writeRunMetadata(runId, {
      runId,
      sessionId: sessionTag,
      profileId: "p1",
      testId: "t1",
      status: "abandoned",
      startedAt: "2026-05-22T13:00:00.000Z",
      completedAt: "2026-05-22T13:05:00.000Z",
      error: "scavenged",
      artifactDir: runArtifacts(runId).runDir,
    });
    const sessions = await listReportSessions();
    const ours = sessions.find((s) => s.sessionId === sessionTag);
    expect(ours).toBeDefined();
    expect(ours!.status).toBe("abandoned");
  });

  test("listReportSessions surfaces 'partial' when abandoned + completed runs coexist in one session", async () => {
    const sessionTag = `session-partial-abandoned-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const okRun = await freshRunId("partial-ok");
    const lostRun = await freshRunId("partial-lost");
    await writeRunMetadata(okRun, {
      runId: okRun,
      sessionId: sessionTag,
      profileId: "p1",
      testId: "t1",
      status: "completed",
      artifactDir: runArtifacts(okRun).runDir,
    });
    await writeRunMetadata(lostRun, {
      runId: lostRun,
      sessionId: sessionTag,
      profileId: "p2",
      testId: "t1",
      status: "abandoned",
      error: "scavenged",
      artifactDir: runArtifacts(lostRun).runDir,
    });
    const sessions = await listReportSessions();
    const ours = sessions.find((s) => s.sessionId === sessionTag);
    expect(ours).toBeDefined();
    expect(ours!.status).toBe("partial");
  });
});

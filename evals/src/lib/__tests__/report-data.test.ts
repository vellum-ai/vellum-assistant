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
  readProfileInSession,
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
      {
        message: { type: "assistant_text_delta", text: "March 14" },
        emittedAt: "2026-05-15T12:00:01.000Z",
      },
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
      assistantResponses: 1,
      runtimeMs: 2000,
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

  test("counts a single streamed answer as one assistant response, not one per delta", async () => {
    // GIVEN a run whose one exchange is a single answer streamed as many
    // `assistant_text_delta` events — the shape that made the report read
    // "10 turns" for what a reader sees as one user↔assistant exchange
    const runId = await freshRunId("responses");
    const artifacts = runArtifacts(runId);
    await writeRunMetadata(runId, {
      runId,
      sessionId: `session-${runId}`,
      profileId: "p1",
      testId: "t1",
      status: "completed",
      startedAt: "2026-05-15T12:00:00.000Z",
      completedAt: "2026-05-15T12:03:53.000Z",
      artifactDir: artifacts.runDir,
    });
    await appendTranscriptTurn(runId, {
      role: "simulator",
      content: "Which category did we spend the most on?",
      emittedAt: "2026-05-15T12:00:00.000Z",
    });
    // AND nine streamed fragments of the one assistant reply
    const deltas = [
      "We ",
      "spent ",
      "the ",
      "most ",
      "on ",
      "Labor ",
      "at ",
      "$48,069",
      ".",
    ];
    await appendAssistantEvents(
      runId,
      deltas.map((text, index) => ({
        message: { type: "assistant_text_delta", text },
        emittedAt: `2026-05-15T12:00:0${index}.000Z`,
      })),
    );

    // WHEN the run is summarized for the report
    const detail = await readReportRun(runId);

    // THEN the deltas fold into one response and runtime is wall-clock
    expect(detail.assistantResponses).toBe(1);
    expect(detail.runtimeMs).toBe(233000);
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

  test("cliArgv is captured on each run summary and surfaced on the session summary", async () => {
    // `commands/run.ts` stamps the originating `process.argv` onto
    // every `RunMetadata` it writes; the report layer is responsible
    // for plumbing it through `summarizeRun` and `summarizeSession`
    // so the UI can render a copy-pasteable command. This guards the
    // pass-through end-to-end: the argv is on the per-run summary,
    // and the session summary lifts it from the first run.
    const sessionTag = `session-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runIdA = await freshRunId("cli-a");
    const runIdB = await freshRunId("cli-b");
    const argv = [
      "/usr/local/bin/bun",
      "/repo/evals/src/cli.ts",
      "run",
      "--benchmark=longmemeval-v2",
      "--profiles=vellum-simple-memory",
      "--filter=057a2d4d",
      "--label=tier-b-smoke",
    ];

    await Promise.all([
      writeRunMetadata(runIdA, {
        runId: runIdA,
        sessionId: sessionTag,
        sessionLabel: "tier-b-smoke",
        cliArgv: argv,
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
        sessionLabel: "tier-b-smoke",
        cliArgv: argv,
        profileId: "p2",
        testId: "t1",
        status: "completed",
        startedAt: "2026-05-15T12:00:02.000Z",
        completedAt: "2026-05-15T12:00:03.000Z",
        artifactDir: runArtifacts(runIdB).runDir,
      }),
    ]);

    await writeMetricResults(runIdA, [{ name: "acc", score: 1 }]);
    await writeMetricResults(runIdB, [{ name: "acc", score: 1 }]);

    const sessions = await listReportSessions();
    const match = sessions.find((session) => session.sessionId === sessionTag);
    expect(match?.cliArgv).toEqual(argv);
  });

  test("legacy run metadata without cliArgv leaves the field undefined on summaries", async () => {
    // Defensive: legacy run.json files predate the field. The summary
    // layer must not synthesize a placeholder — the UI suppresses the
    // CLI block when `cliArgv` is undefined, and we want this contract
    // to hold even after the readers go through `summarize`.
    const sessionTag = `session-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runId = await freshRunId("legacy-cli");

    await writeRunMetadata(runId, {
      runId,
      sessionId: sessionTag,
      profileId: "p1",
      testId: "t1",
      status: "completed",
      startedAt: "2026-05-15T12:00:00.000Z",
      completedAt: "2026-05-15T12:00:01.000Z",
      artifactDir: runArtifacts(runId).runDir,
    });
    await writeMetricResults(runId, [{ name: "acc", score: 1 }]);

    const sessions = await listReportSessions();
    const match = sessions.find((session) => session.sessionId === sessionTag);
    expect(match?.cliArgv).toBeUndefined();
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

  test("readProfileInSession exposes every test score + manifest for one profile", async () => {
    // GIVEN a session where profile p1 ran two tests and p2 ran one,
    // and p1's run carries a manifest snapshot
    const sessionTag = `session-profile-detail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runIdA = await freshRunId("profile-detail-a");
    const runIdB = await freshRunId("profile-detail-b");
    const runIdC = await freshRunId("profile-detail-c");

    await Promise.all([
      writeRunMetadata(runIdA, {
        runId: runIdA,
        sessionId: sessionTag,
        profileId: "p1",
        profileManifest: {
          species: "vellum",
          description: "bare baseline",
        },
        testId: "t1",
        status: "completed",
        artifactDir: runArtifacts(runIdA).runDir,
      }),
      writeRunMetadata(runIdB, {
        runId: runIdB,
        sessionId: sessionTag,
        profileId: "p1",
        testId: "t2",
        status: "completed",
        artifactDir: runArtifacts(runIdB).runDir,
      }),
      writeRunMetadata(runIdC, {
        runId: runIdC,
        sessionId: sessionTag,
        profileId: "p2",
        testId: "t1",
        status: "completed",
        artifactDir: runArtifacts(runIdC).runDir,
      }),
    ]);

    await writeMetricResults(runIdA, [{ name: "acc", score: 1 }]);
    await writeMetricResults(runIdB, [{ name: "acc", score: 0 }]);
    await writeMetricResults(runIdC, [{ name: "acc", score: 0.5 }]);

    // WHEN we read the profile drill-in for p1
    const profile = await readProfileInSession(sessionTag, "p1");

    // THEN it lists only p1's two tests, with its manifest and overall score
    expect(profile).toBeDefined();
    expect(profile?.info?.description).toBe("bare baseline");
    expect(profile?.tests.map((t) => t.testId)).toEqual(["t1", "t2"]);
    // AND the overall score is the equal-weighted mean of p1's runs (1, 0)
    expect(profile?.scoreTotal).toBeCloseTo(0.5, 10);
  });

  test("readProfileInSession returns undefined for an unknown profile", async () => {
    // GIVEN a session with no run for the requested profile
    // WHEN/THEN reading a missing profile resolves to undefined
    expect(
      await readProfileInSession("no-such-session", "ghost"),
    ).toBeUndefined();
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

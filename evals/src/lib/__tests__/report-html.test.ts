import { describe, expect, test } from "bun:test";

import { renderReportPage } from "../report-html";
import type { ReportRunDetail, ReportRunSummary } from "../report-data";

const summary: ReportRunSummary = {
  runId: "run-1",
  profileId: "p1",
  testId: "t1",
  status: "completed",
  startedAt: "2026-05-15T12:00:00.000Z",
  completedAt: "2026-05-15T12:00:01.000Z",
  metricCount: 1,
  scoreTotal: 1,
  transcriptTurns: 1,
  assistantEventCount: 1,
  simulatorMessageCount: 1,
  totalInputTokens: 10,
  totalOutputTokens: 5,
  totalCostUsd: 0.001,
};

const detail: ReportRunDetail = {
  ...summary,
  metadata: {
    runId: "run-1",
    profileId: "p1",
    testId: "t1",
    status: "completed",
    startedAt: "2026-05-15T12:00:00.000Z",
    completedAt: "2026-05-15T12:00:01.000Z",
    artifactDir: ".runs/run-1",
  },
  metrics: [{ name: "accuracy", score: 1, reason: "matched <script>" }],
  transcript: [
    {
      role: "assistant",
      content: "Remembered <b>the date</b>",
      emittedAt: "2026-05-15T12:00:01.000Z",
    },
  ],
  usage: {
    requests: [{ model: "test" }],
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalCostUsd: 0.001,
  },
  assistantEvents: [
    { message: { type: "assistant_text_delta", text: "hello" } },
  ],
  simulatorMessages: [{ content: "hello" }],
};

describe("report html", () => {
  test("renders a report card with escaped metric and transcript content", () => {
    const html = renderReportPage({ runs: [summary], selectedRun: detail });

    expect(html).toContain("Eval report card");
    expect(html).toContain("accuracy");
    expect(html).toContain("matched &lt;script&gt;");
    expect(html).toContain("Remembered &lt;b&gt;the date&lt;/b&gt;");
    expect(html).not.toContain("matched <script>");
    expect(html).toContain("$0.001000");
  });

  test("renders an empty state when no runs exist", () => {
    const html = renderReportPage({ runs: [] });

    expect(html).toContain("No runs yet");
    expect(html).toContain("evals run --profiles p1,p2 --tests t1");
  });
});

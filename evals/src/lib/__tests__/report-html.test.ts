import { describe, expect, test } from "bun:test";

import { renderReportPage } from "../report-html";
import type {
  ReportRunDetail,
  ReportSessionDetail,
  ReportSessionSummary,
  ReportTestInSession,
} from "../report-data";

const sessionSummary: ReportSessionSummary = {
  sessionId: "session-1",
  sessionLabel: "first-comparison",
  runCount: 2,
  profileIds: ["p1", "p2"],
  testIds: ["t1"],
  startedAt: "2026-05-15T12:00:00.000Z",
  completedAt: "2026-05-15T12:00:02.000Z",
  scoreTotal: 1.5,
  status: "completed",
};

const sessionDetail: ReportSessionDetail = {
  ...sessionSummary,
  profiles: [
    {
      profileId: "p1",
      runCount: 1,
      completedCount: 1,
      failedCount: 0,
      runningCount: 0,
      scoreTotal: 1,
      scoreAverage: 1,
    },
    {
      profileId: "p2",
      runCount: 1,
      completedCount: 1,
      failedCount: 0,
      runningCount: 0,
      scoreTotal: 0.5,
      scoreAverage: 0.5,
    },
  ],
  tests: [
    {
      testId: "t1",
      profiles: [
        {
          profileId: "p1",
          runId: "run-p1",
          status: "completed",
          scoreTotal: 1,
        },
        {
          profileId: "p2",
          runId: "run-p2",
          status: "completed",
          scoreTotal: 0.5,
        },
      ],
    },
  ],
};

const testInSession: ReportTestInSession = {
  sessionId: "session-1",
  sessionLabel: "first-comparison",
  testId: "t1",
  profiles: [
    {
      profileId: "p1",
      runId: "run-p1",
      status: "completed",
      scoreTotal: 1,
      metricCount: 1,
      metrics: [{ name: "accuracy", score: 1 }],
      transcriptTurns: 2,
      totalCostUsd: 0.001,
    },
    {
      profileId: "p2",
      runId: "run-p2",
      status: "completed",
      scoreTotal: 0.5,
      metricCount: 1,
      metrics: [{ name: "accuracy", score: 0.5 }],
      transcriptTurns: 2,
      totalCostUsd: 0.0012,
    },
  ],
};

const executionDetail: ReportRunDetail = {
  runId: "run-p1",
  sessionId: "session-1",
  sessionLabel: "first-comparison",
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
  metadata: {
    runId: "run-p1",
    sessionId: "session-1",
    sessionLabel: "first-comparison",
    profileId: "p1",
    testId: "t1",
    status: "completed",
    startedAt: "2026-05-15T12:00:00.000Z",
    completedAt: "2026-05-15T12:00:01.000Z",
    artifactDir: ".runs/run-p1",
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
  progressEvents: [
    {
      step: "hatch",
      status: "done",
      message: "Assistant ready",
      emittedAt: "2026-05-15T12:00:00.500Z",
    },
  ],
};

describe("report html", () => {
  test("index page lists sessions and points each card at /sessions/<id>", () => {
    const html = renderReportPage({
      kind: "index",
      sessions: [sessionSummary],
    });
    expect(html).toContain("Eval report card");
    expect(html).toContain("first-comparison");
    expect(html).toContain("session-1");
    expect(html).toContain('href="/sessions/session-1"');
    // No sidebar — the index is full-width.
    expect(html).not.toContain('class="sidebar"');
  });

  test("empty index page renders the bootstrap hint", () => {
    const html = renderReportPage({ kind: "index", sessions: [] });
    expect(html).toContain("No runs yet");
    expect(html).toContain("evals run --profiles p1,p2 --tests t1");
  });

  test("session page shows per-profile aggregates and per-test rows", () => {
    const html = renderReportPage({ kind: "session", session: sessionDetail });
    expect(html).toContain("first-comparison");
    expect(html).toContain("Profile scores");
    expect(html).toContain("p1");
    expect(html).toContain("p2");
    // Tests list points at the test-in-session route.
    expect(html).toContain('href="/sessions/session-1/tests/t1"');
    // Back navigation to the index.
    expect(html).toContain('href="/"');
  });

  test("test-in-session page renders profile rows and a metric breakdown", () => {
    const html = renderReportPage({ kind: "test", test: testInSession });
    expect(html).toContain("Profiles");
    expect(html).toContain("Metric breakdown");
    expect(html).toContain('href="/sessions/session-1/tests/t1/profiles/p1"');
    expect(html).toContain('href="/sessions/session-1/tests/t1/profiles/p2"');
    expect(html).toContain("accuracy");
    // Breadcrumbs back to session.
    expect(html).toContain('href="/sessions/session-1"');
  });

  test("execution page shows transcript, container logs, runner logs, and NO raw JSON section", () => {
    const html = renderReportPage({ kind: "execution", run: executionDetail });
    expect(html).toContain("Container logs");
    expect(html).toContain("Test runner logs");
    expect(html).toContain("Assistant ready"); // progress event message
    expect(html).toContain("[hatch/done]"); // progress log tag formatting
    expect(html).toContain("matched &lt;script&gt;");
    expect(html).toContain("Remembered &lt;b&gt;the date&lt;/b&gt;");
    // No raw JSON section anywhere.
    expect(html).not.toContain("Raw data");
    expect(html).not.toContain("Open JSON payload");
    expect(html).not.toContain("runs-data");
    // Breadcrumbs to test and session.
    expect(html).toContain('href="/sessions/session-1/tests/t1"');
    expect(html).toContain('href="/sessions/session-1"');
  });

  test("not-found page links back to the index", () => {
    const html = renderReportPage({
      kind: "not-found",
      message: "No session session-x.",
    });
    expect(html).toContain("Not found");
    expect(html).toContain("No session session-x");
    expect(html).toContain('href="/"');
  });

  test("metric scores render as percentages by default (round-3 evals feedback)", () => {
    // accuracy: 0.5 → 50.00%, 1.0 → 100.00%. The previous raw rendering
    // ("0.5000", "1.0000") is what Vargas asked us to fix.
    const html = renderReportPage({ kind: "test", test: testInSession });
    expect(html).toContain("100.00%");
    expect(html).toContain("50.00%");
  });

  test("metrics with unit: 'raw' opt out of percent rendering", () => {
    // assistant-cost-usd returns negative dollars and would be nonsense as a
    // percent. The unit field lets it fall back to plain number rendering.
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        metrics: [
          { name: "accuracy", score: 0.75 },
          {
            name: "assistant-cost-usd",
            score: -0.012_345,
            unit: "raw",
          },
        ],
      },
    });
    expect(html).toContain("75.00%");
    // Raw renders via formatNumber(score, 4)
    expect(html).toContain("-0.0123");
    expect(html).not.toContain("-1.23%");
  });

  test("execution page surfaces cost diagnostics when costStatus is partial", () => {
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        usage: {
          ...executionDetail.usage,
          costStatus: "partial",
          costDiagnostics: [
            {
              requestIndex: 1,
              reason: "missing_provider",
              model: "claude-sonnet-4-5",
            },
            {
              requestIndex: 2,
              reason: "unpriced_model",
              provider: "cohere",
              model: "command-r-plus",
            },
          ],
        },
      },
    });
    expect(html).toContain("Cost pricing");
    expect(html).toContain("Partial pricing");
    // The COST_REASON_LABELS copy is human-readable, not the bare key.
    expect(html).toContain("No provider on usage record");
    expect(html).toContain("cohere");
    expect(html).toContain("command-r-plus");
    // The reason copy mentions where to bump the table.
    expect(html).toContain("evals/src/lib/pricing.ts");
  });

  test("execution page hides cost diagnostics when costStatus is ok or unset", () => {
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        usage: { ...executionDetail.usage, costStatus: "ok" },
      },
    });
    expect(html).not.toContain("Cost pricing");
    expect(html).not.toContain("Partial pricing");
    expect(html).not.toContain("Cost unavailable");
  });
});

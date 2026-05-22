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
  scoreTotal: 0.75,
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
    },
    {
      profileId: "p2",
      runCount: 1,
      completedCount: 1,
      failedCount: 0,
      runningCount: 0,
      scoreTotal: 0.5,
    },
  ],
  tests: [
    {
      testId: "t1",
      scoreTotal: 0.75,
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
  subprocessLogs: [],
  dockerArtifacts: [],
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

  test("metric and aggregate scores render as percentages", () => {
    // accuracy: 0.5 → 50.00%, 1.0 → 100.00%. The previous raw rendering
    // ("0.5000", "1.0000") is what Vargas asked us to fix.
    const html = renderReportPage({ kind: "test", test: testInSession });
    expect(html).toContain("100.00%");
    expect(html).toContain("50.00%");

    const executionHtml = renderReportPage({
      kind: "execution",
      run: executionDetail,
    });
    expect(executionHtml).toContain(">100.00%</div>");
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

  // -- no-silent-stuck UI surfaces -------------------------------------------

  test("index page renders a Delete-all form only when there are sessions", () => {
    // The form is the entire interactive contract now — POST to the
    // server-side endpoint, server 303-redirects back to `/`. No client
    // JS involved, so we just assert the form markup is there.
    const populated = renderReportPage({
      kind: "index",
      sessions: [sessionSummary],
    });
    expect(populated).toContain('action="/api/runs/delete-all"');
    expect(populated).toContain('method="post"');
    expect(populated).toContain("Delete all non-running");

    const empty = renderReportPage({ kind: "index", sessions: [] });
    expect(empty).not.toContain('action="/api/runs/delete-all"');
    expect(empty).not.toContain("Delete all non-running");
  });

  test("pages ship no client-side JS — every delete is a plain HTML form", () => {
    // The old implementation injected an IIFE that did fetch+delete. The
    // current implementation is hydration-free: <details> + <form method="post">
    // with the server returning 303s. If a <script> tag ever sneaks back in,
    // someone's reintroduced the hacky-html pattern.
    const index = renderReportPage({
      kind: "index",
      sessions: [sessionSummary],
    });
    const execution = renderReportPage({
      kind: "execution",
      run: { ...executionDetail, status: "failed" },
    });
    for (const html of [index, execution]) {
      expect(html).not.toMatch(/<script\b/i);
      // And no React-synthetic onClick attribute leaked through (renderToStaticMarkup
      // strips them today; this guards against a future switch to renderToString).
      expect(html).not.toMatch(/\sonClick=/i);
      expect(html).not.toMatch(/\sonSubmit=/i);
    }
  });

  test("execution page surfaces docker forensics artifacts as links to the file endpoint", () => {
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        status: "failed",
        dockerArtifacts: ["docker-inspect.json", "docker-logs.txt"],
      },
    });
    expect(html).toContain("Docker snapshot");
    expect(html).toContain("docker-inspect.json");
    expect(html).toContain(
      `/api/runs/${encodeURIComponent(executionDetail.runId)}/files/docker-inspect.json`,
    );
    expect(html).toContain(
      `/api/runs/${encodeURIComponent(executionDetail.runId)}/files/docker-logs.txt`,
    );
  });

  test("execution page surfaces subprocess logs as links to the file endpoint", () => {
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        status: "failed",
        subprocessLogs: ["subprocess-hatch.log", "subprocess-setup-1.log"],
      },
    });
    expect(html).toContain("Subprocess logs");
    expect(html).toContain("subprocess-hatch.log");
    expect(html).toContain("subprocess-setup-1.log");
    expect(html).toContain(
      `/api/runs/${encodeURIComponent(executionDetail.runId)}/files/subprocess-hatch.log`,
    );
  });

  test("execution page omits Docker/Subprocess sections when there are no artifacts", () => {
    const html = renderReportPage({ kind: "execution", run: executionDetail });
    expect(html).not.toContain("Docker snapshot");
    expect(html).not.toContain("Subprocess logs");
  });

  test("execution page exposes a Delete-run POST form with backToSession hidden field when the run failed", () => {
    // Debug section only fires for non-completed runs or when there's an
    // error/heartbeat to surface — gate it explicitly with `failed`.
    const html = renderReportPage({
      kind: "execution",
      run: { ...executionDetail, status: "failed" },
    });
    expect(html).toContain(
      `action="/api/runs/${encodeURIComponent(executionDetail.runId)}/delete"`,
    );
    expect(html).toContain('method="post"');
    expect(html).toContain('name="backToSession"');
    expect(html).toContain(`value="${executionDetail.sessionId}"`);
    // Summary + confirm-button copy still ships.
    expect(html).toContain("Delete run");
    expect(html).toContain("Yes, delete this run");
  });
});

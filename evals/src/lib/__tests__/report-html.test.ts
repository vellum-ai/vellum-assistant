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
  ingestAssistantEvents: [],
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

  test("execution page renders the Memory-formation events section with the V1-empty placeholder", () => {
    // Default fixture has `ingestAssistantEvents: []` (a V1-shaped run) —
    // the section still renders so V1/V2 share one URL shape, and the
    // empty-state copy is ingest-specific rather than the generic
    // container-events default.
    const html = renderReportPage({ kind: "execution", run: executionDetail });
    expect(html).toContain("Memory-formation events");
    expect(html).toContain("No memory-formation events recorded.");
  });

  test("execution page surfaces ingest-turn events in the Memory-formation section when present", () => {
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        ingestAssistantEvents: [
          {
            message: {
              type: "assistant_text_delta",
              text: "indexing-session-1",
            },
            emittedAt: "2026-05-15T12:00:00.250Z",
          },
        ],
      },
    });
    // The Memory-formation section ships ingest events; the Container-logs
    // section (question-turn) still ships the original "hello" event. Both
    // strings appear, neither leaks across.
    expect(html).toContain("indexing-session-1");
    expect(html).toContain("hello");
    expect(html).not.toContain("No memory-formation events recorded.");
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

  test("execution page inlines docker forensics in the same block shape as subprocess logs", () => {
    // Vargas's request: the Docker snapshot section reads in the same
    // scroll as the subprocess logs below it — no clicking through to
    // a raw file just to see why hatch crashed. JSON inspects are
    // pretty-printed; text logs render verbatim. A sibling `raw` link
    // still points at the file endpoint for downloads / large logs.
    const inspectContent = JSON.stringify({
      State: { ExitCode: 137, OOMKilled: true },
      HostConfig: { PortBindings: { "8000/tcp": [{ HostPort: "8000" }] } },
    });
    const logsContent =
      "2026-05-25T00:25:30Z fatal: bind: address already in use\n";
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        status: "failed",
        dockerArtifacts: [
          {
            name: "docker-inspect-assistant.json",
            content: inspectContent,
            kind: "json",
          },
          {
            name: "docker-logs-assistant.txt",
            content: logsContent,
            kind: "text",
          },
        ],
      },
    });
    expect(html).toContain("Docker snapshot");
    // Filename labels above each block.
    expect(html).toContain("docker-inspect-assistant.json");
    expect(html).toContain("docker-logs-assistant.txt");
    // Inline content — pretty-printed JSON keys + the actual log line,
    // not just the filename or a link.
    expect(html).toContain("OOMKilled");
    expect(html).toContain("ExitCode");
    expect(html).toContain("bind: address already in use");
    // Raw download links still emitted as a sibling per block.
    expect(html).toContain(
      `/api/runs/${encodeURIComponent(executionDetail.runId)}/files/docker-inspect-assistant.json`,
    );
    expect(html).toContain(
      `/api/runs/${encodeURIComponent(executionDetail.runId)}/files/docker-logs-assistant.txt`,
    );
  });

  test("execution page inlines subprocess logs in the same format as the test runner log", () => {
    // Vargas's r2 feedback: each subprocess log must render inline,
    // line-by-line, in the same `[ts] [step] glyph msg` shape the
    // runner log already uses — no more clicking through to a raw
    // file just to see why hatch failed. The raw download is still
    // available via a sibling `raw` link.
    const hatchContent =
      "[2026-05-23 14:42:05] [hatch]     \u2022 @vellumai/cli v0.8.4\n" +
      "[2026-05-23 14:42:06] [hatch]     \u2717 docker: bind: address already in use\n";
    const setupContent =
      "[2026-05-23 14:42:08] [setup-1]   \u2022 assistant plugins install simple-memory\n";
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        status: "failed",
        subprocessLogs: [
          { name: "subprocess-hatch.log", content: hatchContent },
          { name: "subprocess-setup-1.log", content: setupContent },
        ],
      },
    });
    expect(html).toContain("Subprocess logs");
    // Filename labels above each block.
    expect(html).toContain("subprocess-hatch.log");
    expect(html).toContain("subprocess-setup-1.log");
    // Inline content — the actual lines, not just the filename.
    expect(html).toContain("@vellumai/cli v0.8.4");
    expect(html).toContain("bind: address already in use");
    expect(html).toContain("assistant plugins install simple-memory");
    // Tag column reuses the runner log's `[step/glyph]` shape so the
    // operator can read both panels with the same eye scan. React
    // escapes the bullet/cross glyphs as HTML entities.
    expect(html).toMatch(/\[hatch\/(?:&#x2022;|&bull;|\u2022)\]/);
    expect(html).toMatch(/\[hatch\/(?:&#x2717;|\u2717)\]/);
    expect(html).toMatch(/\[setup-1\/(?:&#x2022;|&bull;|\u2022)\]/);
    // No legacy `[STDOUT]` / `[STDERR]` markers leak through.
    expect(html).not.toContain("[STDOUT]");
    expect(html).not.toContain("[STDERR]");
    // Raw download link still present for piping into other tools.
    expect(html).toContain(
      `/api/runs/${encodeURIComponent(executionDetail.runId)}/files/subprocess-hatch.log`,
    );
    expect(html).toContain(">raw</a>");
  });

  test("execution page renders unparsable subprocess content as raw lines", () => {
    // Legacy `[STDOUT] foo` / `[STDERR] bar` log files (predate r2) or
    // anything else that doesn't match the canonical `[ts] [step] glyph
    // msg` shape should still appear — fall back to a one-column row
    // so an operator inspecting an older run can still read the log.
    const legacyContent =
      "[STDOUT] legacy line without timestamp\nfree-form garbage\n";
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        status: "failed",
        subprocessLogs: [
          { name: "subprocess-hatch.log", content: legacyContent },
        ],
      },
    });
    expect(html).toContain("[STDOUT] legacy line without timestamp");
    expect(html).toContain("free-form garbage");
  });

  test("execution page renders the (empty) placeholder when a subprocess log file is empty", () => {
    // An empty file means the subprocess emitted zero output; don't
    // collapse the section since the operator may still want to
    // click through to the raw endpoint (or notice the absence).
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        status: "failed",
        subprocessLogs: [{ name: "subprocess-hatch.log", content: "" }],
      },
    });
    expect(html).toContain("subprocess-hatch.log");
    expect(html).toContain("(empty)");
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

import { describe, expect, test } from "bun:test";

import { formatCliCommand, renderReportPage } from "../report-html";
import type {
  ReportProfileInSession,
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
      assistantResponses: 1,
      runtimeMs: 1000,
      totalCostUsd: 0.001,
    },
    {
      profileId: "p2",
      runId: "run-p2",
      status: "completed",
      scoreTotal: 0.5,
      metricCount: 1,
      metrics: [{ name: "accuracy", score: 0.5 }],
      assistantResponses: 3,
      runtimeMs: 173000,
      totalCostUsd: 0.0012,
    },
  ],
};

const profileInSession: ReportProfileInSession = {
  sessionId: "session-1",
  sessionLabel: "first-comparison",
  profileId: "p1",
  info: {
    species: "vellum",
    description: "The bare baseline profile, no plugins.",
    setup: ["assistant plugins install simple-memory"],
  },
  scoreTotal: 1,
  tests: [
    {
      testId: "t1",
      runId: "run-p1",
      status: "completed",
      scoreTotal: 1,
      metricCount: 1,
      metrics: [{ name: "accuracy", score: 1 }],
      assistantResponses: 1,
      runtimeMs: 1000,
      totalCostUsd: 0.001,
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
  assistantResponses: 1,
  runtimeMs: 1000,
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
    {
      message: {
        type: "assistant_text_delta",
        text: "Remembered <b>the date</b>",
      },
      emittedAt: "2026-05-15T12:00:01.000Z",
    },
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
    // Profile cards drill into the per-profile page.
    expect(html).toContain('href="/sessions/session-1/profiles/p1"');
    expect(html).toContain('href="/sessions/session-1/profiles/p2"');
    // Back navigation to the index.
    expect(html).toContain('href="/"');
  });

  test("profile-in-session page renders the info panel and per-test scores", () => {
    // GIVEN a profile drill-in with a manifest and one test
    // WHEN we render the profile page
    const html = renderReportPage({
      kind: "profile",
      profile: profileInSession,
    });
    // THEN the info panel surfaces the manifest fields
    expect(html).toContain("Species");
    expect(html).toContain("The bare baseline profile, no plugins.");
    expect(html).toContain("assistant plugins install simple-memory");
    // AND the test scores link to the execution page for this profile
    expect(html).toContain("Test scores");
    expect(html).toContain('href="/sessions/session-1/tests/t1/profiles/p1"');
    // AND breadcrumbs go back to the session
    expect(html).toContain('href="/sessions/session-1"');
  });

  test("test-in-session page renders profile rows with response counts and runtime, and no metric breakdown", () => {
    // WHEN the test comparison page renders the two profile rows
    const html = renderReportPage({ kind: "test", test: testInSession });

    // THEN it shows the Profiles table linking to each profile's drill-in
    expect(html).toContain("Profiles");
    expect(html).toContain('href="/sessions/session-1/tests/t1/profiles/p1"');
    expect(html).toContain('href="/sessions/session-1/tests/t1/profiles/p2"');

    // AND it surfaces a Responses column (folded assistant replies) and a
    // formatted Runtime column rather than raw transcript-entry counts
    expect(html).toContain("Responses");
    expect(html).toContain("Runtime");
    expect(html).toContain("2m 53s");

    // AND the standalone per-metric breakdown section is gone
    expect(html).not.toContain("Metric breakdown");

    // AND breadcrumbs link back to the session
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
    // section (question-turn) still ships the original question-turn event.
    // Both strings appear, neither leaks across.
    expect(html).toContain("indexing-session-1");
    expect(html).toContain("Remembered");
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

  test("execution page renders assistant text as Markdown", () => {
    // GIVEN an assistant answer streamed as Markdown (a bold lead + a list)
    const run: ReportRunDetail = {
      ...executionDetail,
      transcript: [
        {
          role: "assistant",
          content: "**Labor** is the top category:\n\n- Labor\n- Food",
          emittedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
      assistantEvents: [
        {
          message: {
            type: "assistant_text_delta",
            text: "**Labor** is the top category:\n\n- Labor\n- Food",
          },
          emittedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    };

    // WHEN the execution page renders
    const html = renderReportPage({ kind: "execution", run });

    // THEN the Markdown is rendered to real elements, not shown as raw syntax
    expect(html).toContain('<div class="md">');
    expect(html).toContain("<strong>Labor</strong>");
    expect(html).toContain("<li>Labor</li>");
    // AND the rendered transcript block carries no raw Markdown markers (the
    // raw event log legitimately still echoes the source delta verbatim)
    const md = html.slice(
      html.indexOf('<div class="md">'),
      html.indexOf("</div>", html.indexOf('<div class="md">')),
    );
    expect(md).not.toContain("**Labor**");
  });

  test("execution page escapes raw HTML in assistant Markdown", () => {
    // GIVEN an assistant answer containing raw HTML
    const run: ReportRunDetail = {
      ...executionDetail,
      transcript: [
        {
          role: "assistant",
          content: "<img src=x onerror=alert(1)> done",
          emittedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
      assistantEvents: [
        {
          message: {
            type: "assistant_text_delta",
            text: "<img src=x onerror=alert(1)> done",
          },
          emittedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    };

    // WHEN the execution page renders
    const html = renderReportPage({ kind: "execution", run });

    // THEN the raw tag is escaped, never emitted as live markup
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<img\b/i);
  });

  test("execution page renders Markdown images as inert links, not auto-loading <img>", () => {
    // GIVEN an assistant answer with a Markdown image pointing at an external URL
    const run: ReportRunDetail = {
      ...executionDetail,
      transcript: [
        {
          role: "assistant",
          content: "Here it is: ![the chart](https://tracker.example/p.png)",
          emittedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
      assistantEvents: [
        {
          message: {
            type: "assistant_text_delta",
            text: "Here it is: ![the chart](https://tracker.example/p.png)",
          },
          emittedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    };

    // WHEN the execution page renders
    const html = renderReportPage({ kind: "execution", run });

    // THEN the image becomes a link carrying the alt text and destination
    expect(html).toContain(
      '<a class="md-image-link" href="https://tracker.example/p.png"',
    );
    expect(html).toContain(">the chart</a>");
    // AND no <img> element is emitted, so opening the report fetches nothing
    expect(html).not.toMatch(/<img\b/i);
  });

  test("execution page stamps each turn with its end time at the foot", () => {
    // GIVEN an answer whose deltas stream over a span (first 12:00:01, last 12:00:09)
    const run: ReportRunDetail = {
      ...executionDetail,
      transcript: [],
      simulatorMessages: [{ content: "which category?" }],
      assistantEvents: [
        {
          message: { type: "assistant_text_delta", text: "Labor " },
          emittedAt: "2026-05-15T12:00:01.000Z",
        },
        {
          message: { type: "assistant_text_delta", text: "leads." },
          emittedAt: "2026-05-15T12:00:09.000Z",
        },
      ],
    };

    // WHEN the execution page renders
    const html = renderReportPage({ kind: "execution", run });

    // THEN the turn's foot timestamp reads the LAST delta (12:00:09), not the
    // first (12:00:01) — closing the gap where a long answer showed its start
    expect(html).toContain('<div class="turn-time">12:00:09Z</div>');
  });

  test("execution page exposes per-chunk run time with a start-time tooltip", () => {
    // GIVEN a streamed answer spanning 8 seconds
    const run: ReportRunDetail = {
      ...executionDetail,
      transcript: [],
      assistantEvents: [
        {
          message: { type: "assistant_text_delta", text: "Labor " },
          emittedAt: "2026-05-15T12:00:01.000Z",
        },
        {
          message: { type: "assistant_text_delta", text: "leads." },
          emittedAt: "2026-05-15T12:00:09.000Z",
        },
      ],
    };

    // WHEN the execution page renders
    const html = renderReportPage({ kind: "execution", run });

    // THEN the chunk shows its 8.0s run time, with the start time in its title
    expect(html).toContain('class="chunk-duration"');
    expect(html).toContain("8.0s");
    expect(html).toContain('title="started 12:00:01Z"');
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
    // The execution page renders the aggregate score in the Score tab pill
    // and each metric's score in the report card — both as percentages.
    expect(executionHtml).toContain(">100.00%</span>");
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

  test("execution page Logs pill shows the total log size, not a count", () => {
    // GIVEN a run with a subprocess log of known size
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        subprocessLogs: [
          { name: "subprocess-hatch.log", content: "x".repeat(2048) },
        ],
      },
    });

    // THEN the Logs pill reports a byte size (KB), never a bare block count
    const logsPill = html.slice(html.indexOf(">Logs<"));
    expect(logsPill).toContain("KB");
  });

  test("execution page renders a per-request cost breakdown with per-row cost", () => {
    // GIVEN two priced Anthropic requests of different sizes
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        usage: {
          requests: [
            {
              provider: "anthropic",
              model: "claude-haiku-4-5",
              input_tokens: 1000,
              output_tokens: 1000,
            },
            {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              input_tokens: 1_000_000,
              output_tokens: 1_000_000,
            },
          ],
          costStatus: "ok",
        },
      },
    });

    // THEN the breakdown lists each model and its individually-priced cost
    expect(html).toContain("Per-request breakdown");
    expect(html).toContain("claude-haiku-4-5");
    expect(html).toContain("claude-sonnet-4-6");
    // sonnet-4-6 at 1M in + 1M out = $3 + $15 = $18.000000
    expect(html).toContain("$18.000000");
  });

  test("per-request breakdown is ordered newest-first with timestamps and chronological indices", () => {
    // GIVEN two requests recorded five seconds apart, stored in chronological
    // (oldest-first) order as the recorder appends them
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        usage: {
          requests: [
            {
              provider: "anthropic",
              model: "model-oldest",
              input_tokens: 10,
              output_tokens: 10,
              recorded_at: "2026-06-13T10:00:00Z",
            },
            {
              provider: "anthropic",
              model: "model-newest",
              input_tokens: 20,
              output_tokens: 20,
              recorded_at: "2026-06-13T10:00:05Z",
            },
          ],
          costStatus: "ok",
        },
      },
    });

    // THEN the table carries a Time column
    expect(html).toContain("<th>Time</th>");
    // AND both recorded times render as compact UTC time-of-day
    expect(html).toContain("10:00:05Z");
    expect(html).toContain("10:00:00Z");
    // AND the newest request is rendered above the oldest
    expect(html.indexOf("model-newest")).toBeLessThan(
      html.indexOf("model-oldest"),
    );
    // AND each row keeps its chronological index, so the newest (top) row
    // carries the higher index — the `#` column counts down top-to-bottom
    expect(html.indexOf("<td>1</td>")).toBeLessThan(html.indexOf("<td>0</td>"));
  });

  test("per-request breakdown shows each request's round-trip latency next to its time", () => {
    // GIVEN two requests: one with a multi-second latency, one sub-second, and
    // one with no recorded latency at all
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        usage: {
          requests: [
            {
              provider: "anthropic",
              model: "model-slow",
              input_tokens: 10,
              output_tokens: 10,
              recorded_at: "2026-06-13T10:00:00Z",
              duration_ms: 2340,
            },
            {
              provider: "anthropic",
              model: "model-fast",
              input_tokens: 20,
              output_tokens: 20,
              recorded_at: "2026-06-13T10:00:05Z",
              duration_ms: 840,
            },
            {
              provider: "anthropic",
              model: "model-untimed",
              input_tokens: 5,
              output_tokens: 5,
              recorded_at: "2026-06-13T10:00:10Z",
            },
          ],
          costStatus: "ok",
        },
      },
    });

    // THEN seconds-scale latency renders as one-decimal seconds, sub-second as
    // whole ms, and a missing latency falls back to an em dash
    expect(html).toContain("(2.3s)");
    expect(html).toContain("(840ms)");
    expect(html).toContain("(—)");
  });

  test("execution page inlines captured request/response payloads, noting truncation", () => {
    // GIVEN a request whose response payload was truncated by the recorder
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        usage: {
          requests: [
            {
              provider: "anthropic",
              model: "claude-haiku-4-5",
              input_tokens: 10,
              output_tokens: 10,
              request_body: '{"messages":[]}',
              request_body_bytes: 15,
              request_body_truncated: false,
              response_body: "STREAM-CHUNK-PREFIX",
              response_body_bytes: 100000,
              response_body_truncated: true,
            },
          ],
          costStatus: "ok",
        },
      },
    });

    // THEN both payloads render and the truncated one notes the full size
    expect(html).toContain("Request &amp; response payloads");
    // React escapes double quotes in text content (&quot;).
    expect(html).toContain("{&quot;messages&quot;:[]}");
    expect(html).toContain("STREAM-CHUNK-PREFIX");
    expect(html).toContain("showing first");
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

  test("pages ship no hacky JS — deletes are plain HTML forms, no fetch IIFE", () => {
    // The old implementation injected an IIFE that did fetch+delete. The
    // current implementation is hydration-free: <details> + <form method="post">
    // with the server returning 303s. The report may ship a small <script>
    // for tab/conversation URL-param sync (an explicit UX requirement), but
    // that script must never use fetch/XHR for mutations — deletes stay
    // plain HTML forms. If a fetch-based IIFE ever sneaks back in,
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
      // No fetch/XHR-based mutation scripts (the old hacky pattern).
      expect(html).not.toMatch(/fetch\s*\(/i);
      expect(html).not.toMatch(/XMLHttpRequest/i);
      // Delete actions must be plain HTML forms, not JS-driven.
      expect(html).not.toMatch(/\sonClick=/i);
      expect(html).not.toMatch(/\sonSubmit=/i);
    }
  });

  test("a dynamic_page surface renders as a sandboxed iframe, not raw JSON", () => {
    // GIVEN an assistant stream that shows a dynamic_page surface whose html
    // touches localStorage during init (as generated apps commonly do)
    const pageHtml =
      "<!DOCTYPE html><html><head><title>Calc</title></head><body>" +
      '<script>localStorage.setItem("k", "v")</script>' +
      '<div id="app">Calculator</div></body></html>';

    // WHEN we render the execution page
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        transcript: [
          {
            role: "simulator",
            content: "build me a calculator",
            emittedAt: "2026-05-15T12:00:00.000Z",
          },
        ],
        assistantEvents: [
          {
            message: {
              type: "ui_surface_show",
              surfaceType: "dynamic_page",
              title: "Calculator",
              data: { html: pageHtml, height: 520 },
            },
            emittedAt: "2026-05-15T12:00:01.000Z",
          },
        ],
      },
    });

    // THEN the surface renders in an iframe sandboxed without same-origin, so
    // its scripts run but can't reach the report's origin, cookies, or storage
    expect(html).toMatch(/<iframe\b/i);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    // AND the page html rides in the (HTML-escaped) srcDoc attribute, so no
    // live <script> from the *page content* leaks into the report document
    // itself. The report's own infrastructure <script> for URL-param sync
    // is a separate, intentional tag that does NOT contain "localStorage".
    // The page's script content ("localStorage") should only appear inside
    // the escaped srcdoc attribute or the Surface-data JSON dump, never as
    // a live <script> tag in the report's DOM.
    expect(html).toMatch(/srcdoc=/i);
    // Extract all <script>...</script> blocks and verify none contain the
    // page's localStorage code — the report's own param-sync script is fine
    // but the page's untrusted script must stay inside the sandboxed iframe.
    const scriptBlocks =
      html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    for (const block of scriptBlocks) {
      expect(block).not.toMatch(/localStorage/i);
    }
    // AND a storage polyfill is injected so sandboxed pages that touch
    // localStorage during init still render (sessionStorage appears only here)
    expect(html).toContain("sessionStorage");
    // AND a no-op window.vellum bridge is injected so app-backed pages that
    // call the host APIs during init don't throw in the offline report
    expect(html).toContain("window.vellum");
    expect(html).toContain("sendAction");
    // AND the numeric height hint sizes the frame
    expect(html).toContain("520px");
    // AND the raw payload stays available under a collapsible
    expect(html).toContain("Surface data");
  });

  test("non-dynamic_page surfaces still render their payload as JSON", () => {
    // GIVEN an assistant stream that shows a non-dynamic_page surface
    // WHEN we render the execution page
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        transcript: [
          {
            role: "simulator",
            content: "hi",
            emittedAt: "2026-05-15T12:00:00.000Z",
          },
        ],
        assistantEvents: [
          {
            message: {
              type: "ui_surface_show",
              surfaceType: "card",
              title: "Limit reached",
              data: { body: "Continue?" },
            },
            emittedAt: "2026-05-15T12:00:01.000Z",
          },
        ],
      },
    });

    // THEN the card surface keeps the JSON fallback rather than an iframe
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).toContain("Continue?");
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

  test("session page renders the CLI command block when cliArgv is present", () => {
    // The reproduction line is the whole point of this surface — assert
    // the visible label, the canonical `evals` prefix (env-specific
    // runtime + script path stripped from argv), and the flag tokens
    // we expect to round-trip without quoting changes.
    const html = renderReportPage({
      kind: "session",
      session: {
        ...sessionDetail,
        cliArgv: [
          "/usr/local/bin/bun",
          "/repo/evals/src/cli.ts",
          "run",
          "--benchmark=longmemeval-v2",
          "--profiles=vellum-simple-memory",
          "--filter=057a2d4d",
          "--label=tier-b-smoke",
        ],
      },
    });
    expect(html).toContain("CLI command");
    expect(html).toContain(
      "evals run --benchmark=longmemeval-v2 --profiles=vellum-simple-memory --filter=057a2d4d --label=tier-b-smoke",
    );
    // Argv prefix (bun + script path) is suppressed in the rendered line.
    expect(html).not.toContain("/usr/local/bin/bun");
    expect(html).not.toContain("/repo/evals/src/cli.ts");
  });

  test("session page omits the CLI command block for legacy sessions without cliArgv", () => {
    // Legacy runs predate the field; the UI must render nothing rather
    // than a "command unknown" placeholder so old session pages stay
    // visually clean. The CSS class name ships in every page's
    // stylesheet block — assert on the rendered HTML attribute
    // (`class="cli-command"`) and the visible label text instead.
    const html = renderReportPage({ kind: "session", session: sessionDetail });
    expect(html).not.toContain('class="cli-command"');
    expect(html).not.toContain(">CLI command<");
  });

  test("formatCliCommand strips the bun + script prefix and prepends `evals`", () => {
    expect(
      formatCliCommand([
        "/Users/dev/.bun/bin/bun",
        "/repo/evals/src/cli.ts",
        "run",
        "--profiles=p1",
      ]),
    ).toBe("evals run --profiles=p1");
  });

  test("formatCliCommand returns undefined when argv is missing or too short", () => {
    expect(formatCliCommand(undefined)).toBeUndefined();
    expect(formatCliCommand([])).toBeUndefined();
    // Two entries = runtime + script with no subcommand; not a real
    // CLI invocation we'd want to surface to operators.
    expect(formatCliCommand(["bun", "cli.ts"])).toBeUndefined();
  });

  test("formatCliCommand shell-quotes tokens containing whitespace or shell metacharacters", () => {
    // Flag values from `--label "tier B smoke"` or paths with spaces
    // need single-quoting so the rendered line is paste-runnable.
    // Clean tokens (alphanumerics, `=`, `,`, `.`, `/`, `-`, `_`) stay
    // unquoted so the output reads naturally for the common case.
    const command = formatCliCommand([
      "bun",
      "cli.ts",
      "run",
      "--label=tier B smoke",
      "--workspace=/path with space/data",
    ]);
    expect(command).toBe(
      "evals run '--label=tier B smoke' '--workspace=/path with space/data'",
    );
    // Embedded single quotes use the Bourne `'\''` escape; the result
    // remains a single valid shell token from the parser's POV.
    expect(formatCliCommand(["bun", "cli.ts", "run", "--note=it's fine"])).toBe(
      "evals run '--note=it'\\''s fine'",
    );
  });

  test("execution page renders the CLI command block when cliArgv is present", () => {
    // Same plumbing covers run pages — useful when an operator lands
    // directly on a per-(profile,test) URL via heartbeat or a shared
    // link rather than via the session index.
    const html = renderReportPage({
      kind: "execution",
      run: {
        ...executionDetail,
        cliArgv: [
          "/usr/local/bin/bun",
          "/repo/evals/src/cli.ts",
          "run",
          "--filter=057a2d4d",
        ],
      },
    });
    expect(html).toContain("CLI command");
    expect(html).toContain("evals run --filter=057a2d4d");
  });
});

/**
 * Tests for the OverviewTab: failed-call handling (a rejected call must
 * read as a failure — banner + "Failed" status + $0.00 cost, not the
 * "Unavailable" placeholder) and the first-token latency card's
 * sub-phase rendering.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  LatencyBreakdown,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";

import { OverviewTab } from "./overview-tab";

function makeEntry(
  overrides: Partial<LLMRequestLogEntry> = {},
): LLMRequestLogEntry {
  return {
    id: "call-1",
    createdAt: Date.parse("2026-06-23T09:48:07Z"),
    requestPayload: null,
    responsePayload: null,
    callSite: "mainAgent",
    ...overrides,
  };
}

function render(entry: LLMRequestLogEntry): string {
  return renderToStaticMarkup(<OverviewTab entry={entry} />);
}

describe("OverviewTab — failed calls", () => {
  test("shows a failure banner, Failed status, and $0.00 cost when the summary normalized", () => {
    const html = render(
      makeEntry({
        summary: {
          provider: "fireworks",
          model: "glm-5p2",
          requestMessageCount: 3,
          requestToolCount: 2,
        },
        error: {
          name: "ProviderError",
          message: "This model doesn't support image input.",
          code: "PROVIDER_ERROR",
          provider: "fireworks",
          statusCode: 400,
        },
      }),
    );

    expect(html).toContain("Call failed");
    expect(html).toContain("Failed");
    expect(html).toContain("$0.00");
    // The normalized metadata cards still render the request-side counts.
    expect(html).toContain("Normalized metadata");
  });

  test("shows the failure banner even when the summary never normalized past the provider", () => {
    const html = render(
      makeEntry({
        summary: { provider: "fireworks" },
        error: { message: "boom", provider: "fireworks" },
      }),
    );

    expect(html).toContain("Call failed");
    // The provider-only summary fallback must not hijack a failed call.
    expect(html).not.toContain("Normalized summary unavailable");
  });
});

describe("OverviewTab — first-token latency sub-phases", () => {
  function latencyEntry(latency: LatencyBreakdown): LLMRequestLogEntry {
    return makeEntry({
      summary: {
        provider: "anthropic",
        model: "test-model",
        requestMessageCount: 3,
        requestToolCount: 2,
      },
      latency,
    });
  }

  function memoryPhase(
    ms: number,
    subPhases?: LatencyBreakdown["phases"][number]["subPhases"],
  ) {
    return {
      key: "memory_context",
      label: "Memory & context retrieval",
      ms,
      ...(subPhases ? { subPhases } : {}),
    };
  }

  test("renders indented sub-rows in execution order plus the Other remainder", () => {
    const html = render(
      latencyEntry({
        phases: [
          { key: "queue", label: "Queue & turn setup", ms: 7 },
          memoryPhase(5211, [
            { key: "v3_lanes", label: "Memory search", ms: 1200 },
            { key: "v3_selection", label: "Memory selection", ms: 3800 },
          ]),
        ],
        totalToFirstTokenMs: 8284,
      }),
    );

    expect(html).toContain("First-token latency");
    expect(html).toContain("Memory search");
    expect(html).toContain("Memory selection");
    expect(html).toContain(">1,200 ms<");
    expect(html).toContain(">3,800 ms<");
    // Remainder: 5211 − (1200 + 3800) = 211.
    expect(html).toContain("Other");
    expect(html).toContain(">211 ms<");
    // Sub-rows are inset and follow recorded order.
    expect(html).toContain("pl-4");
    expect(html.indexOf("Memory search")).toBeLessThan(
      html.indexOf("Memory selection"),
    );
    expect(html.indexOf("Memory selection")).toBeLessThan(
      html.indexOf("Other"),
    );
  });

  test("omits the Other row when the remainder is under the threshold", () => {
    const html = render(
      latencyEntry({
        phases: [
          memoryPhase(5211, [
            { key: "v3_lanes", label: "Memory search", ms: 1200 },
            { key: "v3_selection", label: "Memory selection", ms: 4005 },
          ]),
        ],
      }),
    );

    expect(html).toContain("Memory search");
    expect(html).not.toContain("Other");
  });

  test("a breakdown without sub-phases renders flat", () => {
    const html = render(latencyEntry({ phases: [memoryPhase(5211)] }));

    expect(html).toContain(">5,211 ms<");
    expect(html).not.toContain("pl-4");
    expect(html).not.toContain("Other");
  });
});

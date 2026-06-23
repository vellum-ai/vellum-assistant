/**
 * Tests for the CallRail component's row rendering — synthetic, real,
 * and compaction-summarizer calls.
 *
 * Strategy mirrors `inspect-page.test.tsx` and `compaction-tab.test.tsx`:
 * render to static markup (no DOM), mock `react-router`'s `Link` to a
 * plain `<a>` so the rail doesn't require a router context.
 *
 * Synthetic rows are discriminated purely by
 * `callSite === "syntheticAgentErrorMessage"` — the specific exit
 * reason flavor (budget yield, out of funds, …) is read from
 * `agentLoopExitReason`. No separate per-row event field on the wire.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

// Mirror the mock used in `inspect-page.test.tsx` so `Link` renders as
// a plain `<a>` and the rail doesn't trip on missing router context.
mock.module("react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// Imported AFTER the mock so the component picks up the stub.
import { CallRail } from "./call-rail";

function makeRealEntry(
  overrides: Partial<LLMRequestLogEntry> = {},
): LLMRequestLogEntry {
  return {
    id: "call-real-1",
    createdAt: Date.parse("2026-05-26T13:30:00Z"),
    requestPayload: null,
    responsePayload: null,
    callSite: "mainAgent",
    summary: {
      provider: "anthropic",
      model: "claude-sonnet-4",
      estimatedCostUsd: 0.0123,
    },
    ...overrides,
  };
}

function makeSyntheticEntry(
  overrides: Partial<LLMRequestLogEntry> = {},
): LLMRequestLogEntry {
  return {
    id: "call-yield-1",
    createdAt: Date.parse("2026-05-26T13:31:00Z"),
    requestPayload: null,
    responsePayload: null,
    callSite: "syntheticAgentErrorMessage",
    agentLoopExitReason: "budget_yield_unrecovered",
    ...overrides,
  };
}

function render(logs: LLMRequestLogEntry[], selectedLogId?: string): string {
  return renderToStaticMarkup(
    <CallRail
      logs={logs}
      selectedLogId={selectedLogId}
      buildCallHref={(id) => `/conv/test?callId=${id}`}
    />,
  );
}

describe("CallRail — synthetic vs real rows", () => {
  test("renders a real LLM call with provider · model subtitle", () => {
    const html = render([makeRealEntry()]);
    // Real-call subtitle composed from provider + model. The formatter
    // title-cases the known providers, so we assert on "Anthropic".
    expect(html).toContain("Anthropic");
    expect(html).toContain("claude-sonnet-4");
    expect(html).toContain("Cost");
    expect(html).toContain("$0.0123");
    // The warning border token must NOT appear for a real call.
    expect(html).not.toContain("var(--system-negative-strong)");
  });

  test("renders a synthetic budget_yield_unrecovered row distinctly", () => {
    const html = render([makeSyntheticEntry()]);
    // Subtitle is the human-readable yield label derived from the
    // exitReason column. Apostrophes are HTML-entity-escaped in static
    // markup (`couldn&#x27;t`), so we search for an apostrophe-free
    // substring on either side.
    expect(html).toContain("Yield");
    expect(html).toContain("compaction couldn");
    expect(html).toContain("fit next step");
    // Warning palette must be present (icon color + border + subtitle).
    expect(html).toContain("var(--system-negative-strong)");
    // No provider/model leakage when the row is synthetic.
    expect(html).not.toContain("Anthropic");
  });

  test("renders a generic synthetic error subtitle when exit reason is unknown", () => {
    // Future error reasons (e.g. `out_of_funds`) should still render
    // with the warning palette and a recognizable subtitle, even if the
    // helper doesn't have a bespoke phrase for them yet.
    const html = render([
      makeSyntheticEntry({ agentLoopExitReason: "out_of_funds" }),
    ]);
    expect(html).toContain("Agent loop error");
    expect(html).toContain("out_of_funds");
    expect(html).toContain("var(--system-negative-strong)");
  });

  test("keeps numeric Call N labels for synthetic rows so they occupy a call slot", () => {
    // Two real calls + one synthetic yield. Display order is newest-first.
    const html = render([
      makeRealEntry({ id: "call-1", createdAt: 1 }),
      makeRealEntry({ id: "call-2", createdAt: 2 }),
      makeSyntheticEntry({ id: "call-3", createdAt: 3 }),
    ]);
    expect(html).toContain("Call 1");
    expect(html).toContain("Call 2");
    expect(html).toContain("Call 3");
    // The synthetic row is the latest, so it carries the "Latest" badge.
    expect(html).toContain("Latest");
  });

  test("falls back to a non-warning subtitle when an LLM-call row is missing provider+model", () => {
    // A real call with no provider/model still renders, but should NOT
    // pick up the synthetic warning styling.
    const html = render([
      makeRealEntry({ summary: null, callSite: "mainAgent" }),
    ]);
    expect(html).toContain("Unrecognized call");
    expect(html).toContain("Cost");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("var(--system-negative-strong)");
  });
});

describe("CallRail — failed rows", () => {
  test("flags a provider-rejected call with the warning palette, a Failed pill, and $0.00 cost", () => {
    // GIVEN a real call the provider rejected (structured `error` present)
    // WHEN the rail renders the row
    const html = render([
      makeRealEntry({
        summary: { provider: "fireworks", model: "glm-5p2" },
        error: {
          name: "ProviderError",
          message: "This model doesn't support image input.",
          code: "PROVIDER_ERROR",
          provider: "fireworks",
          statusCode: 400,
        },
      }),
    ]);
    // THEN it carries the failure styling and a Failed pill
    expect(html).toContain("var(--system-negative-strong)");
    expect(html).toContain("Failed");
    // AND the cost reads $0.00 rather than "Unavailable"
    expect(html).toContain("$0.00");
    expect(html).not.toContain("Unavailable");
  });
});

describe("CallRail — compaction rows", () => {
  test("tags a compactionAgent call with a Compaction pill", () => {
    /**
     * The compaction summarizer is captured as an ordinary call row, so
     * the rail tags it to set it apart from a main-agent call while
     * still rendering its provider · model subtitle.
     */
    // GIVEN a compaction summarizer call (callSite "compactionAgent")
    // WHEN the rail renders the row
    const html = render([
      makeRealEntry({
        callSite: "compactionAgent",
        summary: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          estimatedCostUsd: 0.0001,
        },
      }),
    ]);
    // THEN it shows the Compaction pill alongside the provider · model subtitle
    expect(html).toContain("Compaction");
    expect(html).toContain("Anthropic");
    expect(html).toContain("claude-haiku-4-5");
    // A compaction call is a normal (non-error) call — no warning palette.
    expect(html).not.toContain("var(--system-negative-strong)");
  });

  test("does not tag a main-agent call with a Compaction pill", () => {
    /**
     * Main-agent calls are the common case and must never pick up the
     * compaction tag.
     */
    // GIVEN a main-agent call
    // WHEN the rail renders the row
    const html = render([makeRealEntry({ callSite: "mainAgent" })]);
    // THEN no Compaction pill appears
    expect(html).not.toContain("Compaction");
  });
});

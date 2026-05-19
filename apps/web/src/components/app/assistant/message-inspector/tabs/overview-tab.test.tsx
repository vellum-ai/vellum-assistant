/**
 * Smoke tests for `OverviewTab`.
 *
 * Same pattern as the rest of the suite — `renderToStaticMarkup` and
 * substring assertions. Focus is on the May 9, 2026 addition of a
 * "Conversation" totals card driven by
 * `conversationTotalEstimatedCostUsd`.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { LLMRequestLogEntry } from "@/domains/chat/lib/inspector-types.js";

import { OverviewTab } from "@/components/app/assistant/message-inspector/tabs/overview-tab.js";

function makeEntry(overrides: Partial<LLMRequestLogEntry> = {}): LLMRequestLogEntry {
  return {
    id: "log-1",
    createdAt: 1_700_000_000_000,
    requestPayload: null,
    responsePayload: null,
    summary: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 1000,
      outputTokens: 250,
      estimatedCostUsd: 0.012,
    },
    ...overrides,
  };
}

describe("OverviewTab — conversation totals", () => {
  test("renders the Conversation card with formatted cost when provided", () => {
    const html = renderToStaticMarkup(
      <OverviewTab
        entry={makeEntry()}
        conversationTotalEstimatedCostUsd={1.2345}
      />,
    );

    expect(html).toContain("Conversation");
    expect(html).toContain("Total cost so far");
    expect(html).toContain("$1.23"); // Intl.NumberFormat USD
  });

  test("hides the Conversation card when the field is undefined", () => {
    const html = renderToStaticMarkup(<OverviewTab entry={makeEntry()} />);

    expect(html).not.toContain("Total cost so far");
  });

  test("hides the Conversation card when the field is null", () => {
    const html = renderToStaticMarkup(
      <OverviewTab
        entry={makeEntry()}
        conversationTotalEstimatedCostUsd={null}
      />,
    );

    expect(html).not.toContain("Total cost so far");
  });

  test("still hides on the fallback path when the field is null", () => {
    const html = renderToStaticMarkup(
      <OverviewTab
        entry={makeEntry({ summary: { provider: "anthropic" } })}
        conversationTotalEstimatedCostUsd={null}
      />,
    );

    expect(html).toContain("Normalized summary unavailable");
    expect(html).not.toContain("Total cost so far");
  });

  test("renders on the fallback path when conversation cost is present", () => {
    const html = renderToStaticMarkup(
      <OverviewTab
        entry={makeEntry({ summary: { provider: "anthropic" } })}
        conversationTotalEstimatedCostUsd={0.5}
      />,
    );

    expect(html).toContain("Normalized summary unavailable");
    expect(html).toContain("Total cost so far");
    expect(html).toContain("$0.50");
  });

  test("conversation card renders before per-call cards when both are present", () => {
    const html = renderToStaticMarkup(
      <OverviewTab
        entry={makeEntry()}
        conversationTotalEstimatedCostUsd={2}
      />,
    );

    const conversationPos = html.indexOf("Total cost so far");
    const usagePos = html.indexOf("Token and call counts");
    expect(conversationPos).toBeGreaterThan(-1);
    expect(usagePos).toBeGreaterThan(-1);
    expect(conversationPos).toBeLessThan(usagePos);
  });
});

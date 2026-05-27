/**
 * Tests for the OverviewTab's synthetic agent-loop event branch.
 *
 * The normalized-summary path is exercised implicitly by other tabs
 * and the inspector page test; the goal here is to lock in that a
 * row with `syntheticEvent` populated renders a yield notice card
 * instead of the normalized metadata + usage cards (which are
 * meaningless for a non-LLM event).
 *
 * Uses the same renderToStaticMarkup pattern as the call-rail tests.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { LLMRequestLogEntry } from "../../../types/inspector-types";
import { OverviewTab } from "./overview-tab";

function makeRealEntry(): LLMRequestLogEntry {
  return {
    id: "call-real-1",
    createdAt: Date.parse("2026-05-26T13:30:00Z"),
    requestPayload: null,
    responsePayload: null,
    callSite: "mainAgent",
    syntheticEvent: null,
    summary: {
      provider: "anthropic",
      model: "claude-sonnet-4",
      stopReason: "end_turn",
      inputTokens: 100,
      outputTokens: 50,
    },
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
    callSite: "agentLoopYield",
    agentLoopExitReason: "budget_yield_unrecovered",
    syntheticEvent: {
      kind: "agentLoopYield",
      exitReason: "budget_yield_unrecovered",
      userMessageText:
        "I tried to compact this conversation but couldn't fit the next step into the model's context window.",
    },
    ...overrides,
  };
}

function render(
  entry: LLMRequestLogEntry,
  conversationTotalEstimatedCostUsd: number | null = null,
): string {
  return renderToStaticMarkup(
    <OverviewTab
      entry={entry}
      conversationTotalEstimatedCostUsd={conversationTotalEstimatedCostUsd}
    />,
  );
}

describe("OverviewTab — synthetic event branch", () => {
  test("renders the synthetic event card with exit reason + notice text", () => {
    const html = render(makeSyntheticEntry());
    // Card heading + helper text identify this as a non-LLM entry.
    expect(html).toContain("Agent loop yielded");
    expect(html).toContain("No LLM call was made for this entry");
    // Exit reason row.
    expect(html).toContain("Exit reason");
    expect(html).toContain("budget_yield_unrecovered");
    // The full user-visible notice from the chat is surfaced verbatim.
    // Note: apostrophes are HTML-entity-escaped in static markup
    // (`couldn&#x27;t`), so we assert on apostrophe-free fragments.
    expect(html).toContain("fit the next step into the model");
    expect(html).toContain("context window");
    // Warning icon styling is present.
    expect(html).toContain("var(--system-negative-strong)");
  });

  test("suppresses normalized metadata + usage cards for synthetic rows", () => {
    const html = render(makeSyntheticEntry());
    // Neither the "Normalized metadata" nor "Usage" card title should
    // appear — both rely on a real LLM call summary.
    expect(html).not.toContain("Normalized metadata");
    expect(html).not.toContain("Token and call counts");
  });

  test("still renders the conversation totals card when a cost is available", () => {
    const html = render(makeSyntheticEntry(), 0.42);
    expect(html).toContain("Total cost so far");
    // Synthetic card is still rendered alongside the totals.
    expect(html).toContain("Agent loop yielded");
  });

  test("real LLM calls render normalized metadata + usage (regression guard)", () => {
    const html = render(makeRealEntry());
    expect(html).toContain("Normalized metadata");
    // displayProvider title-cases known providers — "Anthropic", not "anthropic".
    expect(html).toContain("Anthropic");
    expect(html).toContain("Token and call counts");
    // Should NOT render the synthetic card.
    expect(html).not.toContain("Agent loop yielded");
    expect(html).not.toContain("No LLM call was made");
  });

  test("falls back gracefully when synthetic payload has empty notice text", () => {
    const html = render(
      makeSyntheticEntry({
        syntheticEvent: {
          kind: "agentLoopYield",
          exitReason: "budget_yield_unrecovered",
          userMessageText: "",
        },
      }),
    );
    // Card still renders with exit reason; just no <p> for empty text.
    expect(html).toContain("Agent loop yielded");
    expect(html).toContain("budget_yield_unrecovered");
  });
});

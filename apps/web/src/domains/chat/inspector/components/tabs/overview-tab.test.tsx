/**
 * Tests for the OverviewTab.
 *
 * Synthetic agent-error-message rows have no `summary` so they take
 * the existing fallback path — no dedicated card is rendered for them
 * because the exit reason is already tracked on the `llm_request_log`
 * row itself and surfaced upstream (call rail subtitle, raw response
 * payload). This file pins that behavior so we don't accidentally
 * regrow a bespoke synthetic Overview surface.
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
    callSite: "syntheticAgentErrorMessage",
    agentLoopExitReason: "budget_yield_unrecovered",
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

describe("OverviewTab — synthetic rows take the fallback path", () => {
  test("synthetic row renders the standard 'summary unavailable' fallback (no bespoke card)", () => {
    const html = render(makeSyntheticEntry());
    // Standard fallback header, not a synthetic-specific card.
    expect(html).toContain("Normalized summary unavailable");
    // The "raw request and response are still available" hint points
    // the user to the Raw tab for the notice text + prepared request.
    expect(html).toContain("raw request and response");
    // No bespoke synthetic surface should sneak back in.
    expect(html).not.toContain("Agent loop yielded");
    expect(html).not.toContain("No LLM call was made");
  });

  test("real LLM calls render normalized metadata + usage (regression guard)", () => {
    const html = render(makeRealEntry());
    expect(html).toContain("Normalized metadata");
    // displayProvider title-cases known providers — "Anthropic", not "anthropic".
    expect(html).toContain("Anthropic");
    expect(html).toContain("Token and call counts");
    // Should NOT fall through to the fallback path.
    expect(html).not.toContain("Normalized summary unavailable");
  });

  test("real LLM calls with a stamped exit reason surface it in the normalized metadata card", () => {
    // This is the path that makes the dedicated synthetic Overview card
    // unnecessary: the `agentLoopExitReason` column is already shown
    // on real LLM call rows that carry it. Synthetic rows have the
    // same column populated and the Raw tab covers the rest.
    const html = render({
      ...makeRealEntry(),
      agentLoopExitReason: "budget_yield_unrecovered",
    });
    expect(html).toContain("Loop exit reason");
    expect(html).toContain("budget_yield_unrecovered");
  });

  test("still renders the conversation totals card alongside a synthetic fallback", () => {
    const html = render(makeSyntheticEntry(), 0.42);
    expect(html).toContain("Total cost so far");
    // Synthetic fallback is rendered alongside the totals.
    expect(html).toContain("Normalized summary unavailable");
  });
});

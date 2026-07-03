/**
 * Tests for the OverviewTab's handling of failed calls. A rejected call
 * must read as a failure (banner + "Failed" status) and show a $0.00
 * estimated cost rather than the "Unavailable" placeholder.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

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

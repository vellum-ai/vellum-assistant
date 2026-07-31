/**
 * Tests for the ResponseTab: section rendering (each section header carries
 * a visible copy affordance) and failed calls. A call the provider rejected
 * carries a structured `error` and no response sections; the tab must
 * surface a failure banner instead of the generic "Section rendering
 * unavailable" fallback.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

import { ResponseTab } from "./response-tab";

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
  return renderToStaticMarkup(<ResponseTab entry={entry} />);
}

describe("ResponseTab — sections", () => {
  test("renders a visible copy icon in the section header", () => {
    const html = render(
      makeEntry({
        responseSections: [
          { kind: "text", label: "Assistant reply", text: "Hello there" },
        ],
      }),
    );
    expect(html).toContain("Assistant reply");
    expect(html).toContain('aria-label="Copy section content"');
    // The copy affordance must render an actual icon, not an empty button.
    expect(html).toContain("<svg");
  });
});

describe("ResponseTab — failed calls", () => {
  test("renders the failure banner with the provider message and metadata", () => {
    const html = render(
      makeEntry({
        summary: { provider: "fireworks", model: "glm-5p2" },
        error: {
          name: "ProviderError",
          message:
            "This model doesn't support image input. Remove the image or switch to a vision-capable model.",
          code: "PROVIDER_ERROR",
          provider: "fireworks",
          statusCode: 400,
          apiErrorCode: "model_not_supported",
          apiErrorType: "invalid_request_error",
          apiErrorParam: "model",
          requestId: "req_abc123",
        },
      }),
    );

    expect(html).toContain("Call failed");
    expect(html).toContain("support image input");
    // Structured chips surface the provider, status, type and code.
    expect(html).toContain("Fireworks");
    expect(html).toContain("400");
    expect(html).toContain("ProviderError");
    expect(html).toContain("PROVIDER_ERROR");
    // Upstream provider error metadata chips.
    expect(html).toContain("model_not_supported");
    expect(html).toContain("invalid_request_error");
    expect(html).toContain("req_abc123");
    // The generic fallback must not appear when the call failed.
    expect(html).not.toContain("Section rendering unavailable");
  });

  test("falls back to a default message when the error has no message", () => {
    const html = render(makeEntry({ error: { name: "ProviderError" } }));
    expect(html).toContain("Call failed");
    expect(html).toContain("rejected this call");
    expect(html).not.toContain("Section rendering unavailable");
  });

  test("still shows the generic fallback for a non-error empty response", () => {
    const html = render(makeEntry());
    expect(html).toContain("Section rendering unavailable");
    expect(html).not.toContain("Call failed");
  });
});

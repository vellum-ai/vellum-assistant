import { describe, expect, test } from "bun:test";

import { parseActualTokensFromError } from "./conversation-agent-loop.js";

describe("parseActualTokensFromError", () => {
  test("returns null for null input", () => {
    expect(parseActualTokensFromError(null)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseActualTokensFromError("")).toBeNull();
  });

  test("returns null for unrelated error message", () => {
    expect(parseActualTokensFromError("something went wrong")).toBeNull();
  });

  test("parses Anthropic-style error: prompt is too long: N tokens > M maximum", () => {
    expect(
      parseActualTokensFromError(
        "prompt is too long: 242201 tokens > 200000 maximum",
      ),
    ).toBe(242201);
  });

  test("parses wrapped ProviderError from Anthropic", () => {
    expect(
      parseActualTokensFromError(
        "Anthropic API error (400): prompt is too long: 242201 tokens > 200000 maximum",
      ),
    ).toBe(242201);
  });

  test("parses OpenAI-style error: too many input tokens: N > M", () => {
    expect(
      parseActualTokensFromError("too many input tokens: 150000 > 128000"),
    ).toBe(150000);
  });

  test("handles comma-separated numbers", () => {
    expect(
      parseActualTokensFromError(
        "prompt is too long: 242,201 tokens > 200,000 maximum",
      ),
    ).toBe(242201);
  });

  test("handles comma-separated numbers in fallback path", () => {
    expect(
      parseActualTokensFromError("too many input tokens: 150,000 > 128,000"),
    ).toBe(150000);
  });

  test("parses singular 'token' (without s)", () => {
    expect(
      parseActualTokensFromError("prompt is too long: 1 token > 0 maximum"),
    ).toBe(1);
  });

  test("handles >= comparator", () => {
    expect(
      parseActualTokensFromError(
        "prompt is too long: 242201 tokens ≥ 200000 maximum",
      ),
    ).toBe(242201);
  });

  test("returns null when no numeric pattern matches", () => {
    expect(parseActualTokensFromError("context window exceeded")).toBeNull();
  });
});

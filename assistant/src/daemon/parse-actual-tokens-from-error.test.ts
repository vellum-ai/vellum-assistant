import { describe, expect, test } from "bun:test";

import { ContextOverflowError } from "../providers/types.js";
import { parseActualTokensFromError } from "./parse-actual-tokens-from-error.js";

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

  // ── Typed-error branch ─────────────────────────────────────────────

  test("prefers ContextOverflowError.actualTokens over string-regex match", () => {
    // Message would regex-parse to 999999, but typed field wins.
    const err = new ContextOverflowError(
      "Anthropic API error (400): prompt is too long: 999999 tokens > 200000 maximum",
      "anthropic",
      {
        actualTokens: 242201,
        maxTokens: 200000,
      },
    );
    expect(parseActualTokensFromError(err)).toBe(242201);
  });

  test("falls back to regex when ContextOverflowError has no actualTokens", () => {
    const err = new ContextOverflowError(
      "OpenAI API error (400): too many input tokens: 150000 > 128000",
      "openai",
      {},
    );
    expect(parseActualTokensFromError(err)).toBe(150000);
  });

  test("returns null when ContextOverflowError has neither typed field nor matching message", () => {
    const err = new ContextOverflowError("context window exceeded", "openai");
    expect(parseActualTokensFromError(err)).toBeNull();
  });

  test("typed-error parsing takes precedence over string regex even when both present", () => {
    // String has 999999 tokens > 200000; typed field says 242201.
    // The typed field MUST win — this is the core contract.
    const err = new ContextOverflowError(
      "prompt is too long: 999999 tokens > 200000 maximum",
      "anthropic",
      { actualTokens: 242201 },
    );
    expect(parseActualTokensFromError(err)).toBe(242201);
  });

  test("accepts an untyped Error instance and parses its message", () => {
    const err = new Error("prompt is too long: 242201 tokens > 200000 maximum");
    expect(parseActualTokensFromError(err)).toBe(242201);
  });

  test("ignores non-numeric/invalid actualTokens on typed error", () => {
    // actualTokens of 0 should fall through (typed check requires > 0).
    const err = new ContextOverflowError(
      "prompt is too long: 242201 tokens > 200000 maximum",
      "anthropic",
      { actualTokens: 0 },
    );
    expect(parseActualTokensFromError(err)).toBe(242201);
  });
});

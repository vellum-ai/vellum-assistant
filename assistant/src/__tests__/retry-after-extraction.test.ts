import { describe, expect, test } from "bun:test";

import { ProviderError } from "../util/errors.js";
import { extractRetryAfterMs, parseRetryAfterMs } from "../util/retry.js";

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

describe("parseRetryAfterMs", () => {
  test("parses integer seconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
  });

  test("parses fractional seconds", () => {
    expect(parseRetryAfterMs("1.5")).toBe(1_500);
  });

  test("returns undefined for non-numeric non-date string", () => {
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
  });

  test("parses HTTP-date format", () => {
    const futureDate = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfterMs(futureDate);
    expect(result).toBeDefined();
    // Should be roughly 60 seconds (allow some tolerance for test execution time)
    expect(result!).toBeGreaterThan(55_000);
    expect(result!).toBeLessThan(65_000);
  });

  test("returns 0 for past HTTP-date", () => {
    const pastDate = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfterMs(pastDate)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractRetryAfterMs
// ---------------------------------------------------------------------------

describe("extractRetryAfterMs", () => {
  test("returns undefined for null/undefined headers", () => {
    expect(extractRetryAfterMs(null)).toBeUndefined();
    expect(extractRetryAfterMs(undefined)).toBeUndefined();
  });

  test("extracts from plain object headers (Anthropic SDK style)", () => {
    const headers = { "retry-after": "45" };
    expect(extractRetryAfterMs(headers)).toBe(45_000);
  });

  test("extracts from Headers instance (OpenAI SDK style)", () => {
    const headers = new Headers({ "retry-after": "10" });
    expect(extractRetryAfterMs(headers)).toBe(10_000);
  });

  test("extracts from Map-like object with .get()", () => {
    const headers = {
      get(key: string) {
        return key === "retry-after" ? "25" : null;
      },
    };
    expect(extractRetryAfterMs(headers)).toBe(25_000);
  });

  test("returns undefined when retry-after header is missing", () => {
    expect(extractRetryAfterMs({})).toBeUndefined();
    expect(extractRetryAfterMs(new Headers())).toBeUndefined();
  });

  test("returns undefined for non-object headers", () => {
    expect(extractRetryAfterMs(42)).toBeUndefined();
    expect(extractRetryAfterMs("string")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ProviderError.retryAfterMs
// ---------------------------------------------------------------------------

describe("ProviderError.retryAfterMs", () => {
  test("stores retryAfterMs when provided in options", () => {
    const err = new ProviderError("rate limited", "anthropic", 429, {
      retryAfterMs: 30_000,
    });
    expect(err.retryAfterMs).toBe(30_000);
    expect(err.statusCode).toBe(429);
    expect(err.provider).toBe("anthropic");
  });

  test("retryAfterMs is undefined when not provided", () => {
    const err = new ProviderError("rate limited", "anthropic", 429);
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("retryAfterMs is undefined with empty options", () => {
    const err = new ProviderError("error", "test", 500, {});
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("preserves cause alongside retryAfterMs", () => {
    const cause = new Error("original");
    const err = new ProviderError("wrapped", "test", 429, {
      cause,
      retryAfterMs: 5_000,
    });
    expect(err.retryAfterMs).toBe(5_000);
    expect(err.cause).toBe(cause);
  });
});

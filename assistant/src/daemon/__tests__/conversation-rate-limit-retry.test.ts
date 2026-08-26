import { describe, expect, test } from "bun:test";

import { ProviderError } from "../../util/errors.js";
import type { ClassifiedConversationError } from "../conversation-error.js";
import {
  DEFAULT_MAX_RETRIES,
  MAX_RATE_LIMIT_RETRY_DELAY_MS,
  resolveRateLimitRetryDelay,
  shouldRetryProviderRateLimit,
  sleepForRateLimitRetry,
} from "../conversation-rate-limit-retry.js";

function rateLimitClassification(
  overrides: Partial<ClassifiedConversationError> = {},
): ClassifiedConversationError {
  return {
    code: "PROVIDER_RATE_LIMIT",
    userMessage:
      "You are being rate limited by the AI provider. Please try again in a moment.",
    retryable: true,
    errorCategory: "rate_limit",
    ...overrides,
  };
}

describe("shouldRetryProviderRateLimit", () => {
  test("retries a retryable PROVIDER_RATE_LIMIT while budget remains", () => {
    expect(
      shouldRetryProviderRateLimit(rateLimitClassification(), { attempt: 0 }),
    ).toBe(true);
    expect(
      shouldRetryProviderRateLimit(rateLimitClassification(), { attempt: 2 }),
    ).toBe(true);
  });

  test("stops after DEFAULT_MAX_RETRIES attempts", () => {
    expect(
      shouldRetryProviderRateLimit(rateLimitClassification(), {
        attempt: DEFAULT_MAX_RETRIES,
      }),
    ).toBe(false);
    expect(
      shouldRetryProviderRateLimit(rateLimitClassification(), {
        attempt: DEFAULT_MAX_RETRIES + 1,
      }),
    ).toBe(false);
  });

  test("does not retry when the abort signal is already active", () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      shouldRetryProviderRateLimit(rateLimitClassification(), {
        attempt: 0,
        signal: controller.signal,
      }),
    ).toBe(false);
  });

  test("does not retry a non-retryable rate-limit classification", () => {
    expect(
      shouldRetryProviderRateLimit(
        rateLimitClassification({ retryable: false }),
        { attempt: 0 },
      ),
    ).toBe(false);
  });

  test("does not retry managed usage limits or other retryable codes", () => {
    expect(
      shouldRetryProviderRateLimit(
        rateLimitClassification({
          code: "MANAGED_USAGE_LIMIT",
          errorCategory: "managed_usage_limit",
        }),
        { attempt: 0 },
      ),
    ).toBe(false);
    expect(
      shouldRetryProviderRateLimit(
        rateLimitClassification({
          code: "PROVIDER_OVERLOADED",
          errorCategory: "provider_overloaded",
        }),
        { attempt: 0 },
      ),
    ).toBe(false);
  });
});

describe("resolveRateLimitRetryDelay", () => {
  test("honors ProviderError.retryAfterMs", () => {
    const error = new ProviderError("rate limited", "anthropic", 429, {
      reason: "rate_limited",
      retryAfterMs: 12_000,
    });
    expect(resolveRateLimitRetryDelay(error, 0)).toBe(12_000);
  });

  test("extracts Retry-After from error.headers", () => {
    const error = Object.assign(new Error("rate limited"), {
      headers: { "retry-after": "8" },
    });
    expect(resolveRateLimitRetryDelay(error, 0)).toBe(8_000);
  });

  test("extracts Retry-After from the error cause headers", () => {
    const cause = Object.assign(new Error("upstream 429"), {
      headers: new Headers({ "retry-after": "5" }),
    });
    const error = new ProviderError("rate limited", "openai", 429, {
      reason: "rate_limited",
      cause,
    });
    expect(resolveRateLimitRetryDelay(error, 0)).toBe(5_000);
  });

  test("prefers stamped retryAfterMs over headers", () => {
    const cause = Object.assign(new Error("upstream 429"), {
      headers: { "retry-after": "5" },
    });
    const error = new ProviderError("rate limited", "openai", 429, {
      reason: "rate_limited",
      retryAfterMs: 1_500,
      cause,
    });
    expect(resolveRateLimitRetryDelay(error, 0)).toBe(1_500);
  });

  test("falls back to exponential backoff when no Retry-After is present", () => {
    const error = new ProviderError("rate limited", "anthropic", 429, {
      reason: "rate_limited",
    });
    const delay = resolveRateLimitRetryDelay(error, 0);
    // computeRetryDelay(0, 1000) = 500 + random * 500, in [500, 1000)
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThan(1_000);
  });

  test("caps pathological Retry-After values", () => {
    const error = new ProviderError("rate limited", "anthropic", 429, {
      reason: "rate_limited",
      retryAfterMs: 3_600_000,
    });
    expect(resolveRateLimitRetryDelay(error, 0)).toBe(
      MAX_RATE_LIMIT_RETRY_DELAY_MS,
    );
  });
});

describe("sleepForRateLimitRetry", () => {
  test("resolves immediately when Retry-After is 0", async () => {
    const error = new ProviderError("rate limited", "anthropic", 429, {
      reason: "rate_limited",
      retryAfterMs: 0,
    });
    const started = Date.now();
    await sleepForRateLimitRetry(error, 0);
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("resolves early when the abort signal fires", async () => {
    const controller = new AbortController();
    const error = new ProviderError("rate limited", "anthropic", 429, {
      reason: "rate_limited",
      retryAfterMs: 5_000,
    });
    const sleep = sleepForRateLimitRetry(error, 0, controller.signal);
    controller.abort();
    const started = Date.now();
    await sleep;
    expect(Date.now() - started).toBeLessThan(50);
  });
});

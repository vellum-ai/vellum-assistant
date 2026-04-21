import { describe, expect, test } from "bun:test";

import { shouldCaptureAgentLoopError } from "../agent/loop.js";
import { ProviderError } from "../util/errors.js";

/**
 * Regression coverage for JARVIS-446 and JARVIS-513.
 *
 * The agent loop reports uncaught turn-processing errors to Sentry, but two
 * categories of errors are user-environment noise and should not page:
 *
 *  - JARVIS-446: billing/auth/forbidden from the provider (402/401/403). The
 *    user-facing error path already surfaces a credits-exhausted message; a
 *    Sentry issue adds no engineering signal.
 *  - JARVIS-513: retry-exhausted transient network errors (ECONNRESET, Bun's
 *    "socket closed unexpectedly", etc.). The retry loop already did its job.
 *
 * `shouldCaptureAgentLoopError` gates the `Sentry.captureException` call.
 */
describe("shouldCaptureAgentLoopError", () => {
  describe("JARVIS-446 — billing/auth/forbidden ProviderError", () => {
    test("skips capture for 402 (billing exhausted)", () => {
      const err = new ProviderError(
        "Anthropic API error (402): credit balance too low",
        "anthropic",
        402,
      );
      expect(shouldCaptureAgentLoopError(err)).toBe(false);
    });

    test("skips capture for 401 (bad API key)", () => {
      const err = new ProviderError(
        "Anthropic API error (401): invalid x-api-key",
        "anthropic",
        401,
      );
      expect(shouldCaptureAgentLoopError(err)).toBe(false);
    });

    test("skips capture for 403 (forbidden / plan-gated)", () => {
      const err = new ProviderError(
        "Anthropic API error (403): permission denied",
        "anthropic",
        403,
      );
      expect(shouldCaptureAgentLoopError(err)).toBe(false);
    });

    test("still captures 500 (real server error)", () => {
      const err = new ProviderError(
        "Anthropic API error (500): internal server error",
        "anthropic",
        500,
      );
      expect(shouldCaptureAgentLoopError(err)).toBe(true);
    });

    test("still captures 400 (bad request — engineering bug)", () => {
      const err = new ProviderError(
        "Anthropic API error (400): invalid tool definition",
        "anthropic",
        400,
      );
      expect(shouldCaptureAgentLoopError(err)).toBe(true);
    });

    test("still captures ProviderError with no status (surprise error)", () => {
      const err = new ProviderError(
        "Anthropic API error: unexpected internal state",
        "anthropic",
      );
      expect(shouldCaptureAgentLoopError(err)).toBe(true);
    });
  });

  describe("JARVIS-513 — retry-exhausted transient network errors", () => {
    test("skips capture when retriesExhausted is set on an ECONNRESET", () => {
      const err = Object.assign(new Error("connection reset"), {
        code: "ECONNRESET",
        retriesExhausted: true,
      });
      expect(shouldCaptureAgentLoopError(err)).toBe(false);
    });

    test("skips capture for Bun 'socket closed unexpectedly' with retriesExhausted", () => {
      const err = new Error("The socket connection was closed unexpectedly");
      (err as Error & { retriesExhausted?: boolean }).retriesExhausted = true;
      expect(shouldCaptureAgentLoopError(err)).toBe(false);
    });

    test("skips capture for wrapped ProviderError whose cause is a transient socket error", () => {
      const cause = new Error("The socket connection was closed unexpectedly");
      const err = new ProviderError(
        "Anthropic request failed: The socket connection was closed unexpectedly",
        "anthropic",
        undefined,
        { cause },
      );
      (err as Error & { retriesExhausted?: boolean }).retriesExhausted = true;
      expect(shouldCaptureAgentLoopError(err)).toBe(false);
    });

    test("still captures ECONNRESET when retries were NOT exhausted", () => {
      // If the first attempt threw with ECONNRESET and the retry loop somehow
      // didn't run (e.g. a caller bypassed RetryProvider), we still want
      // visibility — `retriesExhausted` wasn't set.
      const err = Object.assign(new Error("connection reset"), {
        code: "ECONNRESET",
      });
      expect(shouldCaptureAgentLoopError(err)).toBe(true);
    });

    test("still captures retriesExhausted marker on a non-network error", () => {
      // The suppression is narrow: only retryable-network errors with the
      // marker. A 500 with retriesExhausted still merits Sentry attention.
      const err = new ProviderError(
        "Anthropic API error (500): internal server error",
        "anthropic",
        500,
      );
      (err as Error & { retriesExhausted?: boolean }).retriesExhausted = true;
      expect(shouldCaptureAgentLoopError(err)).toBe(true);
    });
  });

  describe("default behavior — everything else still pages", () => {
    test("captures a plain surprise Error", () => {
      expect(shouldCaptureAgentLoopError(new Error("boom"))).toBe(true);
    });

    test("captures a TypeError", () => {
      expect(shouldCaptureAgentLoopError(new TypeError("x is not a fn"))).toBe(
        true,
      );
    });
  });
});

import { describe, expect, it } from "bun:test";

import type { ErrorContext } from "../daemon/session-error.js";
import {
  buildSessionErrorMessage,
  classifySessionError,
  isUserCancellation,
} from "../daemon/session-error.js";
import { ProviderError } from "../util/errors.js";

describe("isUserCancellation", () => {
  it("returns false for non-AbortError even when abort flag is set", () => {
    const ctx: ErrorContext = { phase: "agent_loop", aborted: true };
    expect(isUserCancellation(new Error("something"), ctx)).toBe(false);
  });

  it("returns false for non-AbortError network failure during abort", () => {
    const ctx: ErrorContext = { phase: "agent_loop", aborted: true };
    expect(isUserCancellation(new Error("ECONNREFUSED"), ctx)).toBe(false);
  });

  it("returns true for AbortError (DOMException-style) when aborted", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    const ctx: ErrorContext = { phase: "agent_loop", aborted: true };
    expect(isUserCancellation(err, ctx)).toBe(true);
  });

  it("returns true for AbortError (Error with name set) when aborted", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const ctx: ErrorContext = { phase: "agent_loop", aborted: true };
    expect(isUserCancellation(err, ctx)).toBe(true);
  });

  it("returns false for AbortError (DOMException-style) when NOT aborted", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    const ctx: ErrorContext = { phase: "agent_loop", aborted: false };
    expect(isUserCancellation(err, ctx)).toBe(false);
  });

  it("returns false for AbortError (Error with name set) when NOT aborted", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const ctx: ErrorContext = { phase: "agent_loop", aborted: false };
    expect(isUserCancellation(err, ctx)).toBe(false);
  });

  it("returns false for non-abort errors without abort flag", () => {
    const ctx: ErrorContext = { phase: "agent_loop", aborted: false };
    expect(isUserCancellation(new Error("network timeout"), ctx)).toBe(false);
  });

  it("returns false for non-Error values without abort flag", () => {
    const ctx: ErrorContext = { phase: "agent_loop", aborted: false };
    expect(isUserCancellation("some string error", ctx)).toBe(false);
  });
});

describe("classifySessionError", () => {
  const baseCtx: ErrorContext = { phase: "agent_loop" };

  describe("network errors", () => {
    const cases = [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "socket hang up",
      "fetch failed",
      "Connection refused by server",
      "connection reset",
      "connection timeout",
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_NETWORK`, () => {
        const result = classifySessionError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_NETWORK");
        expect(result.retryable).toBe(true);
      });
    }
  });

  describe("rate limit errors", () => {
    const cases = [
      "Error 429: Too many requests",
      "rate limit exceeded",
      "Rate-limit hit",
      "too many requests",
      "overloaded",
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_RATE_LIMIT`, () => {
        const result = classifySessionError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_RATE_LIMIT");
        expect(result.retryable).toBe(true);
      });
    }
  });

  describe("provider API errors", () => {
    const cases = [
      "HTTP 500 Internal Server Error",
      "server error",
      "Bad gateway",
      "Service unavailable",
      "Gateway timeout",
      "502 Bad Gateway",
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_API`, () => {
        const result = classifySessionError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_API");
        expect(result.retryable).toBe(true);
      });
    }
  });

  describe("timeout errors (generic, not network/gateway)", () => {
    const cases = ["timeout", "deadline exceeded", "request timed out"];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_API with timeout message`, () => {
        const result = classifySessionError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_API");
        expect(result.userMessage).toContain("timed out");
        expect(result.retryable).toBe(true);
      });
    }

    it('does not steal "connection timeout" from PROVIDER_NETWORK', () => {
      const result = classifySessionError(
        new Error("connection timeout"),
        baseCtx,
      );
      expect(result.code).toBe("PROVIDER_NETWORK");
    });

    it('does not steal "Gateway timeout" from PROVIDER_API', () => {
      const result = classifySessionError(
        new Error("Gateway timeout"),
        baseCtx,
      );
      expect(result.code).toBe("PROVIDER_API");
      expect(result.userMessage).toContain("returned a server error");
    });
  });

  describe("context-too-large errors", () => {
    const cases = [
      "context_length_exceeded",
      "maximum context length is 200000 tokens",
      "token_limit_exceeded: too many tokens in request",
      "token limit exceeded",
      "prompt is too long",
      "The conversation is too long for the model to process.",
      "Request too large for model",
      "too many input tokens: 250000",
      "max_tokens exceeded",
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as CONTEXT_TOO_LARGE`, () => {
        const result = classifySessionError(new Error(msg), baseCtx);
        expect(result.code).toBe("CONTEXT_TOO_LARGE");
        expect(result.retryable).toBe(false);
      });
    }
  });

  describe("context-too-large via ProviderError (400)", () => {
    it("classifies ProviderError 400 with context length message as CONTEXT_TOO_LARGE", () => {
      const err = new ProviderError(
        "context_length_exceeded: your prompt is too long",
        "anthropic",
        400,
      );
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("CONTEXT_TOO_LARGE");
      expect(result.retryable).toBe(false);
    });

    it("classifies ProviderError 413 as CONTEXT_TOO_LARGE", () => {
      const err = new ProviderError(
        "request entity too large",
        "anthropic",
        413,
      );
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("CONTEXT_TOO_LARGE");
      expect(result.retryable).toBe(false);
    });

    it("classifies ProviderError 400 without context length message as PROVIDER_API", () => {
      const err = new ProviderError(
        "invalid_request: missing field",
        "anthropic",
        400,
      );
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });
  });

  describe("abort/cancel errors (non-user-initiated)", () => {
    it('classifies "aborted" as SESSION_ABORTED', () => {
      const result = classifySessionError(
        new Error("Request aborted"),
        baseCtx,
      );
      expect(result.code).toBe("SESSION_ABORTED");
      expect(result.retryable).toBe(true);
    });

    it('classifies "cancelled" as SESSION_ABORTED', () => {
      const result = classifySessionError(
        new Error("Operation cancelled"),
        baseCtx,
      );
      expect(result.code).toBe("SESSION_ABORTED");
      expect(result.retryable).toBe(true);
    });
  });

  describe("regenerate phase", () => {
    it("returns REGENERATE_FAILED with nested classification info", () => {
      const ctx: ErrorContext = { phase: "regenerate" };
      const result = classifySessionError(new Error("ECONNREFUSED"), ctx);
      expect(result.code).toBe("REGENERATE_FAILED");
      expect(result.retryable).toBe(true);
      expect(result.userMessage).toContain("regenerate");
    });

    it("returns REGENERATE_FAILED for generic errors", () => {
      const ctx: ErrorContext = { phase: "regenerate" };
      const result = classifySessionError(new Error("unknown issue"), ctx);
      expect(result.code).toBe("REGENERATE_FAILED");
      expect(result.retryable).toBe(true);
    });
  });

  describe("generic errors", () => {
    it("classifies unknown errors as SESSION_PROCESSING_FAILED with error summary", () => {
      const result = classifySessionError(
        new Error("something completely unexpected"),
        baseCtx,
      );
      expect(result.code).toBe("SESSION_PROCESSING_FAILED");
      expect(result.retryable).toBe(false);
      expect(result.userMessage).toContain("something completely unexpected");
    });

    it("includes debugDetails with stack trace", () => {
      const err = new Error("test error");
      const result = classifySessionError(err, baseCtx);
      expect(result.debugDetails).toBeDefined();
      expect(result.debugDetails).toContain("test error");
    });

    it("handles non-Error values", () => {
      const result = classifySessionError("plain string error", baseCtx);
      expect(result.code).toBe("SESSION_PROCESSING_FAILED");
      expect(result.userMessage).toContain("plain string error");
      expect(result.debugDetails).toBe("plain string error");
    });

    it("falls back to generic message for empty error", () => {
      const result = classifySessionError(new Error(""), baseCtx);
      expect(result.code).toBe("SESSION_PROCESSING_FAILED");
      expect(result.userMessage).toBe(
        "Something went wrong processing your message. Please try again.",
      );
    });

    it("skips leading newlines to find first non-empty line", () => {
      const result = classifySessionError(
        new Error("\n\nactual error on line 3"),
        baseCtx,
      );
      expect(result.code).toBe("SESSION_PROCESSING_FAILED");
      expect(result.userMessage).toContain("actual error on line 3");
    });
  });

  describe("ProviderError with statusCode (deterministic classification)", () => {
    it("classifies ProviderError with 429 as PROVIDER_RATE_LIMIT", () => {
      const err = new ProviderError("Rate limit exceeded", "anthropic", 429);
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_RATE_LIMIT");
      expect(result.retryable).toBe(true);
    });

    it("classifies ProviderError with 500 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Internal server error", "anthropic", 500);
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("classifies ProviderError with 502 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Bad gateway", "openai", 502);
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("classifies ProviderError with 503 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Service unavailable", "gemini", 503);
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("classifies ProviderError with 401 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Unauthorized", "anthropic", 401);
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("classifies ProviderError with 400 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Bad request", "anthropic", 400);
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("ProviderError without statusCode falls back to regex", () => {
      const err = new ProviderError("ECONNREFUSED", "anthropic");
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_NETWORK");
      expect(result.retryable).toBe(true);
    });

    it("statusCode takes priority over conflicting message regex", () => {
      // Message says "rate limit" but statusCode is 500 → should use statusCode
      const err = new ProviderError("rate limit error", "anthropic", 500);
      const result = classifySessionError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });
  });

  describe("debug detail truncation", () => {
    it("truncates debugDetails longer than 4000 chars", () => {
      const longMsg = "x".repeat(5000);
      const result = classifySessionError(new Error(longMsg), baseCtx);
      expect(result.debugDetails!.length).toBeLessThanOrEqual(4020); // 4000 + truncation marker
      expect(result.debugDetails!).toContain("… (truncated)");
    });

    it("preserves debugDetails under 4000 chars", () => {
      const shortMsg = "short error message";
      const result = classifySessionError(new Error(shortMsg), baseCtx);
      expect(result.debugDetails).toBeDefined();
      expect(result.debugDetails!).not.toContain("… (truncated)");
    });
  });

  describe("cancel/abort should NOT produce false-positive session errors", () => {
    it("user-initiated cancel requires both AbortError and active abort signal", () => {
      const abortErr = new DOMException(
        "The operation was aborted",
        "AbortError",
      );
      const abortCtx: ErrorContext = { phase: "agent_loop", aborted: true };
      expect(isUserCancellation(abortErr, abortCtx)).toBe(true);

      // Non-AbortError during abort should NOT be treated as user cancellation
      expect(isUserCancellation(new Error("ECONNRESET"), abortCtx)).toBe(false);
    });

    it("DOMException AbortError is only caught when abort signal is active", () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      const notAborted: ErrorContext = { phase: "agent_loop", aborted: false };
      expect(isUserCancellation(err, notAborted)).toBe(false);

      const aborted: ErrorContext = { phase: "agent_loop", aborted: true };
      expect(isUserCancellation(err, aborted)).toBe(true);
    });
  });
});

describe("buildSessionErrorMessage", () => {
  it("builds a valid SessionErrorMessage", () => {
    const msg = buildSessionErrorMessage("session-123", {
      code: "PROVIDER_NETWORK",
      userMessage: "Network error",
      retryable: true,
      debugDetails: "ECONNREFUSED",
    });

    expect(msg.type).toBe("session_error");
    expect(msg.sessionId).toBe("session-123");
    expect(msg.code).toBe("PROVIDER_NETWORK");
    expect(msg.userMessage).toBe("Network error");
    expect(msg.retryable).toBe(true);
    expect(msg.debugDetails).toBe("ECONNREFUSED");
  });

  it("omits debugDetails when not provided", () => {
    const msg = buildSessionErrorMessage("session-456", {
      code: "UNKNOWN",
      userMessage: "Something went wrong",
      retryable: false,
    });

    expect(msg.type).toBe("session_error");
    expect(msg.debugDetails).toBeUndefined();
  });
});

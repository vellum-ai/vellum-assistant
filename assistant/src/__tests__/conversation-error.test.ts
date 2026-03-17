import { describe, expect, it } from "bun:test";

import type { ErrorContext } from "../daemon/conversation-error.js";
import {
  buildConversationErrorMessage,
  classifyConversationError,
  isUserCancellation,
} from "../daemon/conversation-error.js";
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

describe("classifyConversationError", () => {
  const baseCtx: ErrorContext = { phase: "agent_loop" };

  describe("network errors", () => {
    const cases = [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "socket hang up",
      "The socket connection was closed unexpectedly",
      "Anthropic request failed: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      "fetch failed",
      "Connection refused by server",
      "connection reset",
      "connection timeout",
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_NETWORK`, () => {
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_NETWORK");
        expect(result.retryable).toBe(true);
        expect(result.errorCategory).toBe("provider_network");
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
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_RATE_LIMIT");
        expect(result.retryable).toBe(true);
        expect(result.userMessage).toContain("busy");
        expect(result.errorCategory).toBe("rate_limit");
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
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_API");
        expect(result.retryable).toBe(true);
      });
    }
  });

  describe("timeout errors (generic, not network/gateway)", () => {
    const cases = ["timeout", "deadline exceeded", "request timed out"];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_API with timeout message`, () => {
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_API");
        expect(result.userMessage).toContain("timed out");
        expect(result.retryable).toBe(true);
        expect(result.errorCategory).toBe("provider_timeout");
      });
    }

    it('does not steal "connection timeout" from PROVIDER_NETWORK', () => {
      const result = classifyConversationError(
        new Error("connection timeout"),
        baseCtx,
      );
      expect(result.code).toBe("PROVIDER_NETWORK");
    });

    it('does not steal "Gateway timeout" from PROVIDER_API', () => {
      const result = classifyConversationError(
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
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("CONTEXT_TOO_LARGE");
        expect(result.retryable).toBe(false);
        expect(result.userMessage).toContain("too long");
        expect(result.errorCategory).toBe("context_too_large");
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
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("CONTEXT_TOO_LARGE");
      expect(result.retryable).toBe(false);
    });

    it("classifies ProviderError 413 as CONTEXT_TOO_LARGE", () => {
      const err = new ProviderError(
        "request entity too large",
        "anthropic",
        413,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("CONTEXT_TOO_LARGE");
      expect(result.retryable).toBe(false);
    });

    it("classifies ProviderError 400 without context length message as PROVIDER_API", () => {
      const err = new ProviderError(
        "invalid_request: missing field",
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });
  });

  describe("ordering errors (tool_use/tool_result mismatches)", () => {
    const cases = [
      "tool_result block not immediately after tool_use block",
      "tool_use block must have a matching tool_result",
      "tool_use_id abc123 without corresponding tool_result",
      "tool_result references tool_use_id not found in conversation",
      "messages have invalid order",
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_ORDERING`, () => {
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_ORDERING");
        expect(result.retryable).toBe(true);
        expect(result.userMessage).toBe(
          "An internal error occurred. Please try again.",
        );
        expect(result.errorCategory).toBe("tool_ordering");
      });
    }

    it("classifies ProviderError 400 with ordering message as PROVIDER_ORDERING", () => {
      const err = new ProviderError(
        "Anthropic API error (400): tool_use_id abc without tool_result",
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_ORDERING");
      expect(result.retryable).toBe(true);
      expect(result.errorCategory).toBe("tool_ordering");
    });
  });

  describe("web search ordering errors", () => {
    const cases = [
      "web_search tool_use block without result",
      "web_search tool_result missing from conversation",
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_WEB_SEARCH`, () => {
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_WEB_SEARCH");
        expect(result.retryable).toBe(true);
        expect(result.userMessage).toBe(
          "An internal error occurred with web search. Please try again.",
        );
        expect(result.errorCategory).toBe("web_search_ordering");
      });
    }

    it("classifies ProviderError 400 with web_search ordering message as PROVIDER_WEB_SEARCH", () => {
      const err = new ProviderError(
        "Anthropic API error (400): web_search tool_use without result block",
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_WEB_SEARCH");
      expect(result.retryable).toBe(true);
      expect(result.errorCategory).toBe("web_search_ordering");
    });
  });

  describe("streaming corruption errors", () => {
    const cases = [
      "Unexpected event order, got message_start before receiving message_stop",
      "Anthropic request failed: Unexpected event order, got message_start before receiving \"message_stop\"",
      "stream ended without producing a Message",
      "request ended without sending any chunks",
      "stream has ended, this shouldn't happen",
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_API (retryable)`, () => {
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_API");
        expect(result.retryable).toBe(true);
        expect(result.userMessage).toContain("interrupted");
        expect(result.errorCategory).toBe("stream_corruption");
      });
    }

    it("classifies ProviderError without statusCode with streaming message as PROVIDER_API", () => {
      const err = new ProviderError(
        "Unexpected event order, got message_start before receiving message_stop",
        "anthropic",
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
      expect(result.errorCategory).toBe("stream_corruption");
    });
  });

  describe("abort/cancel errors (non-user-initiated)", () => {
    it('classifies "aborted" as CONVERSATION_ABORTED', () => {
      const result = classifyConversationError(
        new Error("Request aborted"),
        baseCtx,
      );
      expect(result.code).toBe("CONVERSATION_ABORTED");
      expect(result.retryable).toBe(true);
    });

    it('classifies "cancelled" as CONVERSATION_ABORTED', () => {
      const result = classifyConversationError(
        new Error("Operation cancelled"),
        baseCtx,
      );
      expect(result.code).toBe("CONVERSATION_ABORTED");
      expect(result.retryable).toBe(true);
    });
  });

  describe("regenerate phase", () => {
    it("returns REGENERATE_FAILED with nested classification info", () => {
      const ctx: ErrorContext = { phase: "regenerate" };
      const result = classifyConversationError(new Error("ECONNREFUSED"), ctx);
      expect(result.code).toBe("REGENERATE_FAILED");
      expect(result.retryable).toBe(true);
      expect(result.userMessage).toContain("regenerate");
      expect(result.errorCategory).toContain("regenerate:");
    });

    it("returns REGENERATE_FAILED for generic errors", () => {
      const ctx: ErrorContext = { phase: "regenerate" };
      const result = classifyConversationError(new Error("unknown issue"), ctx);
      expect(result.code).toBe("REGENERATE_FAILED");
      expect(result.retryable).toBe(true);
    });
  });

  describe("generic errors", () => {
    it("classifies unknown errors as CONVERSATION_PROCESSING_FAILED with error summary", () => {
      const result = classifyConversationError(
        new Error("something completely unexpected"),
        baseCtx,
      );
      expect(result.code).toBe("CONVERSATION_PROCESSING_FAILED");
      expect(result.retryable).toBe(false);
      expect(result.userMessage).toContain("something completely unexpected");
      expect(result.errorCategory).toBe("processing_failed");
    });

    it("includes debugDetails with stack trace", () => {
      const err = new Error("test error");
      const result = classifyConversationError(err, baseCtx);
      expect(result.debugDetails).toBeDefined();
      expect(result.debugDetails).toContain("test error");
    });

    it("handles non-Error values", () => {
      const result = classifyConversationError("plain string error", baseCtx);
      expect(result.code).toBe("CONVERSATION_PROCESSING_FAILED");
      expect(result.userMessage).toContain("plain string error");
      expect(result.debugDetails).toBe("plain string error");
    });

    it("falls back to generic message for empty error", () => {
      const result = classifyConversationError(new Error(""), baseCtx);
      expect(result.code).toBe("CONVERSATION_PROCESSING_FAILED");
      expect(result.userMessage).toBe(
        "Something went wrong processing your message. Please try again.",
      );
    });

    it("skips leading newlines to find first non-empty line", () => {
      const result = classifyConversationError(
        new Error("\n\nactual error on line 3"),
        baseCtx,
      );
      expect(result.code).toBe("CONVERSATION_PROCESSING_FAILED");
      expect(result.userMessage).toContain("actual error on line 3");
    });
  });

  describe("ProviderError with statusCode (deterministic classification)", () => {
    it("classifies ProviderError with 429 as PROVIDER_RATE_LIMIT", () => {
      const err = new ProviderError("Rate limit exceeded", "anthropic", 429);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_RATE_LIMIT");
      expect(result.retryable).toBe(true);
      expect(result.errorCategory).toBe("rate_limit");
    });

    it("classifies ProviderError with 500 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Internal server error", "anthropic", 500);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("classifies ProviderError with 502 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Bad gateway", "openai", 502);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("classifies ProviderError with 503 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Service unavailable", "gemini", 503);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("classifies ProviderError with 401 as PROVIDER_BILLING (non-retryable)", () => {
      const err = new ProviderError("Unauthorized", "anthropic", 401);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_BILLING");
      expect(result.retryable).toBe(false);
    });

    it("classifies ProviderError with 402 as credits_exhausted (non-retryable)", () => {
      const err = new ProviderError("Payment Required", "anthropic", 402);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_BILLING");
      expect(result.errorCategory).toBe("credits_exhausted");
      expect(result.retryable).toBe(false);
    });

    it("classifies ProviderError with 400 as PROVIDER_API (retryable)", () => {
      const err = new ProviderError("Bad request", "anthropic", 400);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });

    it("ProviderError without statusCode falls back to regex", () => {
      const err = new ProviderError("ECONNREFUSED", "anthropic");
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_NETWORK");
      expect(result.retryable).toBe(true);
    });

    it("statusCode takes priority over conflicting message regex", () => {
      // Message says "rate limit" but statusCode is 500 → should use statusCode
      const err = new ProviderError("rate limit error", "anthropic", 500);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.retryable).toBe(true);
    });
  });

  describe("errorCategory is always present", () => {
    it("includes errorCategory on all classified errors", () => {
      const cases: Array<{ error: unknown; ctx: ErrorContext }> = [
        { error: new Error("ECONNREFUSED"), ctx: baseCtx },
        { error: new Error("rate limit"), ctx: baseCtx },
        { error: new Error("prompt is too long"), ctx: baseCtx },
        { error: new Error("unknown"), ctx: baseCtx },
        {
          error: new ProviderError("error", "anthropic", 500),
          ctx: baseCtx,
        },
      ];
      for (const { error, ctx } of cases) {
        const result = classifyConversationError(error, ctx);
        expect(result.errorCategory).toBeDefined();
        expect(result.errorCategory.length).toBeGreaterThan(0);
      }
    });
  });

  describe("debug detail truncation", () => {
    it("truncates debugDetails longer than 4000 chars", () => {
      const longMsg = "x".repeat(5000);
      const result = classifyConversationError(new Error(longMsg), baseCtx);
      expect(result.debugDetails!.length).toBeLessThanOrEqual(4020); // 4000 + truncation marker
      expect(result.debugDetails!).toContain("(truncated)");
    });

    it("preserves debugDetails under 4000 chars", () => {
      const shortMsg = "short error message";
      const result = classifyConversationError(new Error(shortMsg), baseCtx);
      expect(result.debugDetails).toBeDefined();
      expect(result.debugDetails!).not.toContain("(truncated)");
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

describe("buildConversationErrorMessage", () => {
  it("builds a valid ConversationErrorMessage", () => {
    const msg = buildConversationErrorMessage("session-123", {
      code: "PROVIDER_NETWORK",
      userMessage: "Network error",
      retryable: true,
      debugDetails: "ECONNREFUSED",
      errorCategory: "provider_network",
    });

    expect(msg.type).toBe("conversation_error");
    expect(msg.conversationId).toBe("session-123");
    expect(msg.code).toBe("PROVIDER_NETWORK");
    expect(msg.userMessage).toBe("Network error");
    expect(msg.retryable).toBe(true);
    expect(msg.debugDetails).toBe("ECONNREFUSED");
    expect(msg.errorCategory).toBe("provider_network");
  });

  it("omits debugDetails when not provided", () => {
    const msg = buildConversationErrorMessage("session-456", {
      code: "UNKNOWN",
      userMessage: "Something went wrong",
      retryable: false,
      errorCategory: "processing_failed",
    });

    expect(msg.type).toBe("conversation_error");
    expect(msg.debugDetails).toBeUndefined();
    expect(msg.errorCategory).toBe("processing_failed");
  });

  it("includes errorCategory for ordering errors", () => {
    const msg = buildConversationErrorMessage("session-789", {
      code: "PROVIDER_ORDERING",
      userMessage: "An internal error occurred. Please try again.",
      retryable: true,
      errorCategory: "tool_ordering",
    });

    expect(msg.errorCategory).toBe("tool_ordering");
    expect(msg.code).toBe("PROVIDER_ORDERING");
  });

  it("includes errorCategory for web search errors", () => {
    const msg = buildConversationErrorMessage("session-abc", {
      code: "PROVIDER_WEB_SEARCH",
      userMessage:
        "An internal error occurred with web search. Please try again.",
      retryable: true,
      errorCategory: "web_search_ordering",
    });

    expect(msg.errorCategory).toBe("web_search_ordering");
    expect(msg.code).toBe("PROVIDER_WEB_SEARCH");
  });
});

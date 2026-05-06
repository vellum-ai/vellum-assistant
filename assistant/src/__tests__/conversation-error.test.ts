import { beforeEach, describe, expect, it, mock } from "bun:test";

let providerRoutingSources: Record<string, "user-key" | "managed-proxy"> = {};

mock.module("../providers/registry.js", () => ({
  getProviderRoutingSource: (provider: string) =>
    providerRoutingSources[provider],
}));

import type { ErrorContext } from "../daemon/conversation-error.js";
import {
  buildConversationErrorMessage,
  classifyConversationError,
  isUserCancellation,
} from "../daemon/conversation-error.js";
import {
  type AbortReasonKind,
  createAbortReason,
} from "../util/abort-reasons.js";
import { ProviderError, ProviderNotConfiguredError } from "../util/errors.js";

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

  beforeEach(() => {
    providerRoutingSources = {};
  });

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
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_RATE_LIMIT`, () => {
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_RATE_LIMIT");
        expect(result.retryable).toBe(true);
        expect(result.userMessage).toContain("rate limited");
        expect(result.errorCategory).toBe("rate_limit");
      });
    }

    it("classifies managed-proxy daily quota responses as MANAGED_USAGE_LIMIT", () => {
      const err = new ProviderError(
        'Anthropic API error (429): 429 {"code":"daily_quota_exceeded","detail":"You\'ve reached your usage limit for today. You\'ve made 1000 requests, but your current plan allows 1000 per day.","provider":"anthropic"}',
        "anthropic",
        429,
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("MANAGED_USAGE_LIMIT");
      expect(result.retryable).toBe(true);
      expect(result.userMessage).toContain("Vellum managed inference");
      expect(result.userMessage).toContain("not an AI provider outage");
      expect(result.errorCategory).toBe("managed_usage_limit");
    });

    it("classifies managed-proxy routed 429s as MANAGED_USAGE_LIMIT", () => {
      providerRoutingSources.anthropic = "managed-proxy";
      const err = new ProviderError(
        "Anthropic API error (429): Too many requests",
        "anthropic",
        429,
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("MANAGED_USAGE_LIMIT");
      expect(result.userMessage).toContain("Vellum managed inference");
      expect(result.errorCategory).toBe("managed_usage_limit");
    });

    it("keeps provider copy for direct provider 429s", () => {
      providerRoutingSources.anthropic = "user-key";
      const err = new ProviderError(
        "Anthropic API error (429): Too many requests",
        "anthropic",
        429,
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("PROVIDER_RATE_LIMIT");
      expect(result.userMessage).toContain("AI provider");
      expect(result.errorCategory).toBe("rate_limit");
    });
  });

  describe("provider overloaded errors", () => {
    it('classifies "overloaded" as PROVIDER_OVERLOADED', () => {
      const result = classifyConversationError(
        new Error("overloaded"),
        baseCtx,
      );
      expect(result.code).toBe("PROVIDER_OVERLOADED");
      expect(result.retryable).toBe(true);
      expect(result.userMessage).toContain("overloaded");
      expect(result.errorCategory).toBe("provider_overloaded");
    });

    it("classifies Anthropic overloaded_error (no statusCode) as PROVIDER_OVERLOADED", () => {
      const err = new ProviderError(
        'Anthropic API error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        "anthropic",
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_OVERLOADED");
      expect(result.retryable).toBe(true);
      expect(result.errorCategory).toBe("provider_overloaded");
    });

    it("classifies ProviderError with 529 as PROVIDER_OVERLOADED", () => {
      const err = new ProviderError("Overloaded", "anthropic", 529);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_OVERLOADED");
      expect(result.retryable).toBe(true);
      expect(result.errorCategory).toBe("provider_overloaded");
    });
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

  describe("stale web-search encrypted_content errors", () => {
    const cases = [
      "messages.205.content.0: Invalid `encrypted_content` in `search_result` block",
      "Invalid encrypted_content in search_result block",
      "Invalid `encrypted_content` in `web_search_result` block",
    ];

    for (const msg of cases) {
      it(`classifies "${msg.slice(0, 50)}…" as PROVIDER_WEB_SEARCH / stale_web_search_content`, () => {
        const result = classifyConversationError(new Error(msg), baseCtx);
        expect(result.code).toBe("PROVIDER_WEB_SEARCH");
        expect(result.retryable).toBe(true);
        expect(result.errorCategory).toBe("stale_web_search_content");
        expect(result.userMessage).toBe(
          "Stale web-search results in conversation history. Please try again.",
        );
      });
    }

    it("classifies 400 ProviderError with stale encrypted_content payload", () => {
      const err = new ProviderError(
        'Anthropic API error (400): 400 {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"messages.205.content.0: Invalid `encrypted_content` in `search_result` block\\"}}","provider_name":"Anthropic","is_byok":false}}}',
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_WEB_SEARCH");
      expect(result.errorCategory).toBe("stale_web_search_content");
    });
  });

  describe("provider not configured errors", () => {
    it("classifies ProviderNotConfiguredError as PROVIDER_NOT_CONFIGURED", () => {
      const err = new ProviderNotConfiguredError("anthropic", []);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_NOT_CONFIGURED");
      expect(result.userMessage).toBe(
        "No API key configured for inference. Add one in Settings to start chatting.",
      );
      expect(result.retryable).toBe(true);
      expect(result.errorCategory).toBe("provider_not_configured");
      expect(result.debugDetails).toBeDefined();
    });
  });

  describe("streaming corruption errors", () => {
    const cases = [
      "Unexpected event order, got message_start before receiving message_stop",
      'Anthropic request failed: Unexpected event order, got message_start before receiving "message_stop"',
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
      expect(result.retryable).toBe(true);
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

    it("classifies ProviderError with 401 as PROVIDER_NOT_CONFIGURED (non-retryable)", () => {
      const err = new ProviderError("Unauthorized", "anthropic", 401);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_NOT_CONFIGURED");
      expect(result.retryable).toBe(false);
      expect(result.errorCategory).toBe("provider_not_configured");
    });

    it("classifies direct ProviderError with 402 as provider_billing (non-retryable)", () => {
      const err = new ProviderError("Payment Required", "anthropic", 402);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_BILLING");
      expect(result.errorCategory).toBe("provider_billing");
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

  describe("OpenRouter billing classification", () => {
    it("keeps managed-proxy OpenRouter 402 responses as credits_exhausted", () => {
      providerRoutingSources.openrouter = "managed-proxy";
      const err = new ProviderError(
        "OpenRouter API error (402): Payment Required",
        "openrouter",
        402,
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("PROVIDER_BILLING");
      expect(result.errorCategory).toBe("credits_exhausted");
      expect(result.retryable).toBe(false);
      expect(result.userMessage).toContain("Add funds");
      expect(result.userMessage).toContain("assistant");
    });

    it("classifies direct Anthropic, OpenAI, and OpenRouter 402 responses as provider_billing", () => {
      providerRoutingSources.anthropic = "user-key";
      providerRoutingSources.openai = "user-key";
      providerRoutingSources.openrouter = "user-key";

      for (const provider of ["anthropic", "openai", "openrouter"]) {
        const err = new ProviderError(
          `${provider} API error (402): Payment Required`,
          provider,
          402,
        );

        const result = classifyConversationError(err, baseCtx);

        expect(result.code).toBe("PROVIDER_BILLING");
        expect(result.errorCategory).toBe("provider_billing");
        expect(result.retryable).toBe(false);
        expect(result.userMessage).toContain("provider");
        expect(result.userMessage).toContain("Settings");
      }
    });

    it("classifies OpenRouter 400 credit-limit messages as provider_billing", () => {
      const cases = [
        "OpenRouter API error (400): This request requires more credits",
        "OpenRouter API error (400): You can only afford 1000 tokens",
      ];

      for (const message of cases) {
        const err = new ProviderError(message, "openrouter", 400);

        const result = classifyConversationError(err, baseCtx);

        expect(result.code).toBe("PROVIDER_BILLING");
        expect(result.errorCategory).toBe("provider_billing");
        expect(result.retryable).toBe(false);
      }
    });

    it("classifies managed-proxy OpenRouter insufficient_balance bodies as credits_exhausted", () => {
      providerRoutingSources.openrouter = "managed-proxy";
      const err = new ProviderError(
        'OpenRouter API error (402): {"code":"insufficient_balance","detail":"Managed balance exhausted"}',
        "openrouter",
        402,
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("PROVIDER_BILLING");
      expect(result.errorCategory).toBe("credits_exhausted");
      expect(result.retryable).toBe(false);
    });

    it("classifies direct OpenRouter insufficient_balance bodies as provider_billing", () => {
      providerRoutingSources.openrouter = "user-key";
      const err = new ProviderError(
        'OpenRouter API error (402): {"code":"insufficient_balance","detail":"Provider account balance exhausted"}',
        "openrouter",
        402,
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("PROVIDER_BILLING");
      expect(result.errorCategory).toBe("provider_billing");
      expect(result.retryable).toBe(false);
      expect(result.userMessage).toContain("provider");
      expect(result.userMessage).toContain("Settings");
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

  describe("wrapped ProviderError carrying tagged abort reason", () => {
    const abortedCtx: ErrorContext = { phase: "agent_loop", aborted: true };
    const taggedKinds: AbortReasonKind[] = [
      "user_cancel",
      "preempted_by_new_message",
      "conversation_disposed",
      "subagent_aborted",
      "signal_cancel",
      "voice_session_aborted",
      "work_item_aborted",
    ];

    for (const kind of taggedKinds) {
      it(`treats ProviderError with abortReason kind="${kind}" as user cancellation`, () => {
        const wrapped = new ProviderError(
          "Anthropic API error: Request was aborted.",
          "anthropic",
          undefined,
          { abortReason: createAbortReason(kind, `test:${kind}`) },
        );
        expect(isUserCancellation(wrapped, abortedCtx)).toBe(true);
      });
    }

    it("does NOT treat tagged ProviderError as cancellation when ctx.aborted is false", () => {
      const wrapped = new ProviderError(
        "Anthropic API error: Request was aborted.",
        "anthropic",
        undefined,
        { abortReason: createAbortReason("user_cancel", "test") },
      );
      const notAborted: ErrorContext = { phase: "agent_loop", aborted: false };
      expect(isUserCancellation(wrapped, notAborted)).toBe(false);
    });

    it("does NOT treat ProviderError without abortReason as cancellation", () => {
      const wrapped = new ProviderError(
        "Anthropic API error: Request was aborted.",
        "anthropic",
        undefined,
      );
      expect(isUserCancellation(wrapped, abortedCtx)).toBe(false);
    });

    it("does NOT treat ProviderError with foreign reason as cancellation", () => {
      const wrapped = new ProviderError(
        "Anthropic API error: Request was aborted.",
        "anthropic",
        undefined,
        { abortReason: { kind: "user_cancel", source: "spoofed" } },
      );
      expect(isUserCancellation(wrapped, abortedCtx)).toBe(false);
    });

    it("falls through to CONVERSATION_ABORTED when wrapped ProviderError has no tagged reason", () => {
      const wrapped = new ProviderError(
        "Anthropic API error: Request was aborted.",
        "anthropic",
        undefined,
      );
      const result = classifyConversationError(wrapped, abortedCtx);
      expect(result.code).toBe("CONVERSATION_ABORTED");
      expect(result.errorCategory).toBe("session_aborted");
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

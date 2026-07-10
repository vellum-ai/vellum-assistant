import { beforeEach, describe, expect, it, mock } from "bun:test";

let providerRoutingSources: Record<string, "user-key" | "managed-proxy"> = {};

mock.module("../providers/registry.js", () => ({
  getProviderRoutingSource: (provider: string) =>
    providerRoutingSources[provider],
}));

import type { ErrorContext } from "../daemon/conversation-error.js";
import {
  budgetYieldUnrecoveredClassification,
  buildConversationErrorMessage,
  classifyConversationError,
  isUserCancellation,
} from "../daemon/conversation-error.js";
import { ConnectionResolutionError } from "../providers/connection-resolution.js";
import {
  type AbortReasonKind,
  createAbortReason,
} from "../util/abort-reasons.js";
import {
  ConfigError,
  ProviderError,
  ProviderNotConfiguredError,
  VellumError,
} from "../util/errors.js";

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

  describe("empty-request-messages errors", () => {
    it("classifies Anthropic 400 'at least one message is required' with a friendly message", () => {
      const err = new ProviderError(
        'Anthropic API error (400): 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"},"request_id":"req_011CcdT5QRtS4tapsQiAcJgz"}',
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.errorCategory).toBe("empty_request_messages");
      expect(result.userMessage).not.toMatch(
        /at least one message is required/,
      );
      expect(result.userMessage.toLowerCase()).toContain("no content");
    });

    it("classifies an empty-messages ProviderError without a statusCode", () => {
      const err = new ProviderError(
        "Anthropic API error: messages: at least one message is required",
        "anthropic",
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.errorCategory).toBe("empty_request_messages");
    });
  });

  describe("image-input dimension errors via ProviderError (400)", () => {
    it("classifies Anthropic 400 with image-dimension overflow as image_dimensions_too_large (non-retryable)", () => {
      const err = new ProviderError(
        'Anthropic API error (400): 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.8.content.3.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels"},"request_id":"req_011CaoaGzPXNs2dxAWegSg9D"}',
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("IMAGE_TOO_LARGE");
      expect(result.errorCategory).toBe("image_dimensions_too_large");
      expect(result.retryable).toBe(false);
      expect(result.userMessage).toContain("image");
    });

    it("matches the singular 'image dimension exceeds' phrasing as well", () => {
      const err = new ProviderError(
        "image dimension exceeds max allowed size: 8000 pixels",
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.errorCategory).toBe("image_dimensions_too_large");
      expect(result.retryable).toBe(false);
    });

    it("classifies the base64 payload 'exceeds 5 MB maximum' variant as IMAGE_TOO_LARGE (JARVIS-1041)", () => {
      // This is the exact shape that wedged the reporting user: an oversized
      // image nested in a tool_result. It must route to IMAGE_TOO_LARGE so the
      // recovery path fires, not to a retryable PROVIDER_API loop.
      const err = new ProviderError(
        'Anthropic API error (400): 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.28.content.1.tool_result.content.1.image.source.base64: image exceeds 5 MB maximum: 7465044 bytes > 5242880 bytes"},"request_id":"req_011CbbFqvxBmDQdhVlqxtAfW"}',
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("IMAGE_TOO_LARGE");
      expect(result.errorCategory).toBe("image_dimensions_too_large");
      expect(result.retryable).toBe(false);
    });

    it("does not steal generic 400s that happen to mention 'image'", () => {
      const err = new ProviderError(
        "invalid request: image source is missing",
        "anthropic",
        400,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.errorCategory).toBe("provider_api_error");
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
        "No API key configured for inference. Add one in Settings → Models & Services to start chatting.",
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

    it("classifies ProviderError with 401 as PROVIDER_INVALID_KEY (non-retryable)", () => {
      // 401 means the upstream provider rejected the configured key
      // (vs. PROVIDER_NOT_CONFIGURED which is for a never-set key).
      // The macOS chat renders these on different banners.
      const err = new ProviderError("Unauthorized", "anthropic", 401);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_INVALID_KEY");
      expect(result.retryable).toBe(false);
      expect(result.errorCategory).toBe("provider_invalid_key");
    });

    it("classifies managed-proxy auth failures as managed credential refresh failures", () => {
      providerRoutingSources.anthropic = "managed-proxy";
      const err = new ProviderError(
        'Anthropic API error (403): {"detail":"API key has expired."}',
        "anthropic",
        403,
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("MANAGED_KEY_INVALID");
      expect(result.userMessage).toBe(
        "Couldn't refresh assistant credentials.",
      );
      expect(result.retryable).toBe(false);
      expect(result.errorCategory).toBe("managed_key_invalid");
    });

    it("classifies ProviderError 401 with 'invalid x-api-key' message as PROVIDER_INVALID_KEY", () => {
      // Regex-match branch — Anthropic's standard 401 wording.
      const err = new ProviderError(
        "Anthropic API error: invalid x-api-key",
        "anthropic",
        401,
      );
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_INVALID_KEY");
      expect(result.errorCategory).toBe("provider_invalid_key");
    });

    it("classifies ProviderError 403 with 'invalid api key' message as PROVIDER_INVALID_KEY", () => {
      const err = new ProviderError("OpenAI: Invalid API key", "openai", 403);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_INVALID_KEY");
      expect(result.errorCategory).toBe("provider_invalid_key");
    });

    it("includes connection/profile attribution in PROVIDER_INVALID_KEY when provided", () => {
      const err = new ProviderError("Unauthorized", "anthropic", 401);
      const result = classifyConversationError(err, {
        ...baseCtx,
        connectionName: "my-anthropic",
        profileName: "personal",
      });
      expect(result.code).toBe("PROVIDER_INVALID_KEY");
      expect(result.connectionName).toBe("my-anthropic");
      expect(result.profileName).toBe("personal");
      expect(result.userMessage).toContain("personal");
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

  describe("reason-driven classification (ProviderError.reason)", () => {
    it("classifies reason=model_restricted on the skew-safe PROVIDER_API code with a specific errorCategory", () => {
      const err = new ProviderError(
        "Vercel AI Gateway API error (403): Model claude-opus-4 is restricted on your plan [type=no_providers_available]",
        "vercel-ai-gateway",
        403,
        { reason: "model_restricted" },
      );

      const result = classifyConversationError(err, baseCtx);

      // Rides the existing PROVIDER_API code so version-skewed clients still
      // parse the event; the specific signal is on the free-form errorCategory.
      expect(result.code).toBe("PROVIDER_API");
      expect(result.errorCategory).toBe("provider_model_restricted");
      expect(result.retryable).toBe(false);
      expect(result.userMessage).toContain(
        "Model claude-opus-4 is restricted on your plan",
      );
      expect(result.userMessage).toContain("upgrade your plan");
    });

    it("falls back to the plan sentence without detail when none is extractable", () => {
      const err = new ProviderError(
        "Vercel AI Gateway API error (403): [type=no_providers_available]",
        "vercel-ai-gateway",
        403,
        { reason: "model_restricted" },
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("PROVIDER_API");
      expect(result.errorCategory).toBe("provider_model_restricted");
      expect(result.userMessage).toContain(
        "This model isn't available on your current provider plan. Switch",
      );
    });

    it("routes reason=invalid_credentials to MANAGED_KEY_INVALID under managed-proxy", () => {
      providerRoutingSources["vercel-ai-gateway"] = "managed-proxy";
      const err = new ProviderError(
        "Vercel AI Gateway API error (401): unauthorized",
        "vercel-ai-gateway",
        401,
        { reason: "invalid_credentials" },
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("MANAGED_KEY_INVALID");
      expect(result.errorCategory).toBe("managed_key_invalid");
      expect(result.retryable).toBe(false);
    });

    it("routes reason=invalid_credentials to PROVIDER_INVALID_KEY under a user key", () => {
      providerRoutingSources.openai = "user-key";
      const err = new ProviderError(
        "OpenAI API error (401): invalid api key",
        "openai",
        401,
        { reason: "invalid_credentials" },
      );

      const result = classifyConversationError(err, baseCtx);

      expect(result.code).toBe("PROVIDER_INVALID_KEY");
      expect(result.errorCategory).toBe("provider_invalid_key");
    });

    it("overlays reason=rate_limited both ways (managed vs user)", () => {
      providerRoutingSources.openrouter = "managed-proxy";
      const managed = classifyConversationError(
        new ProviderError("rate limited", "openrouter", 429, {
          reason: "rate_limited",
        }),
        baseCtx,
      );
      expect(managed.code).toBe("MANAGED_USAGE_LIMIT");
      expect(managed.errorCategory).toBe("managed_usage_limit");

      providerRoutingSources.openai = "user-key";
      const user = classifyConversationError(
        new ProviderError("rate limited", "openai", 429, {
          reason: "rate_limited",
        }),
        baseCtx,
      );
      expect(user.code).toBe("PROVIDER_RATE_LIMIT");
      expect(user.errorCategory).toBe("rate_limit");
    });

    it("classifies reason=rate_limited managed quota bodies as MANAGED_USAGE_LIMIT even without a managed routing source", () => {
      // Per-connection platform auth path leaves routingSource unset, so the
      // managed quota body pattern must still win over PROVIDER_RATE_LIMIT.
      providerRoutingSources.openai = "user-key";
      const result = classifyConversationError(
        new ProviderError(
          '{"code":"daily_quota_exceeded"}',
          "openai",
          429,
          { reason: "rate_limited" },
        ),
        baseCtx,
      );
      expect(result.code).toBe("MANAGED_USAGE_LIMIT");
      expect(result.errorCategory).toBe("managed_usage_limit");
    });

    it("defers reason=bad_request to the existing status/regex fallback", () => {
      const err = new ProviderError(
        "context_length_exceeded: your prompt is too long",
        "openai",
        400,
        { reason: "bad_request" },
      );

      const result = classifyConversationError(err, baseCtx);

      // Falls through to the 4xx context-too-large branch, unchanged.
      expect(result.code).toBe("CONTEXT_TOO_LARGE");
      expect(result.errorCategory).toBe("context_too_large");
    });

    it("honors a stamped reason on a statusless ProviderError (no HTTP status)", () => {
      // SDK streaming failures throw with statusCode undefined but can still
      // carry a reason; it must classify semantically, not fall to the fallback.
      const err = new ProviderError("stream failed", "openai", undefined, {
        reason: "insufficient_credits",
      });
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_BILLING");
      expect(result.errorCategory).toBe("provider_billing");
    });

    it("keeps reason-less ProviderErrors on the legacy status path", () => {
      const err = new ProviderError("Unauthorized", "anthropic", 401);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_INVALID_KEY");
      expect(result.errorCategory).toBe("provider_invalid_key");
    });
  });

  describe("reason-less fallback stays functional", () => {
    it("classifies a reason-less network Error via the regex battery", () => {
      const result = classifyConversationError(
        new Error("ECONNREFUSED"),
        baseCtx,
      );
      expect(result.code).toBe("PROVIDER_NETWORK");
      expect(result.errorCategory).toBe("provider_network");
    });

    it("classifies a reason-less ProviderError 500 via the status switch", () => {
      const err = new ProviderError("Internal server error", "openai", 500);
      const result = classifyConversationError(err, baseCtx);
      expect(result.code).toBe("PROVIDER_API");
      expect(result.errorCategory).toBe("provider_server_error");
    });

    it("yields the same classification for a stamped reason and its reason-less twin", () => {
      const withReason = classifyConversationError(
        new ProviderError("boom", "openai", 500, { reason: "server_error" }),
        baseCtx,
      );
      const withoutReason = classifyConversationError(
        new ProviderError("boom", "openai", 500),
        baseCtx,
      );
      expect(withReason.code).toBe(withoutReason.code);
      expect(withReason.errorCategory).toBe(withoutReason.errorCategory);
      expect(withReason.userMessage).toBe(withoutReason.userMessage);
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

describe("budgetYieldUnrecoveredClassification", () => {
  it("returns the BUDGET_YIELD_UNRECOVERED code and retryable=true", () => {
    const classified = budgetYieldUnrecoveredClassification();
    expect(classified.code).toBe("BUDGET_YIELD_UNRECOVERED");
    expect(classified.retryable).toBe(true);
    expect(classified.errorCategory).toBe("budget_yield_unrecovered");
  });

  it("returns a user-facing message that explains the situation", () => {
    const classified = budgetYieldUnrecoveredClassification();
    // The message must communicate (a) compaction was attempted, (b) send
    // another message to continue. Avoid asserting exact wording so copy
    // tweaks don't trip the test, but lock down the two semantic anchors
    // a downstream client could test against.
    expect(classified.userMessage).toContain("compact");
    expect(classified.userMessage).toContain("Send another message");
  });

  it("survives the buildConversationErrorMessage envelope unchanged", () => {
    const classified = budgetYieldUnrecoveredClassification();
    const envelope = buildConversationErrorMessage("conv-1", classified);
    expect(envelope.type).toBe("conversation_error");
    expect(envelope.conversationId).toBe("conv-1");
    expect(envelope.code).toBe("BUDGET_YIELD_UNRECOVERED");
    expect(envelope.retryable).toBe(true);
    expect(envelope.errorCategory).toBe("budget_yield_unrecovered");
    expect(envelope.userMessage).toBe(classified.userMessage);
  });
});

describe("ConnectionResolutionError classification", () => {
  const errCtx: ErrorContext = { phase: "agent_loop" };

  it("classifies provider_mismatch as PROVIDER_NOT_CONFIGURED with user-friendly message", () => {
    const err = new ConnectionResolutionError(
      "anthropic-managed",
      "provider_mismatch",
      'provider_connection "anthropic-managed" has provider="anthropic" but resolving profile declared provider="openai"',
    );
    const result = classifyConversationError(err, errCtx);
    expect(result.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(result.userMessage).toContain('"anthropic-managed"');
    expect(result.userMessage).toContain("different provider");
    expect(result.userMessage).toContain("Settings");
    expect(result.userMessage).not.toContain("provider_connection");
    expect(result.connectionName).toBe("anthropic-managed");
    expect(result.debugDetails).toContain(
      "connection_resolution:provider_mismatch",
    );
  });

  it("classifies not_found as PROVIDER_NOT_CONFIGURED naming the connection and profile", () => {
    const err = new ConnectionResolutionError(
      "deleted-connection",
      "not_found",
      'provider_connection "deleted-connection" not found in DB',
      { profileName: "custom-fast" },
    );
    const result = classifyConversationError(err, errCtx);
    expect(result.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(result.userMessage).toContain('"deleted-connection"');
    expect(result.userMessage).toContain('profile "custom-fast"');
    expect(result.userMessage).toContain("no longer exists");
    expect(result.userMessage).not.toContain("not found in DB");
    expect(result.profileName).toBe("custom-fast");
  });

  it("classifies missing_connection with an add-a-key fix and no sentinel name", () => {
    const err = new ConnectionResolutionError(
      "<llm.default>",
      "missing_connection",
      "llm.default.provider_connection is unset",
    );
    const result = classifyConversationError(err, errCtx);
    expect(result.userMessage).toContain(
      "No provider connection is configured",
    );
    expect(result.userMessage).toContain("Add an API key or log in");
    expect(result.userMessage).not.toContain("<llm.default>");
    expect(result.connectionName).toBeUndefined();
  });

  it("classifies model_incompatible naming the model", () => {
    const err = new ConnectionResolutionError(
      "chatgpt-codex",
      "model_incompatible",
      "subscription connection only serves codex models",
      { model: "claude-fable-5" },
    );
    const result = classifyConversationError(err, errCtx);
    expect(result.userMessage).toContain('Model "claude-fable-5"');
    expect(result.userMessage).toContain('"chatgpt-codex"');
  });

  it("classifies lookup_failed with a restart hint and preserves the cause", () => {
    const cause = new Error("db locked");
    const err = new ConnectionResolutionError(
      "anthropic-personal",
      "lookup_failed",
      "lookup failed",
      { cause },
    );
    expect(err.cause).toBe(cause);
    const result = classifyConversationError(err, errCtx);
    expect(result.userMessage).toContain("Restart the assistant");
  });

  it("classifies missing_credential naming the connection and fix", () => {
    const err = new ConnectionResolutionError(
      "anthropic-personal",
      "missing_credential",
      "no key",
      { profileName: "custom-fast" },
    );
    const result = classifyConversationError(err, errCtx);
    expect(result.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(result.userMessage).toContain('"anthropic-personal"');
    expect(result.userMessage).toContain("no stored credential");
    expect(result.userMessage).toContain('profile "custom-fast"');
  });

  it("classifies platform_unauthenticated with a log-in fix", () => {
    const err = new ConnectionResolutionError(
      "vellum",
      "platform_unauthenticated",
      "not logged in",
    );
    const result = classifyConversationError(err, errCtx);
    expect(result.userMessage).toContain("platform login");
    expect(result.userMessage).toContain("Log in");
  });

  it("is a structured VellumError (ConfigError) for logging/monitoring", () => {
    const err = new ConnectionResolutionError("x", "not_found", "m");
    expect(err).toBeInstanceOf(VellumError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.name).toBe("ConnectionResolutionError");
  });

  it("prefers the error's own profileName over context attribution", () => {
    const err = new ConnectionResolutionError("c", "not_found", "m", {
      profileName: "from-error",
    });
    const result = classifyConversationError(err, {
      ...errCtx,
      profileName: "from-context",
    });
    expect(result.profileName).toBe("from-error");
  });

  it("falls back to context attribution when the error carries no profile", () => {
    const err = new ConnectionResolutionError("c", "not_found", "m");
    const result = classifyConversationError(err, {
      ...errCtx,
      profileName: "from-context",
    });
    expect(result.profileName).toBe("from-context");
  });
});

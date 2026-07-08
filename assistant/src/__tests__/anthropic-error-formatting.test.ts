import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock Anthropic SDK — inject a throwing stream so we can assert on the
// message format produced by the client's error-mapping path (JARVIS-390).
// ---------------------------------------------------------------------------

class FakeAPIError extends Error {
  status: number | undefined;
  headers: Map<string, string> = new Map();
  error: unknown;
  constructor(status: number | undefined, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.error = body;
    this.name = "APIError";
  }
}

/** Anthropic error body shape: `{ type: "error", error: { type, message } }`. */
function anthropicBody(type: string, message?: string): unknown {
  return { type: "error", error: { type, message: message ?? "" } };
}

let nextThrown: FakeAPIError | null = null;

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    static APIError = FakeAPIError;
    constructor(_args: Record<string, unknown>) {}
    #streamImpl = () => ({
      on() {
        return this;
      },
      async finalMessage() {
        if (nextThrown) throw nextThrown;
        return {
          content: [],
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stop_reason: "end_turn",
        };
      },
    });
    messages = { stream: () => this.#streamImpl() };
    beta = { messages: { stream: () => this.#streamImpl() } };
  },
}));

import { AnthropicProvider } from "../providers/anthropic/client.js";
import { ContextOverflowError } from "../providers/types.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { ProviderError, type ProviderErrorReason } from "../util/errors.js";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("AnthropicProvider — error message formatting (JARVIS-390)", () => {
  beforeEach(() => {
    nextThrown = null;
  });

  test("omits the `(status)` parenthetical when the SDK reports no HTTP status", async () => {
    // Reproduces the abort/mid-stream path where `error.status` is undefined.
    nextThrown = new FakeAPIError(undefined, "Request was aborted.");

    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");

    try {
      await provider.sendMessage([userMsg("hi")]);
      throw new Error("expected sendMessage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const message = (err as Error).message;
      expect(message).toBe("Anthropic API error: Request was aborted.");
      // Belt-and-suspenders: the literal "(undefined)" must never appear.
      expect(message).not.toContain("(undefined)");
    }
  });

  test("includes the `(status)` parenthetical when the SDK reports an HTTP status", async () => {
    nextThrown = new FakeAPIError(
      402,
      "Billing issue: your credit balance is too low.",
    );

    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");

    try {
      await provider.sendMessage([userMsg("hi")]);
      throw new Error("expected sendMessage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const message = (err as Error).message;
      expect(message).toContain("Anthropic API error (402):");
      expect((err as ProviderError).statusCode).toBe(402);
    }
  });
});

describe("AnthropicProvider — semantic reason stamping", () => {
  beforeEach(() => {
    nextThrown = null;
  });

  async function reasonFor(error: FakeAPIError): Promise<ProviderError> {
    nextThrown = error;
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    try {
      await provider.sendMessage([userMsg("hi")]);
      throw new Error("expected sendMessage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      return err as ProviderError;
    }
  }

  const cases: Array<{
    name: string;
    error: FakeAPIError;
    reason: ProviderErrorReason;
  }> = [
    {
      name: "authentication_error → invalid_credentials",
      error: new FakeAPIError(
        401,
        "invalid x-api-key",
        anthropicBody("authentication_error"),
      ),
      reason: "invalid_credentials",
    },
    {
      name: "generic 403 permission → invalid_credentials",
      error: new FakeAPIError(
        403,
        "Forbidden",
        anthropicBody("permission_error"),
      ),
      reason: "invalid_credentials",
    },
    {
      name: "403 model/plan restriction → model_restricted",
      error: new FakeAPIError(
        403,
        "Your plan does not have access to this model",
        anthropicBody("permission_error"),
      ),
      reason: "model_restricted",
    },
    {
      name: "generic 403 'not allowed' without model context → invalid_credentials",
      error: new FakeAPIError(
        403,
        "Request not allowed: access denied",
        anthropicBody("permission_error"),
      ),
      reason: "invalid_credentials",
    },
    {
      name: "not_found_error → model_not_found",
      error: new FakeAPIError(
        404,
        "model: claude-nope not found",
        anthropicBody("not_found_error"),
      ),
      reason: "model_not_found",
    },
    {
      name: "non-model 404 (missing gateway resource) → bad_request (defers to legacy fallback)",
      error: new FakeAPIError(404, "Not Found: /v1/messages", undefined),
      reason: "bad_request",
    },
    {
      name: "rate_limit_error → rate_limited",
      error: new FakeAPIError(
        429,
        "rate limited",
        anthropicBody("rate_limit_error"),
      ),
      reason: "rate_limited",
    },
    {
      name: "overloaded_error (529) → overloaded",
      error: new FakeAPIError(
        529,
        "Overloaded",
        anthropicBody("overloaded_error"),
      ),
      reason: "overloaded",
    },
    {
      name: "billing/credits → insufficient_credits",
      error: new FakeAPIError(
        400,
        "Your credit balance is too low to access the API.",
        anthropicBody("invalid_request_error"),
      ),
      reason: "insufficient_credits",
    },
    {
      name: "5xx → server_error",
      error: new FakeAPIError(503, "internal", anthropicBody("api_error")),
      reason: "server_error",
    },
    {
      name: "other 4xx → bad_request",
      error: new FakeAPIError(
        400,
        "messages: malformed request",
        anthropicBody("invalid_request_error"),
      ),
      reason: "bad_request",
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const err = await reasonFor(c.error);
      expect(err.reason).toBe(c.reason);
    });
  }

  test("stamps apiErrorType from the inner error body", async () => {
    const err = await reasonFor(
      new FakeAPIError(429, "rate limited", anthropicBody("rate_limit_error")),
    );
    expect(err.apiErrorType).toBe("rate_limit_error");
  });

  test("context overflow → ContextOverflowError with reason context_overflow", async () => {
    nextThrown = new FakeAPIError(
      400,
      "prompt is too long: 250000 tokens > 200000 maximum",
      anthropicBody(
        "invalid_request_error",
        "prompt is too long: 250000 tokens > 200000 maximum",
      ),
    );
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    try {
      await provider.sendMessage([userMsg("hi")]);
      throw new Error("expected sendMessage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContextOverflowError);
      const overflow = err as ContextOverflowError;
      expect(overflow.reason).toBe("context_overflow");
      expect(overflow.actualTokens).toBe(250000);
      expect(overflow.maxTokens).toBe(200000);
    }
  });

  test("does not stamp a reason on caller-aborted requests", async () => {
    const abortReason = createAbortReason("user_cancel", "test");
    const controller = new AbortController();
    controller.abort(abortReason);
    nextThrown = new FakeAPIError(undefined, "Request was aborted.");
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    try {
      await provider.sendMessage([userMsg("hi")], {
        signal: controller.signal,
      });
      throw new Error("expected sendMessage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).reason).toBeUndefined();
      expect((err as ProviderError).abortReason).toBe(abortReason);
    }
  });
});

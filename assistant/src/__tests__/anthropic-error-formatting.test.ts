import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock Anthropic SDK — inject a throwing stream so we can assert on the
// message format produced by the client's error-mapping path (JARVIS-390).
// ---------------------------------------------------------------------------

class FakeAPIError extends Error {
  status: number | undefined;
  headers: Map<string, string> = new Map();
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
    this.name = "APIError";
  }
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
import { ProviderError } from "../util/errors.js";

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

import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import { DEFAULT_MAX_RETRIES } from "../daemon/conversation-rate-limit-retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { ProviderError } from "../util/errors.js";

function rateLimitError(): ProviderError {
  return new ProviderError(
    "Anthropic API error (429): Too many requests",
    "mock-provider",
    429,
    { reason: "rate_limited", retryAfterMs: 0 },
  );
}

function textReply(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

function runLoop(
  provider: Provider,
  options?: { signal?: AbortSignal },
): Promise<{ events: AgentEvent[]; calls: number }> {
  const events: AgentEvent[] = [];
  let calls = 0;
  const wrapped: Provider = {
    name: provider.name,
    async sendMessage(messages: Message[], sendOptions?: SendMessageOptions) {
      calls++;
      return provider.sendMessage(messages, sendOptions);
    },
  };
  const loop = new AgentLoop({
    provider: wrapped,
    systemPrompt: "system",
    conversationId: "conv-xyz",
  });
  return loop
    .run({
      requestId: "req-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: (event) => {
        events.push(event);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      ...(options?.signal ? { signal: options.signal } : {}),
    })
    .then(() => ({ events, calls }));
}

describe("AgentLoop rate-limit retries", () => {
  test("retries a PROVIDER_RATE_LIMIT error and completes without an error event", async () => {
    let attempts = 0;
    const provider: Provider = {
      name: "mock-provider",
      async sendMessage() {
        attempts++;
        if (attempts === 1) {
          throw rateLimitError();
        }
        return textReply("recovered");
      },
    };

    const { events, calls } = await runLoop(provider);

    expect(calls).toBe(2);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "message_complete")).toBe(
      true,
    );
  });

  test("emits a terminal error after DEFAULT_MAX_RETRIES", async () => {
    const provider: Provider = {
      name: "mock-provider",
      async sendMessage() {
        throw rateLimitError();
      },
    };

    const { events, calls } = await runLoop(provider);

    expect(calls).toBe(1 + DEFAULT_MAX_RETRIES);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.type === "error" && errorEvent.error).toBeInstanceOf(
      ProviderError,
    );
  });

  test("does not retry when the abort signal is already active", async () => {
    const controller = new AbortController();
    const provider: Provider = {
      name: "mock-provider",
      async sendMessage() {
        controller.abort();
        throw rateLimitError();
      },
    };

    const { events, calls } = await runLoop(provider, {
      signal: controller.signal,
    });

    expect(calls).toBe(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("does not retry a retryable non-rate-limit provider error", async () => {
    const provider: Provider = {
      name: "mock-provider",
      async sendMessage() {
        throw new ProviderError(
          "Anthropic API error (529): Overloaded",
          "mock-provider",
          529,
          { reason: "overloaded", retryAfterMs: 0 },
        );
      },
    };

    const { events, calls } = await runLoop(provider);

    expect(calls).toBe(1);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  test("aborts during the rate-limit backoff instead of emitting an error event", async () => {
    const controller = new AbortController();
    const provider: Provider = {
      name: "mock-provider",
      async sendMessage() {
        throw new ProviderError(
          "Anthropic API error (429): Too many requests",
          "mock-provider",
          429,
          { reason: "rate_limited", retryAfterMs: 200 },
        );
      },
    };

    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "conv-xyz",
    });
    const run = loop.run({
      requestId: "req-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: (event) => {
        events.push(event);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(run).rejects.toBeDefined();
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
});

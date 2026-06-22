/**
 * Integration tests for the agent loop's `provider_error` recording path.
 *
 * When the provider call throws (provider rejected the request before
 * returning a usable response), the loop must emit a `provider_error` event
 * carrying the loop-level raw request and the thrown error so downstream
 * consumers can persist an `llm_request_logs` row. Without this, rejected
 * calls leave nothing in the LLM inspector — only a pino log line.
 *
 * Coverage:
 *  - Emits `provider_error` with `rawRequest`, `error`, and `actualProvider`
 *    when the provider throws a `ProviderError`.
 *  - `rawRequest` carries the message history, tools, and system prompt the
 *    loop attempted to send — so the row replays/debugs cleanly.
 *  - `actualProvider` echoes `ProviderError.provider` when available, falling
 *    back to `provider.name` for non-ProviderError throws.
 *  - The error is still re-thrown internally (the existing `error` event
 *    still fires after the new `provider_error` event), preserving the
 *    outer-catch behavior (abort/Sentry/break).
 *  - Skips emission on user-aborted runs — there is no provider rejection
 *    worth recording when the user cancelled.
 */

import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";
import { ProviderError } from "../util/errors.js";

/**
 * Build a provider that throws on every `sendMessage` call. Records what
 * the loop attempted to send so the test can assert `rawRequest` carries
 * the right payload.
 */
function makeThrowingProvider(
  name: string,
  throwFn: () => Error,
): {
  provider: Provider;
  calls: Array<{
    messages: Message[];
    tools?: ToolDefinition[];
    systemPrompt?: string;
  }>;
} {
  const calls: Array<{
    messages: Message[];
    tools?: ToolDefinition[];
    systemPrompt?: string;
  }> = [];
  const provider: Provider = {
    name,
    async sendMessage(
      messages: Message[],
      _options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      calls.push({
        messages: [...messages],
        tools: _options?.tools,
        systemPrompt: _options?.systemPrompt,
      });
      throw throwFn();
    },
  };
  return { provider, calls };
}

describe("AgentLoop provider_error event emission", () => {
  test("emits provider_error with loop-level rawRequest when provider throws ProviderError", async () => {
    const thrown = new ProviderError(
      "Anthropic API error (429): rate limited",
      "anthropic",
      429,
      { retryAfterMs: 1500 },
    );
    const { provider, calls } = makeThrowingProvider("anthropic", () => thrown);

    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "you are a helpful assistant",
      conversationId: "test-conversation",
    });

    await loop.run({
      requestId: "test-request",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);

    const providerErrorEvent = events.find((e) => e.type === "provider_error");
    expect(providerErrorEvent).toBeDefined();
    if (providerErrorEvent?.type !== "provider_error") {
      throw new Error("type narrowing");
    }
    expect(providerErrorEvent.error).toBe(thrown);
    expect(providerErrorEvent.actualProvider).toBe("anthropic");

    // rawRequest should carry the loop-level abstract shape: messages,
    // tools, systemPrompt, and the provider name we tried to dispatch
    // through. The provider-specific shape (e.g. Gemini's `contents`) is
    // never built because the provider threw before returning it.
    const raw = providerErrorEvent.rawRequest as Record<string, unknown>;
    expect(raw.provider).toBe("anthropic");
    expect(raw.systemPrompt).toBe("you are a helpful assistant");
    expect(Array.isArray(raw.messages)).toBe(true);
    expect((raw.messages as Message[])[0].role).toBe("user");
  });

  test("error event still fires after provider_error (outer catch behavior unchanged)", async () => {
    const thrown = new ProviderError(
      "Gemini API error (500): internal",
      "gemini",
      500,
    );
    const { provider } = makeThrowingProvider("gemini", () => thrown);

    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    await loop.run({
      requestId: "test-request",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const providerErrorIdx = events.findIndex(
      (e) => e.type === "provider_error",
    );
    const errorIdx = events.findIndex((e) => e.type === "error");
    expect(providerErrorIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    // Recording-first ordering is load-bearing: a consumer that sees the
    // generic `error` event and shuts the stream down must have already
    // received the `provider_error` row for the rejected call.
    expect(providerErrorIdx).toBeLessThan(errorIdx);
  });

  test("falls back to provider.name when a non-ProviderError is thrown", async () => {
    const thrown = new Error("unexpected SDK boom");
    const { provider } = makeThrowingProvider("openai", () => thrown);

    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    await loop.run({
      requestId: "test-request",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    const providerErrorEvent = events.find((e) => e.type === "provider_error");
    expect(providerErrorEvent).toBeDefined();
    if (providerErrorEvent?.type !== "provider_error") {
      throw new Error("type narrowing");
    }
    // The thrown Error has no `.provider` field, so the event falls back to
    // the dispatching provider's `name` — keeps the persisted log row's
    // `provider` column populated even for surprise errors.
    expect(providerErrorEvent.actualProvider).toBe("openai");
    expect(providerErrorEvent.error).toBe(thrown);
  });

  test("does NOT emit provider_error on user-aborted runs", async () => {
    const controller = new AbortController();
    const thrown = new Error("aborted");
    const { provider } = makeThrowingProvider("anthropic", () => {
      // Pre-abort then throw so the loop's catch sees `signal.aborted === true`.
      controller.abort();
      return thrown;
    });

    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    await loop.run({
      requestId: "test-request",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: controller.signal,
    });

    const providerErrorEvent = events.find((e) => e.type === "provider_error");
    // Cancellation should never produce a recording row — there's no
    // provider rejection worth logging when the user pulled the plug.
    expect(providerErrorEvent).toBeUndefined();
  });
});

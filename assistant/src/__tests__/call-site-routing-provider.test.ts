/**
 * Verifies that `CallSiteRoutingProvider` selects the right underlying
 * provider transport per call based on `options.config.callSite`.
 *
 * The wrapper exists so per-call-site `llm.callSites.<id>.provider`
 * overrides actually swap the HTTP transport, not just the request
 * metadata. The conversation's transport is fixed at construction time;
 * without this wrapper a memoryRetrieval call configured to run on OpenAI
 * but originating from an Anthropic-default conversation would still hit
 * the Anthropic transport.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Mutable LLM config consumed by the resolver via `getConfig()`.
let mockLlmConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: mockLlmConfig }),
}));

import { LLMSchema } from "../config/schemas/llm.js";
import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";

const DUMMY_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

function makeResponse(model: string): ProviderResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

function makeProvider(
  name: string,
  onCall: (options: SendMessageOptions | undefined) => void,
): Provider {
  return {
    name,
    async sendMessage(_messages, _tools, _systemPrompt, options) {
      onCall(options);
      return makeResponse(name);
    },
  };
}

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
});

describe("CallSiteRoutingProvider", () => {
  test("routes to default provider when callSite is absent", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        memoryRetrieval: { provider: "openai", model: "gpt-5.4" },
      },
    });

    const calls = { default: 0, alt: 0 };
    const defaultProvider = makeProvider("anthropic", () => {
      calls.default++;
    });
    const altProvider = makeProvider("openai", () => {
      calls.alt++;
    });

    const wrapped = new CallSiteRoutingProvider(defaultProvider, (name) =>
      name === "openai" ? altProvider : undefined,
    );

    const response = await wrapped.sendMessage(
      DUMMY_MESSAGES,
      undefined,
      undefined,
      // No callSite — must hit default even though `memoryRetrieval` is
      // configured for openai.
      { config: {} },
    );

    expect(calls.default).toBe(1);
    expect(calls.alt).toBe(0);
    expect(response.model).toBe("anthropic");
  });

  test("routes to default provider when callSite resolves to same provider name", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        // Same provider as default — no transport swap needed.
        memoryRetrieval: { model: "claude-haiku-4-5-20251001" },
      },
    });

    const calls = { default: 0, alt: 0 };
    const defaultProvider = makeProvider("anthropic", () => {
      calls.default++;
    });
    const altProvider = makeProvider("openai", () => {
      calls.alt++;
    });

    const wrapped = new CallSiteRoutingProvider(defaultProvider, (name) =>
      name === "openai" ? altProvider : undefined,
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "memoryRetrieval" },
    });

    expect(calls.default).toBe(1);
    expect(calls.alt).toBe(0);
  });

  test("routes to alternative provider when callSite resolves to a different provider name", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        memoryRetrieval: { provider: "openai", model: "gpt-5.4" },
      },
    });

    const calls = { default: 0, alt: 0 };
    const defaultProvider = makeProvider("anthropic", () => {
      calls.default++;
    });
    const altProvider = makeProvider("openai", () => {
      calls.alt++;
    });

    const wrapped = new CallSiteRoutingProvider(defaultProvider, (name) =>
      name === "openai" ? altProvider : undefined,
    );

    const response = await wrapped.sendMessage(
      DUMMY_MESSAGES,
      undefined,
      undefined,
      { config: { callSite: "memoryRetrieval" } },
    );

    expect(calls.default).toBe(0);
    expect(calls.alt).toBe(1);
    expect(response.model).toBe("openai");
  });

  test("falls back to default when alternative provider is not registered", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        memoryRetrieval: { provider: "openai", model: "gpt-5.4" },
      },
    });

    const calls = { default: 0 };
    const defaultProvider = makeProvider("anthropic", () => {
      calls.default++;
    });

    // Lookup always returns undefined — simulating a missing/uninitialized
    // provider in the registry.
    const wrapped = new CallSiteRoutingProvider(
      defaultProvider,
      () => undefined,
    );

    const response = await wrapped.sendMessage(
      DUMMY_MESSAGES,
      undefined,
      undefined,
      { config: { callSite: "memoryRetrieval" } },
    );

    expect(calls.default).toBe(1);
    expect(response.model).toBe("anthropic");
  });

  test("delegates `name` and `tokenEstimationProvider` to the default provider", () => {
    const defaultProvider: Provider = {
      name: "anthropic",
      tokenEstimationProvider: "anthropic",
      async sendMessage() {
        return makeResponse("anthropic");
      },
    };

    const wrapped = new CallSiteRoutingProvider(
      defaultProvider,
      () => undefined,
    );

    expect(wrapped.name).toBe("anthropic");
    expect(wrapped.tokenEstimationProvider).toBe("anthropic");
  });
});

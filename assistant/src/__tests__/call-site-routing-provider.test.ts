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

  test("stamps actualProvider when routing to an alternative provider", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        memoryRetrieval: { provider: "openai", model: "gpt-5.5" },
      },
    });

    const defaultProvider = makeProvider("anthropic", () => {});
    const altProvider = makeProvider("openai", () => {});

    const wrapped = new CallSiteRoutingProvider(defaultProvider, (name) =>
      name === "openai" ? altProvider : undefined,
    );

    const response = await wrapped.sendMessage(
      DUMMY_MESSAGES,
      undefined,
      undefined,
      { config: { callSite: "memoryRetrieval" } },
    );

    // actualProvider must reflect the alternative, not the default, so that
    // loop.ts / emitUsage / llm_call_finished log and bill the correct
    // provider (fixes gpt-5.5 showing as "anthropic" with $0 cost).
    expect(response.actualProvider).toBe("openai");
  });

  test("does not overwrite actualProvider already set by the alternative provider", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        memoryRetrieval: { provider: "openai", model: "gpt-5.5" },
      },
    });

    const defaultProvider = makeProvider("anthropic", () => {});
    // Simulate a wrapper provider that sets actualProvider itself
    const altProvider: Provider = {
      name: "openai",
      async sendMessage() {
        return {
          ...makeResponse("openai"),
          actualProvider: "openai-via-proxy",
        };
      },
    };

    const wrapped = new CallSiteRoutingProvider(defaultProvider, (name) =>
      name === "openai" ? altProvider : undefined,
    );

    const response = await wrapped.sendMessage(
      DUMMY_MESSAGES,
      undefined,
      undefined,
      { config: { callSite: "memoryRetrieval" } },
    );

    expect(response.actualProvider).toBe("openai-via-proxy");
  });

  test("does not set actualProvider when routing to the default provider", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    const defaultProvider = makeProvider("anthropic", () => {});

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

    // No alternative was resolved — actualProvider should stay unset.
    expect(response.actualProvider).toBeUndefined();
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

  test("name getter reflects the routed provider during sendMessage and reverts after", async () => {
    // Regression: emitLlmCallStartedIfNeeded fires on the first text_delta,
    // *during* the sendMessage call (before the response completes). It reads
    // provider.name directly — if that's always the default name the trace
    // event says "LLM call to anthropic" even when the call went to openai.
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        memoryRetrieval: { provider: "openai", model: "gpt-5.5" },
      },
    });

    const defaultProvider = makeProvider("anthropic", () => {});
    const namesDuringCall: string[] = [];

    const altProvider: Provider = {
      name: "openai",
      async sendMessage() {
        // Simulate reading provider.name mid-stream (as handleTextDelta does).
        namesDuringCall.push(wrapped.name);
        return makeResponse("openai");
      },
    };

    const wrapped = new CallSiteRoutingProvider(defaultProvider, (name) =>
      name === "openai" ? altProvider : undefined,
    );

    expect(wrapped.name).toBe("anthropic"); // idle → default
    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "memoryRetrieval" },
    });
    expect(namesDuringCall).toEqual(["openai"]); // mid-call → routed provider
    expect(wrapped.name).toBe("anthropic"); // after call → reverted to default
  });

  test("concurrent sendMessage calls each see their own provider name (no clobbering)", async () => {
    // Regression: if _routedProviderName were a plain instance field, concurrent
    // calls (e.g. main turn + title-gen both in-flight) would clobber each
    // other. AsyncLocalStorage gives each call its own async-context slot.
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        memoryRetrieval: { provider: "openai", model: "gpt-5.5" },
        conversationTitle: { provider: "fireworks", model: "qwen3-235b" },
      },
    });

    const defaultProvider = makeProvider("anthropic", () => {});
    const nameSeenByOpenAI: string[] = [];
    const nameSeenByFireworks: string[] = [];

    // Shared resolve handles so we can interleave the two calls:
    // openAI starts → fireworks starts → openAI resolves → fireworks resolves
    let resolveOpenAI!: () => void;
    let resolveFireworks!: () => void;

    const openAIProvider: Provider = {
      name: "openai",
      async sendMessage() {
        // Yield so fireworks call can start before we complete.
        await new Promise<void>((r) => {
          resolveOpenAI = r;
        });
        nameSeenByOpenAI.push(wrapped.name);
        return makeResponse("openai");
      },
    };

    const fireworksProvider: Provider = {
      name: "fireworks",
      async sendMessage() {
        await new Promise<void>((r) => {
          resolveFireworks = r;
        });
        nameSeenByFireworks.push(wrapped.name);
        return makeResponse("fireworks");
      },
    };

    const wrapped = new CallSiteRoutingProvider(defaultProvider, (name) => {
      if (name === "openai") return openAIProvider;
      if (name === "fireworks") return fireworksProvider;
      return undefined;
    });

    // Start both calls concurrently (do not await yet).
    const callA = wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "memoryRetrieval" }, // → openai
    });
    const callB = wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "conversationTitle" }, // → fireworks
    });

    // Let both reach their suspension point, then resolve in order.
    await Promise.resolve(); // flush microtasks so both calls are in-flight
    resolveOpenAI();
    resolveFireworks();

    await Promise.all([callA, callB]);

    // Each call must have seen its own provider, not the other's.
    expect(nameSeenByOpenAI).toEqual(["openai"]);
    expect(nameSeenByFireworks).toEqual(["fireworks"]);
    // And the idle name reverts to the default.
    expect(wrapped.name).toBe("anthropic");
  });
});

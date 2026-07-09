import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";

// Legacy-shaped fixtures (llm.default-centric resolution): pinned to the
// flag-off cascade. Override-or-default (flag-on) semantics are pinned by
// llm-resolver-override-or-default.test.ts and its companion suites.
beforeAll(() => {
  setOverridesForTesting({ "override-or-default-resolution": false });
});

// ── Module mocks ────────────────────────────────────────────────────────────
//
// Stub the logger so retry diagnostics don't pollute test output.
mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Mutable test fixtures for `getConfig()`. Each test rebuilds the relevant
// pieces via `setLlmConfig(...)` before exercising the path. The mock is
// registered once and reads from these closures so subsequent tests don't
// need to remock the module.
let mockLlmConfig: Record<string, unknown> = {};

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    llm: mockLlmConfig,
    services: { inference: { mode: "your-own" } },
  }),
}));

// Provider registry mock. Tests populate `mockProviders` via `beforeEach` /
// per-test `set` so `getProvider(name)` can return the right stub.
const mockProviders = new Map<string, { name: string }>();

mock.module("../registry.js", () => ({
  getProvider: (name: string) => {
    const p = mockProviders.get(name);
    if (!p) {
      throw new Error(`unknown provider: ${name}`);
    }
    return p;
  },
  initializeProviders: async () => {},
  listProviders: () => Array.from(mockProviders.values()),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { LLMSchema } from "../../config/schemas/llm.js";
import { RetryProvider } from "../retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

// Side-effect import: ensures `provider-send-message.ts` (and its transitive
// `connection-resolution` + `registry`) are loaded in a deterministic order
// across the test suite. Without this, bun's module loader has produced
// "Export named 'clearConnectionProviderCache' not found" errors when this
// file runs before others that mock `registry.js`.
import "../provider-send-message.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

const DUMMY_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
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
    async sendMessage(_messages: Message[], options?: SendMessageOptions) {
      onCall(options);
      const config = options?.config as Record<string, unknown> | undefined;
      return makeResponse(
        (config?.model as string | undefined) ?? "default-model",
      );
    },
  };
}

function setLlmConfig(raw: unknown): void {
  // Parse through the schema so defaults cascade through every nesting level,
  // matching what `getConfig().llm` would produce in production.
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
  mockProviders.clear();
});

// ── RetryProvider — call-site path ──────────────────────────────────────────

describe("RetryProvider — callSite resolution", () => {
  test("resolves provider/model/maxTokens from llm.callSites.<id>", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        memoryRetrieval: {
          model: "claude-haiku-4-5-20251001",
          maxTokens: 4096,
        },
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "memoryRetrieval" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("claude-haiku-4-5-20251001");
    expect(config.max_tokens).toBe(4096);
    // Both opt-in routing keys are stripped before delegating downstream.
    expect(config.callSite).toBeUndefined();
    expect(config.modelIntent).toBeUndefined();
  });

  test("attaches sanitized stable attribution headers only when enabled", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default",
      },
      profiles: {
        "conversation-profile": {
          model: "claude-profile",
          source: "user",
        },
      },
      callSites: {
        memoryRetrieval: {
          provider: "openai",
        },
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openai", (options) => {
        seen = options;
      }),
      { forwardUsageAttributionHeaders: true },
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: {
        callSite: "memoryRetrieval",
        overrideProfile: "conversation-profile",
      },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.usageAttributionHeaders).toEqual({
      "X-Vellum-LLM-Call-Site": "memoryRetrieval",
      "X-Vellum-Inference-Profile": "conversation-profile",
      "X-Vellum-Inference-Profile-Source": "conversation",
      "X-Vellum-Resolved-Provider": "openai",
      "X-Vellum-Resolved-Model": "claude-profile",
    });
    expect(
      (config.usageAttributionHeaders as Record<string, string>)[
        "X-Vellum-LLM-Call-Site-Label"
      ],
    ).toBeUndefined();
  });

  test("omits attribution headers by default for direct provider transports", async () => {
    setLlmConfig({
      default: {
        provider: "openai",
        model: "gpt-default",
      },
      callSites: {
        memoryRetrieval: {
          provider: "openai",
        },
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openai", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "memoryRetrieval" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.usageAttributionHeaders).toBeUndefined();
    expect(config.callSite).toBeUndefined();
  });

  test("omits profile source attribution header when no profile is applied", async () => {
    setLlmConfig({
      default: {
        provider: "openai",
        model: "gpt-default",
      },
      callSites: {
        memoryRetrieval: {
          provider: "openai",
        },
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openai", (options) => {
        seen = options;
      }),
      { forwardUsageAttributionHeaders: true },
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "memoryRetrieval" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.usageAttributionHeaders).toEqual({
      "X-Vellum-LLM-Call-Site": "memoryRetrieval",
      "X-Vellum-Resolved-Provider": "openai",
      "X-Vellum-Resolved-Model": "gpt-default",
    });
  });

  test("falls back to llm.default when llm.callSites[id] is absent", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default-fallback",
        maxTokens: 32000,
      },
      // No `callSites.memoryRetrieval` entry.
      // Disable the catalog default so resolution lands on llm.default.
      profiles: { "cost-optimized": { source: "managed", status: "disabled" } },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "memoryRetrieval" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("claude-default-fallback");
    expect(config.max_tokens).toBe(32000);
  });

  test("propagates resolved effort/speed/temperature; omits server-side fields", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        effort: "high",
        speed: "fast",
        temperature: 0.7,
      },
      callSites: {
        heartbeatAgent: {
          thinking: { enabled: false },
        },
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "heartbeatAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.effort).toBe("high");
    expect(config.speed).toBe("fast");
    expect(config.temperature).toBe(0.7);
    expect(config.thinking).toEqual({ type: "disabled" });
    // `contextWindow` and `provider` are server-side concerns and must NOT
    // leak into the per-call provider config — Anthropic rejects unknown
    // fields with `{type:"invalid_request_error", message:"contextWindow:
    // Extra inputs are not permitted"}`. Provider routing is handled by
    // CallSiteRoutingProvider; contextWindow is consumed by the agent loop
    // from the effective per-call-site/profile context resolver.
    expect(config.contextWindow).toBeUndefined();
    expect(config.provider).toBeUndefined();
  });

  test("converts resolved thinking config to Anthropic wire-format `{ type: 'adaptive' }` when enabled", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: {
        // Inherits `thinking.enabled: true` from default.
        mainAgent: {},
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    // Must be the Anthropic SDK's `ThinkingConfigAdaptive` shape, NOT the
    // schema-shape `{ enabled, streamThinking }`. The Anthropic client spreads
    // `restConfig` directly into `Anthropic.MessageStreamParams` and the SDK
    // only accepts the `{ type: ... }` discriminator.
    expect(config.thinking).toEqual({ type: "adaptive" });
  });

  test("converts disabled thinking to Anthropic wire-format `{ type: 'disabled' }`", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: false, streamThinking: false },
      },
      callSites: {
        mainAgent: {},
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "disabled" });
  });

  test("does NOT propagate temperature when resolved value is null (schema default)", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        // `temperature` defaults to null — "let provider pick".
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    // Must NOT be set — null would either trigger a wire error or override
    // sensible provider defaults. Mirrors the legacy non-callSite path which
    // never sets `temperature` on `providerConfig`.
    expect(config.temperature).toBeUndefined();
    expect("temperature" in config).toBe(false);
  });

  test("propagates temperature when explicitly set in resolved config", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        // Thinking defaults to enabled in the schema. Disable here so the
        // thinking/temperature conflict guard doesn't fire — that guard
        // (Anthropic 400 backstop) has dedicated coverage further down.
        thinking: { enabled: false },
      },
      callSites: {
        mainAgent: { temperature: 0.5 },
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.temperature).toBe(0.5);
  });

  test("forwards resolved topP to wire `top_p` (non-thinking provider)", async () => {
    // `topP` (schema, camelCase) renames to `top_p` on the wire, mirroring
    // `maxTokens`→`max_tokens`. Fireworks has no thinking constraint, so the
    // value passes straight through.
    setLlmConfig({
      default: {
        provider: "fireworks",
        model: "fireworks-model",
        topP: 0.95,
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("fireworks", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.top_p).toBe(0.95);
  });

  test("does NOT forward top_p when resolved topP is null (schema default)", async () => {
    setLlmConfig({
      default: {
        provider: "fireworks",
        model: "fireworks-model",
        // `topP` defaults to null — "let provider pick".
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("fireworks", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    // Must NOT be set — `top_p: null` would either be a wire error or override
    // sensible provider defaults, mirroring the `temperature` handling.
    expect(config.top_p).toBeUndefined();
    expect("top_p" in config).toBe(false);
  });

  test("strips unsupported speed and thinking fields for Fireworks", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        effort: "high",
        speed: "fast",
      },
      callSites: {
        memoryRetrieval: { thinking: { enabled: false } },
      },
    });

    let seen: SendMessageOptions | undefined;
    // Fireworks uses the OpenAI-compatible transport; speed and thinking stay
    // out of the downstream config.
    const wrapped = new RetryProvider(
      makeProvider("fireworks", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "memoryRetrieval" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.speed).toBeUndefined();
    expect(config.thinking).toBeUndefined();
    // Model still comes through.
    expect(config.model).toBe("claude-opus-4-7");
  });

  test("disabled thinking forces effort none before Fireworks strips thinking", async () => {
    setLlmConfig({
      default: {
        provider: "fireworks",
        model: "accounts/fireworks/models/glm-5p2",
        effort: "high",
        thinking: { enabled: false, streamThinking: false },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("fireworks", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toBeUndefined();
    expect(config.effort).toBe("none");
  });

  test("disabled thinking forces effort none for OpenRouter and keeps the wire thinking config", async () => {
    setLlmConfig({
      default: {
        provider: "openrouter",
        model: "x-ai/grok-4",
        effort: "high",
        thinking: { enabled: false, streamThinking: false },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openrouter", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.effort).toBe("none");
    // OpenRouter is thinking-aware: the wire-shape config still flows down so
    // the client can decide its nested `reasoning` emission.
    expect(config.thinking).toEqual({ type: "disabled" });
  });

  test("disabled thinking forces effort none for the Vercel AI Gateway", async () => {
    setLlmConfig({
      default: {
        provider: "vercel-ai-gateway",
        model: "xai/grok-4",
        effort: "max",
        thinking: { enabled: false, streamThinking: false },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("vercel-ai-gateway", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.effort).toBe("none");
    expect(config.thinking).toEqual({ type: "disabled" });
  });

  test("disabled thinking keeps effort for gateway-delegated anthropic/* models", async () => {
    setLlmConfig({
      default: {
        provider: "openrouter",
        model: "anthropic/claude-opus-4-8",
        effort: "high",
        thinking: { enabled: false, streamThinking: false },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openrouter", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    // The Anthropic Messages delegate honors a disabled `thinking` natively;
    // `effort` keeps its Anthropic meaning and must match the direct
    // `anthropic` provider's behavior.
    const config = seen?.config as Record<string, unknown>;
    expect(config.effort).toBe("high");
    expect(config.thinking).toEqual({ type: "disabled" });
  });

  test("preserves thinking + level for Gemini provider", async () => {
    setLlmConfig({
      default: {
        provider: "gemini",
        model: "gemini-3.5-flash",
        thinking: { enabled: true, streamThinking: true, level: "high" },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("gemini", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({
      type: "adaptive",
      level: "high",
      streamThinking: true,
    });
  });

  test("Gemini disabled thinking carries the wire `disabled` discriminator", async () => {
    setLlmConfig({
      default: {
        provider: "gemini",
        model: "gemini-3.5-flash",
        thinking: { enabled: false, streamThinking: false },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("gemini", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "disabled" });
  });

  test("scrubs Gemini-only thinking extras (level, streamThinking) for Anthropic", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true, level: "high" },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    // Anthropic's SDK rejects unknown keys inside the `thinking` object with
    // "Extra inputs are not permitted" — must be exactly `{ type }`.
    expect(config.thinking).toEqual({ type: "adaptive" });
  });

  test("explicit per-call config.model wins over resolved callSite model", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "resolved-model" },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", model: "explicit-override" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("explicit-override");
  });
});

// ── RetryProvider — Anthropic thinking + temperature conflict guard ─────────
//
// Anthropic 400s with "temperature may only be set to 1 when thinking is
// enabled or in adaptive mode" if a request combines extended thinking with
// `temperature` ≠ 1. We had three call sites ship with hardcoded
// per-call temperatures that exploded for Opus 4.x effort=high/xhigh
// profiles (PR #29560 fixed the call sites). This guard is a backstop: if a
// future call site reintroduces the same pattern, retry.ts drops the
// offending temperature instead of letting the request fail at the wire.

describe("RetryProvider — thinking/temperature conflict guard", () => {
  test("drops explicit non-1 temperature when thinking is enabled (Anthropic)", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      // Hardcoded per-call temperature — the pattern that caused the PR
      // #29560 bug class. Without the guard this would forward to Anthropic
      // and 400.
      config: { callSite: "mainAgent", temperature: 0.7 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "adaptive" });
    expect(config.temperature).toBeUndefined();
    expect("temperature" in config).toBe(false);
  });

  test("drops explicit temperature: 0 when thinking is enabled (Anthropic)", async () => {
    // Mirrors the recall-agent / retriever shape: `temperature: 0` for
    // determinism on a thinking-enabled profile. Same 400 risk, same fix.
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { recall: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "recall", temperature: 0 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "adaptive" });
    expect(config.temperature).toBeUndefined();
  });

  test("preserves temperature: 1 when thinking is enabled (Anthropic accepts it)", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", temperature: 1 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "adaptive" });
    expect(config.temperature).toBe(1);
  });

  test("preserves explicit temperature when thinking is disabled (Anthropic)", async () => {
    // The bug class only exists when thinking resolves enabled. With
    // thinking disabled, every temperature value is valid — the guard must
    // not fire.
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: false, streamThinking: false },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", temperature: 0.7 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "disabled" });
    expect(config.temperature).toBe(0.7);
  });

  test("drops temperature for OpenRouter when fronting an `anthropic/*` model", async () => {
    setLlmConfig({
      default: {
        provider: "openrouter",
        model: "anthropic/claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openrouter", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", temperature: 0.7 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("anthropic/claude-opus-4-7");
    expect(config.temperature).toBeUndefined();
  });

  test("preserves temperature for OpenRouter when fronting a non-Anthropic reasoning model", async () => {
    // OpenRouter's other reasoning models (xAI Grok, etc.) translate
    // `thinking` into the `reasoning` parameter via `buildExtraCreateParams`
    // and don't share Anthropic's temperature-must-be-1 constraint. The
    // guard must not over-reach.
    setLlmConfig({
      default: {
        provider: "openrouter",
        model: "x-ai/grok-4",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openrouter", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", temperature: 0.7 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("x-ai/grok-4");
    expect(config.temperature).toBe(0.7);
  });

  test("drops temperature for Vercel AI Gateway when fronting an `anthropic/*` model", async () => {
    setLlmConfig({
      default: {
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.6",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("vercel-ai-gateway", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", temperature: 0.7 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("anthropic/claude-opus-4.6");
    expect(config.temperature).toBeUndefined();
  });

  test("preserves temperature for Vercel AI Gateway when fronting a non-Anthropic model", async () => {
    setLlmConfig({
      default: {
        provider: "vercel-ai-gateway",
        model: "xai/grok-4.3",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("vercel-ai-gateway", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", temperature: 0.7 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("xai/grok-4.3");
    expect(config.temperature).toBe(0.7);
  });

  test("guard does not fire when thinking has already been stripped by forced tool_choice", async () => {
    // `retry.ts` strips `thinking` when forced `tool_choice: { type: "tool" }`
    // is set on Anthropic — the guard runs after that step, so by the time
    // we check, `thinking` is gone and the temperature can stay.
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
      },
      callSites: { trustRuleSuggestion: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: {
        callSite: "trustRuleSuggestion",
        temperature: 0.7,
        tool_choice: { type: "tool", name: "suggest_trust_rule" },
      },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toBeUndefined();
    expect(config.temperature).toBe(0.7);
  });
});

// ── RetryProvider — Anthropic thinking + top_p conflict guard ───────────────
//
// Anthropic rejects *any* `top_p` modification when extended thinking is
// enabled (same constraint family as `temperature` ≠ 1, but with no
// "=== 1 is fine" exception). This guard drops the offending `top_p` so the
// request goes through with Anthropic's default instead of 400ing at the wire.

describe("RetryProvider — thinking/top_p conflict guard", () => {
  test("drops top_p when thinking is enabled (Anthropic)", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
        topP: 0.95,
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "adaptive" });
    expect(config.top_p).toBeUndefined();
    expect("top_p" in config).toBe(false);
  });

  test("drops top_p for OpenRouter when fronting an `anthropic/*` model", async () => {
    setLlmConfig({
      default: {
        provider: "openrouter",
        model: "anthropic/claude-opus-4-7",
        thinking: { enabled: true, streamThinking: true },
        topP: 0.9,
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openrouter", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("anthropic/claude-opus-4-7");
    expect(config.top_p).toBeUndefined();
  });

  test("drops top_p for Vercel AI Gateway when fronting an `anthropic/*` model", async () => {
    setLlmConfig({
      default: {
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.6",
        thinking: { enabled: true, streamThinking: true },
        topP: 0.9,
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("vercel-ai-gateway", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("anthropic/claude-opus-4.6");
    expect(config.top_p).toBeUndefined();
  });

  test("preserves top_p for Vercel AI Gateway when fronting a non-Anthropic model", async () => {
    setLlmConfig({
      default: {
        provider: "vercel-ai-gateway",
        model: "xai/grok-4.3",
        thinking: { enabled: true, streamThinking: true },
        topP: 0.9,
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("vercel-ai-gateway", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("xai/grok-4.3");
    expect(config.top_p).toBe(0.9);
  });

  test("preserves top_p when thinking is enabled on a non-Anthropic provider (fireworks)", async () => {
    // Fireworks (and other non-Anthropic providers) don't share Anthropic's
    // top_p-with-thinking constraint — the guard must not over-reach. Note
    // that fireworks strips `thinking` itself, but `top_p` stays.
    setLlmConfig({
      default: {
        provider: "fireworks",
        model: "fireworks-model",
        thinking: { enabled: true, streamThinking: true },
        topP: 0.95,
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("fireworks", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.top_p).toBe(0.95);
  });

  test("preserves top_p when thinking is disabled (Anthropic)", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        thinking: { enabled: false, streamThinking: false },
        topP: 0.95,
      },
      callSites: { mainAgent: {} },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "disabled" });
    expect(config.top_p).toBe(0.95);
  });
});

// ── RetryProvider — pre-resolved model fast-path ────────────────────────────

describe("RetryProvider — no callSite (pre-resolved config passes through)", () => {
  test("config without callSite is forwarded untouched (no llm.* lookup)", async () => {
    // Seed the llm config with a value that, if accidentally consulted,
    // would clobber the explicit model. The pre-resolved fast-path must
    // ignore it entirely.
    setLlmConfig({
      default: { provider: "anthropic", model: "MUST-NOT-LEAK" },
      callSites: {
        mainAgent: { model: "ALSO-MUST-NOT-LEAK" },
      },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { model: "explicit-model", max_tokens: 1234 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("explicit-model");
    expect(config.max_tokens).toBe(1234);
    expect(config.model).not.toBe("MUST-NOT-LEAK");
    expect(config.model).not.toBe("ALSO-MUST-NOT-LEAK");
  });

  test("does not forward caller-supplied attribution headers without callSite", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "MUST-NOT-LEAK" },
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: {
        model: "explicit-model",
        usageAttributionHeaders: {
          "X-Vellum-LLM-Call-Site": "injected",
        },
      },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("explicit-model");
    expect(config.usageAttributionHeaders).toBeUndefined();
  });
});

// `getConfiguredProvider` — call-site routing coverage lives in
// `dispatch-connection-routing.test.ts`, where the connection lookup is
// fully mocked. Keeping those tests here would require mocking
// `inference/connections.js` and `persistence/db-connection.js` at the file
// level, and bun's `mock.module` leaks across files in a single suite
// run — that pollutes `inference.test.ts` (which exercises the real
// SQLite-backed `getConnection`).

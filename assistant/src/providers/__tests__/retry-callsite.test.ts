import { beforeEach, describe, expect, mock, test } from "bun:test";

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
    if (!p) throw new Error(`unknown provider: ${name}`);
    return p;
  },
  initializeProviders: async () => {},
  listProviders: () => Array.from(mockProviders.values()),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { LLMSchema } from "../../config/schemas/llm.js";
import { getConfiguredProvider } from "../provider-send-message.js";
import { RetryProvider } from "../retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

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
    async sendMessage(_messages, _tools, _systemPrompt, options) {
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

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "memoryRetrieval" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("claude-haiku-4-5-20251001");
    expect(config.max_tokens).toBe(4096);
    // Both opt-in routing keys are stripped before delegating downstream.
    expect(config.callSite).toBeUndefined();
    expect(config.modelIntent).toBeUndefined();
  });

  test("falls back to llm.default when llm.callSites[id] is absent", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-default-fallback",
        maxTokens: 32000,
      },
      // No `callSites.memoryRetrieval` entry.
    });

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
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

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "heartbeatAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.effort).toBe("high");
    expect(config.speed).toBe("fast");
    expect(config.temperature).toBe(0.7);
    // Disabled thinking is omitted entirely so providers fall back to their
    // default behavior — matches the legacy non-callSite path which only sets
    // `providerConfig.thinking` when `enabled === true`.
    expect(config.thinking).toBeUndefined();
    // `contextWindow` and `provider` are server-side concerns and must NOT
    // leak into the per-call provider config — Anthropic rejects unknown
    // fields with `{type:"invalid_request_error", message:"contextWindow:
    // Extra inputs are not permitted"}`. Provider routing is handled by
    // CallSiteRoutingProvider; contextWindow is consumed by the agent loop
    // directly from `config.llm.default.contextWindow.*`.
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

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    // Must be the Anthropic SDK's `ThinkingConfigAdaptive` shape, NOT the
    // schema-shape `{ enabled, streamThinking }`. The Anthropic client spreads
    // `restConfig` directly into `Anthropic.MessageStreamParams` and the SDK
    // only accepts the `{ type: ... }` discriminator.
    expect(config.thinking).toEqual({ type: "adaptive" });
  });

  test("omits thinking when resolved config has thinking.enabled: false", async () => {
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

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.thinking).toBeUndefined();
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

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
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
      default: { provider: "anthropic", model: "claude-opus-4-7" },
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

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "mainAgent" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.temperature).toBe(0.5);
  });

  test("strips effort/speed/thinking for providers that don't support them", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        effort: "high",
        speed: "fast",
      },
      callSites: {
        memoryRetrieval: { thinking: { enabled: true } },
      },
    });

    let seen: SendMessageOptions | undefined;
    // gemini does not support effort/speed/thinking — they must be stripped.
    const wrapped = new RetryProvider(
      makeProvider("gemini", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "memoryRetrieval" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.effort).toBeUndefined();
    expect(config.speed).toBeUndefined();
    expect(config.thinking).toBeUndefined();
    // Model still comes through.
    expect(config.model).toBe("claude-opus-4-7");
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

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { callSite: "mainAgent", model: "explicit-override" },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("explicit-override");
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

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { model: "explicit-model", max_tokens: 1234 },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("explicit-model");
    expect(config.max_tokens).toBe(1234);
    expect(config.model).not.toBe("MUST-NOT-LEAK");
    expect(config.model).not.toBe("ALSO-MUST-NOT-LEAK");
  });
});

// ── getConfiguredProvider — call-site routing ──────────────────────────────

describe("getConfiguredProvider — callSite routing", () => {
  test("selects provider from llm.callSites[id].provider when callSite given", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        heartbeatAgent: { provider: "openai", model: "gpt-5.4" },
      },
    });
    mockProviders.set("openai", { name: "openai" });
    mockProviders.set("anthropic", { name: "anthropic" });

    const provider = await getConfiguredProvider("heartbeatAgent");
    expect(provider?.name).toBe("openai");
  });

  test("falls back to llm.default.provider when callSite has no provider override", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        // No provider field — default takes over.
        heartbeatAgent: { model: "claude-haiku-4-5-20251001" },
      },
    });
    mockProviders.set("anthropic", { name: "anthropic" });

    const provider = await getConfiguredProvider("heartbeatAgent");
    expect(provider?.name).toBe("anthropic");
  });
});

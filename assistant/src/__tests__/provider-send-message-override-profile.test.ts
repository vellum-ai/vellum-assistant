/**
 * Verifies that `config.overrideProfile` on `SendMessageOptions` plumbs an
 * ad-hoc profile through both the `RetryProvider` normalization step (which
 * resolves model/maxTokens/effort/etc.) and the `CallSiteRoutingProvider`
 * provider-selection step.
 *
 * The end-to-end contract: a caller setting
 * `config.overrideProfile = "fast"` on a single send must see the request
 * land on the profile's provider with the profile's model — without
 * modifying the workspace's `activeProfile` or any call-site entry. This
 * makes per-conversation pinned profiles (PR 6+) work.
 */

import { beforeEach, describe, expect, test } from "bun:test";

// These suites exercise override-profile PLUMBING through legacy-shaped
// fixtures (llm.default-centric, no defaultProvider). Pinned to the
// flag-off cascade; override-or-default resolution semantics are pinned by
// llm-resolver-override-or-default.test.ts and the inference-profile loop
// suite.
import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import { CallSiteConfiguredProvider } from "../providers/provider-send-message.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { setConfig } from "./helpers/set-config.js";

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

// Seed `llm` into the real workspace config; the loader schema-merges the
// raw partial over defaults exactly as `LLMSchema.parse` did for the mock.
function setLlmConfig(raw: unknown): void {
  setConfig("llm", raw);
}

beforeEach(() => {
  setLlmConfig({});
});

describe("SendMessageOptions.config.overrideProfile", () => {
  test("CallSiteConfiguredProvider injects the resolving call site when callers omit it", async () => {
    let captured: SendMessageOptions | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options;
        return makeResponse("anthropic");
      },
    };

    const provider = new CallSiteConfiguredProvider(inner, "mainAgent");
    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { model: "claude-opus-4-7" },
    });

    expect(captured?.config).toMatchObject({
      callSite: "mainAgent",
      model: "claude-opus-4-7",
    });
  });

  test("CallSiteConfiguredProvider preserves explicit per-call call sites", async () => {
    let captured: SendMessageOptions | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options;
        return makeResponse("anthropic");
      },
    };

    const provider = new CallSiteConfiguredProvider(inner, "mainAgent");
    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "conversationTitle" },
    });

    expect(captured?.config?.callSite).toBe("conversationTitle");
  });

  test("RetryProvider resolves model from named profile when overrideProfile is set", async () => {
    setLlmConfig({
      profiles: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    });

    let captured: Record<string, unknown> | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options?.config as Record<string, unknown> | undefined;
        return makeResponse("anthropic");
      },
    };

    const provider = new RetryProvider(inner);
    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", overrideProfile: "fast" },
    });

    // The override profile wins resolution, so its model is what lands on
    // the wire config.
    expect(captured?.model).toBe("claude-haiku-4-5-20251001");
    // `overrideProfile` is a routing key — it must not leak to the provider.
    expect(captured?.overrideProfile).toBeUndefined();
    // `callSite` is also stripped post-resolve.
    expect(captured?.callSite).toBeUndefined();
  });

  test("CallSiteRoutingProvider switches transport when overrideProfile changes the provider (via provider_connection)", async () => {
    setLlmConfig({
      profiles: {
        fast: {
          provider: "openai",
          provider_connection: "openai-conn",
          model: "gpt-5.4",
        },
      },
    });

    const calls = { default: 0, alt: 0 };
    const defaultProvider: Provider = {
      name: "anthropic",
      async sendMessage() {
        calls.default++;
        return makeResponse("anthropic");
      },
    };
    const altProvider: Provider = {
      name: "openai",
      async sendMessage() {
        calls.alt++;
        return makeResponse("openai");
      },
    };

    const wrapped = new CallSiteRoutingProvider(
      defaultProvider,
      async (connectionName) =>
        connectionName === "openai-conn" ? altProvider : null,
    );

    const response = await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", overrideProfile: "fast" },
    });

    expect(calls.default).toBe(0);
    expect(calls.alt).toBe(1);
    expect(response.model).toBe("openai");
  });

  test("missing overrideProfile name silently falls through to base resolution", async () => {
    setLlmConfig({
      // The call-site tweak applies last in resolution, so it pins the model
      // base resolution lands on when the override name doesn't resolve.
      callSites: {
        mainAgent: { provider: "anthropic", model: "claude-opus-4-7" },
      },
      profiles: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    });

    let captured: Record<string, unknown> | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options?.config as Record<string, unknown> | undefined;
        return makeResponse("anthropic");
      },
    };

    const provider = new RetryProvider(inner);
    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent", overrideProfile: "does-not-exist" },
    });

    // Falls through to base resolution (call-site tweak applied over the
    // default winner) since the named profile isn't found.
    expect(captured?.model).toBe("claude-opus-4-7");
  });

  test("absent overrideProfile leaves prior resolution behavior intact", async () => {
    setLlmConfig({
      callSites: {
        mainAgent: { provider: "anthropic", model: "claude-opus-4-7" },
      },
      profiles: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    });

    let captured: Record<string, unknown> | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options?.config as Record<string, unknown> | undefined;
        return makeResponse("anthropic");
      },
    };

    const provider = new RetryProvider(inner);
    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(captured?.model).toBe("claude-opus-4-7");
  });

  test("overrideProfile is stripped even when callSite is absent", async () => {
    let captured: Record<string, unknown> | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options?.config as Record<string, unknown> | undefined;
        return makeResponse("anthropic");
      },
    };

    const provider = new RetryProvider(inner);
    await provider.sendMessage(DUMMY_MESSAGES, {
      config: { overrideProfile: "fast" },
    });

    // `overrideProfile` must never leak as a wire-format field, even when no
    // callSite is set (the resolver never runs, but the leak guard still
    // applies).
    expect(captured?.overrideProfile).toBeUndefined();
  });
});

describe("SendMessageOptions.config.forceOverrideProfile", () => {
  test("CallSiteConfiguredProvider forwards forceOverrideProfile into the send config", async () => {
    let captured: SendMessageOptions | undefined;
    const inner: Provider = {
      name: "anthropic",
      async sendMessage(
        _messages: Message[],
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        captured = options;
        return makeResponse("anthropic");
      },
    };

    const provider = new CallSiteConfiguredProvider(
      inner,
      "inference",
      "strong",
      true,
    );
    await provider.sendMessage(DUMMY_MESSAGES, {});

    expect(captured?.config).toMatchObject({
      callSite: "inference",
      overrideProfile: "strong",
      forceOverrideProfile: true,
    });
  });

  test("the override profile outranks a call-site profile pin, forced or not", async () => {
    // The advisor scenario in miniature: the `inference` call site is pinned
    // to a cheap profile, but a caller supplies a stronger profile for its
    // own send. Under single-winner resolution the override sits at the top
    // of the selection chain for every call site, so it wins with or without
    // `forceOverrideProfile` (the flag is a no-op kept for API compat).
    setLlmConfig({
      profiles: {
        cheap: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        strong: { provider: "anthropic", model: "claude-opus-4-8" },
      },
      callSites: { inference: { profile: "cheap" } },
    });

    const send = async (force: boolean) => {
      let captured: Record<string, unknown> | undefined;
      const inner: Provider = {
        name: "anthropic",
        async sendMessage(
          _messages: Message[],
          options?: SendMessageOptions,
        ): Promise<ProviderResponse> {
          captured = options?.config as Record<string, unknown> | undefined;
          return makeResponse("anthropic");
        },
      };
      const provider = new RetryProvider(inner);
      await provider.sendMessage(DUMMY_MESSAGES, {
        config: {
          callSite: "inference",
          overrideProfile: "strong",
          ...(force ? { forceOverrideProfile: true } : {}),
        },
      });
      return captured;
    };

    // Without the flag, the override (`strong`) already wins over the
    // call-site pin (`cheap`).
    expect((await send(false))?.model).toBe("claude-opus-4-8");

    // With the flag, the result is identical — forcing changes nothing.
    const forced = await send(true);
    expect(forced?.model).toBe("claude-opus-4-8");
    // The routing keys are stripped before the provider wire request.
    expect(forced?.overrideProfile).toBeUndefined();
    expect(forced?.forceOverrideProfile).toBeUndefined();
  });
});

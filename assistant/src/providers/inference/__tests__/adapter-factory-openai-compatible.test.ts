import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../../openai/chat-completions-provider.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../adapter-factory.js";
import type { ProviderConnection, ResolvedAuth } from "../auth.js";

interface RetryOptions {
  credentialSource?: string;
  connectionName?: string;
  refreshCredentialProvider?: () => Promise<unknown>;
}

/**
 * Read the `RetryProvider` options the factory stamped. Walks the `inner`
 * chain rather than assuming a fixed wrapper nesting, so reordering the
 * wrappers fails a behavior assertion instead of this accessor.
 */
function retryOptions(adapter: unknown): RetryOptions {
  let node = adapter;
  for (let depth = 0; node && depth < 8; depth++) {
    const { options, inner } = node as {
      options?: RetryOptions;
      inner?: unknown;
    };
    if (options) {
      return options;
    }
    node = inner;
  }
  throw new Error("no RetryProvider found in the adapter wrapper chain");
}

describe("adapter factory", () => {
  test("buildProviderAdapter returns an OpenAIChatCompletionsProvider", () => {
    const adapter = buildProviderAdapter("openai-compatible", {
      apiKey: "test-key",
      model: "my-local-model",
      streamTimeoutMs: 60_000,
      baseURL: "http://localhost:8080/v1",
      useNativeWebSearch: false,
    });
    expect(adapter).toBeInstanceOf(OpenAIChatCompletionsProvider);
  });

  test("createAdapterFromConnection wires baseURL from ResolvedAuth", () => {
    const connection: ProviderConnection = {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      label: "vLLM",
      baseUrl: "http://localhost:8080/v1",
      models: [{ id: "my-model" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const resolvedAuth: ResolvedAuth = {
      kind: "header",
      headers: { Authorization: "Bearer sk-test" },
      baseUrl: "http://localhost:8080/v1",
    };

    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "my-model",
      streamTimeoutMs: 60_000,
    });

    expect(adapter).not.toBeNull();
  });

  test("createAdapterFromConnection supports keyless openai-compatible with baseUrl", () => {
    const connection: ProviderConnection = {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "none" },
      label: null,
      baseUrl: "http://localhost:8080/v1",
      models: [{ id: "my-model" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    // Keyless local endpoints (LM Studio, vLLM) dispatch with none auth;
    // the baseUrl travels on the resolved auth.
    const resolvedAuth: ResolvedAuth = {
      kind: "none",
      baseUrl: "http://localhost:8080/v1",
    };

    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "my-model",
    });

    expect(adapter).not.toBeNull();
    expect(retryOptions(adapter)).toMatchObject({
      credentialSource: "no-auth",
      connectionName: "my-vllm",
    });
  });

  test("createAdapterFromConnection still rejects 'none' auth for keyed catalog providers", () => {
    const connection: ProviderConnection = {
      name: "my-anthropic",
      provider: "anthropic",
      auth: { type: "none" },
      label: null,
      baseUrl: null,
      models: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const adapter = createAdapterFromConnection(
      connection,
      { kind: "none" },
      { model: "claude-opus-4-8" },
    );

    expect(adapter).toBeNull();
  });

  test("attributes OAuth subscription credentials separately from API keys", () => {
    const connection: ProviderConnection = {
      name: "chatgpt-subscription",
      provider: "openai",
      auth: {
        type: "oauth_subscription",
        credential: "chatgpt-subscription-oauth",
      },
      label: "ChatGPT",
      baseUrl: null,
      models: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const adapter = createAdapterFromConnection(
      connection,
      {
        kind: "header",
        headers: { Authorization: "Bearer test-token" },
      },
      { model: "gpt-5.4" },
    );

    expect(adapter).not.toBeNull();
    expect(retryOptions(adapter)).toMatchObject({
      credentialSource: "oauth-subscription",
      connectionName: "chatgpt-subscription",
    });
  });

  test("wires managed connections to reload rotated assistant credentials", () => {
    const connection: ProviderConnection = {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
      label: "Vellum",
      baseUrl: null,
      models: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: true,
    };

    const adapter = createAdapterFromConnection(
      connection,
      {
        kind: "header",
        headers: { Authorization: "Bearer managed-key" },
        baseUrl: "https://example.com/runtime-proxy/anthropic",
      },
      { model: "claude-opus-4-8", provider: "anthropic" },
    );

    expect(adapter).not.toBeNull();
    const options = retryOptions(adapter);
    expect(options).toMatchObject({
      credentialSource: "vellum-managed",
      connectionName: "vellum",
    });
    expect(typeof options.refreshCredentialProvider).toBe("function");
  });

  test("credential refresh declines when it cannot re-read a changed key", async () => {
    const connection: ProviderConnection = {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
      label: "Vellum",
      baseUrl: null,
      models: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: true,
    };

    const adapter = createAdapterFromConnection(
      connection,
      {
        kind: "header",
        headers: { Authorization: "Bearer managed-key" },
        baseUrl: "https://example.com/runtime-proxy/anthropic",
      },
      { model: "claude-opus-4-8", provider: "anthropic" },
    );

    // Guards the doubled-upstream-call regression: a refresh that cannot
    // produce a credential different from the one that just failed must
    // hand back nothing, so the retry loop surfaces the auth error instead
    // of replaying the request against an identical key.
    const refresh = retryOptions(adapter).refreshCredentialProvider;
    expect(await refresh?.()).toBeNull();
    expect(await refresh?.()).toBeNull();
  });
});

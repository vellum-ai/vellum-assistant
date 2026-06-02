import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../../openai/chat-completions-provider.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../adapter-factory.js";
import type { ProviderConnection, ResolvedAuth } from "../auth.js";

describe("openai-compatible adapter factory", () => {
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

  test("createAdapterFromConnection allows keyless 'none' auth for openai-compatible", () => {
    const connection: ProviderConnection = {
      name: "my-lmstudio",
      provider: "openai-compatible",
      auth: { type: "none" },
      label: null,
      baseUrl: "http://localhost:1234/v1",
      models: [{ id: "my-model" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const resolvedAuth: ResolvedAuth = { kind: "none" };

    // Keyless local endpoints (LM Studio, etc.) need no key — the factory must
    // build an adapter without throwing despite the empty credential.
    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "my-model",
    });

    expect(adapter).not.toBeNull();
  });

  test("createAdapterFromConnection rejects 'none' auth for a keyed non-openai-compatible provider", () => {
    const connection: ProviderConnection = {
      name: "my-anthropic",
      provider: "anthropic",
      auth: { type: "none" },
      label: null,
      baseUrl: null,
      models: [{ id: "claude-sonnet" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const resolvedAuth: ResolvedAuth = { kind: "none" };

    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "claude-sonnet",
    });

    // anthropic is setupMode: "api-key" and not openai-compatible, so the
    // relaxed keyless guard must NOT apply — none auth stays rejected.
    expect(adapter).toBeNull();
  });
});

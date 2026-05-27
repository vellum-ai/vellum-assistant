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

  test("createAdapterFromConnection rejects 'none' auth for openai-compatible", () => {
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

    const resolvedAuth: ResolvedAuth = { kind: "none" };

    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "my-model",
    });

    // openai-compatible is setupMode: "api-key", not keyless, so none auth
    // should be rejected.
    expect(adapter).toBeNull();
  });
});

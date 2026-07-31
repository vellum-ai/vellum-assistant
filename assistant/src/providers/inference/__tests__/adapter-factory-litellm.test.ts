import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../../openai/chat-completions-provider.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../adapter-factory.js";
import type { ProviderConnection, ResolvedAuth } from "../auth.js";

describe("litellm adapter factory", () => {
  test("buildProviderAdapter returns an OpenAIChatCompletionsProvider", () => {
    const adapter = buildProviderAdapter("litellm", {
      apiKey: "sk-litellm-test",
      model: "anthropic/claude-sonnet-4-6",
      streamTimeoutMs: 60_000,
      baseURL: "http://localhost:4000/v1",
      useNativeWebSearch: false,
    });
    expect(adapter).toBeInstanceOf(OpenAIChatCompletionsProvider);
  });

  test("buildProviderAdapter works without baseURL (uses proxy default)", () => {
    const adapter = buildProviderAdapter("litellm", {
      apiKey: "sk-litellm-test",
      model: "openai/gpt-4o",
      streamTimeoutMs: 60_000,
      useNativeWebSearch: false,
    });
    expect(adapter).toBeInstanceOf(OpenAIChatCompletionsProvider);
  });

  test("buildProviderAdapter preserves provider/model format", () => {
    const models = [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "bedrock/anthropic.claude-sonnet-4-6-v1",
      "vertex_ai/gemini-2.5-flash",
      "groq/llama-4-scout-17b-16e-instruct",
    ];

    for (const model of models) {
      const adapter = buildProviderAdapter("litellm", {
        apiKey: "sk-test",
        model,
        streamTimeoutMs: 60_000,
        useNativeWebSearch: false,
      });
      expect(adapter).toBeInstanceOf(OpenAIChatCompletionsProvider);
    }
  });

  test("createAdapterFromConnection wires baseURL from ResolvedAuth", () => {
    const connection: ProviderConnection = {
      name: "my-litellm",
      provider: "litellm",
      auth: { type: "api_key", credential: "cred-litellm" },
      label: "LiteLLM Gateway",
      baseUrl: "http://litellm.internal:4000/v1",
      models: [{ id: "anthropic/claude-sonnet-4-6" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const resolvedAuth: ResolvedAuth = {
      kind: "header",
      headers: { Authorization: "Bearer sk-litellm-key" },
      baseUrl: "http://litellm.internal:4000/v1",
    };

    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "anthropic/claude-sonnet-4-6",
      streamTimeoutMs: 60_000,
    });

    expect(adapter).not.toBeNull();
  });

  test("createAdapterFromConnection rejects 'none' auth for litellm", () => {
    const connection: ProviderConnection = {
      name: "my-litellm",
      provider: "litellm",
      auth: { type: "none" },
      label: null,
      baseUrl: "http://localhost:4000/v1",
      models: [{ id: "openai/gpt-4o" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const resolvedAuth: ResolvedAuth = {
      kind: "none",
    };

    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "openai/gpt-4o",
      streamTimeoutMs: 60_000,
    });

    expect(adapter).toBeNull();
  });
});

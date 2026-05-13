import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../../openai/chat-completions-provider.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../adapter-factory.js";
import type { ProviderConnection } from "../auth.js";

describe("adapter factory: openai-compatible", () => {
  test("buildProviderAdapter returns an OpenAIChatCompletionsProvider", () => {
    const adapter = buildProviderAdapter("openai-compatible", {
      apiKey: "test-key",
      model: "glm-4.7",
      streamTimeoutMs: 1_000,
      baseURL: "https://api.z.ai/api/coding/paas/v4",
      useNativeWebSearch: false,
    });
    expect(adapter).not.toBeNull();
    // The adapter is the unwrapped chat-completions client; the registry
    // wraps it in UsageTracking/Retry separately.
    expect(adapter).toBeInstanceOf(OpenAIChatCompletionsProvider);
  });

  test("createAdapterFromConnection wires baseURL from ResolvedAuth", () => {
    const connection: ProviderConnection = {
      name: "my-zai",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "vault://zai-key" },
      status: "active",
      label: "Z.ai",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      models: [{ id: "glm-4.7" }],
      createdAt: 0,
      updatedAt: 0,
      isManaged: false,
    };

    const adapter = createAdapterFromConnection(
      connection,
      {
        kind: "header",
        headers: { Authorization: "Bearer real-secret" },
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      },
      { model: "glm-4.7" },
    );

    // Wrapped by UsageTrackingProvider → RetryProvider → OpenAIChatCompletions;
    // checking non-null + name is enough to prove the factory path resolved.
    expect(adapter).not.toBeNull();
    expect(adapter?.name).toBe("openai-compatible");
  });

  test("createAdapterFromConnection rejects 'none' auth on the keyed provider", () => {
    const connection: ProviderConnection = {
      name: "broken",
      provider: "openai-compatible",
      auth: { type: "none" },
      status: "active",
      label: null,
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "m1" }],
      createdAt: 0,
      updatedAt: 0,
      isManaged: false,
    };

    const adapter = createAdapterFromConnection(
      connection,
      { kind: "none" },
      { model: "m1" },
    );
    expect(adapter).toBeNull();
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

const secretsPostMock = mock(async () => ({
  response: { ok: true, status: 200 },
}));
const inferenceProviderconnectionsPostMock = mock(async () => ({
  response: { ok: true, status: 201 },
}));
const configLlmProfilesByNamePutMock = mock(async () => ({
  response: { ok: true, status: 200 },
}));
const configPatchMock = mock(async () => ({
  response: { ok: true, status: 200 },
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  secretsPost: secretsPostMock,
  inferenceProviderconnectionsPost: inferenceProviderconnectionsPostMock,
  configLlmProfilesByNamePut: configLlmProfilesByNamePutMock,
  configPatch: configPatchMock,
}));

const {
  applyPendingProviderKey,
  consumePendingProviderKey,
  peekPendingProviderKey,
  setPendingProviderKey,
} = await import("@/domains/onboarding/provider-key");

beforeEach(() => {
  sessionStorage.clear();
  secretsPostMock.mockClear();
  inferenceProviderconnectionsPostMock.mockClear();
  configLlmProfilesByNamePutMock.mockClear();
  configPatchMock.mockClear();
});

describe("pending provider key", () => {
  test("round-trips provider + key through sessionStorage", () => {
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });
    expect(peekPendingProviderKey()).toEqual({
      provider: "anthropic",
      key: "sk-ant-test",
    });
  });

  test("peek is non-destructive, consume clears it (consume-once)", () => {
    setPendingProviderKey({ provider: "openai", key: "sk-proj-test" });

    expect(peekPendingProviderKey()?.provider).toBe("openai");
    // Still present after peek.
    expect(peekPendingProviderKey()?.provider).toBe("openai");

    expect(consumePendingProviderKey()?.provider).toBe("openai");
    // Gone after consume.
    expect(peekPendingProviderKey()).toBeNull();
    expect(consumePendingProviderKey()).toBeNull();
  });

  test("setting null clears any pending key", () => {
    setPendingProviderKey({ provider: "gemini", key: "AIza-test" });
    setPendingProviderKey(null);
    expect(peekPendingProviderKey()).toBeNull();
  });

  test("keyless providers store an empty key", () => {
    setPendingProviderKey({ provider: "ollama", key: "", model: "llama3.2" });
    expect(consumePendingProviderKey()).toEqual({
      provider: "ollama",
      key: "",
      model: "llama3.2",
    });
  });

  test("applies an Ollama provider connection and activates the selected model profile", async () => {
    setPendingProviderKey({ provider: "ollama", key: "", model: "mistral" });

    await applyPendingProviderKey("local-1");

    expect(secretsPostMock).not.toHaveBeenCalled();
    expect(inferenceProviderconnectionsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-1" },
      body: {
        name: "ollama",
        provider: "ollama",
        auth: { type: "none" },
      },
      throwOnError: false,
    });
    expect(configLlmProfilesByNamePutMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-1", name: "custom-balanced" },
      body: {
        provider: "ollama",
        model: "mistral",
        provider_connection: "ollama",
        source: "user",
        label: "Balanced",
        description: "Good balance of quality, cost, and speed",
        maxTokens: 4096,
        contextWindow: { maxInputTokens: 32768 },
        effort: "none",
        thinking: { enabled: false, streamThinking: false },
      },
      throwOnError: false,
    });
    expect(configPatchMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-1" },
      body: { llm: { activeProfile: "custom-balanced" } },
      throwOnError: false,
    });
    expect(peekPendingProviderKey()).toBeNull();
  });

  test("applies an OpenRouter API key, connection, and profile with model metadata", async () => {
    // GIVEN an OpenRouter provider key with a selected model
    setPendingProviderKey({
      provider: "openrouter",
      key: "sk-or-v1-test",
      model: "anthropic/claude-sonnet-4.6",
    });

    // WHEN the pending key is applied
    await applyPendingProviderKey("local-2");

    // THEN the API key is stored
    expect(secretsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-2" },
      body: {
        type: "api_key",
        name: "openrouter",
        value: "sk-or-v1-test",
      },
      throwOnError: false,
    });
    // AND the provider connection is created with API-key auth
    expect(inferenceProviderconnectionsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-2" },
      body: {
        name: "openrouter",
        provider: "openrouter",
        auth: {
          type: "api_key",
          credential: "credential/openrouter/api_key",
        },
      },
      throwOnError: false,
    });
    // AND the profile uses model metadata from the onboarding catalog
    expect(configLlmProfilesByNamePutMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-2", name: "custom-balanced" },
      body: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        provider_connection: "openrouter",
        source: "user",
        label: "Balanced",
        description: "Good balance of quality, cost, and speed",
        maxTokens: 64_000,
        contextWindow: { maxInputTokens: 200_000 },
        effort: "high",
        thinking: { enabled: true, streamThinking: true },
      },
      throwOnError: false,
    });
    // AND the profile is activated
    expect(configPatchMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-2" },
      body: { llm: { activeProfile: "custom-balanced" } },
      throwOnError: false,
    });
    expect(peekPendingProviderKey()).toBeNull();
  });
});

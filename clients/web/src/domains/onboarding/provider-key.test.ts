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
});

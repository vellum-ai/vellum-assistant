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
const configLlmDefaultproviderPutMock = mock(async () => ({
  response: { ok: true, status: 200 },
}));
// Version fetched by the onboarding-default-provider gate. Defaults to the
// gate's MIN_VERSION so tests exercise the new write path unless they
// override it.
const identityGetMock = mock(async () => ({
  data: { version: "0.11.1" } as { version: string | null } | null,
  error: undefined,
  response: { ok: true, status: 200 },
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  secretsPost: secretsPostMock,
  inferenceProviderconnectionsPost: inferenceProviderconnectionsPostMock,
  configLlmProfilesByNamePut: configLlmProfilesByNamePutMock,
  configPatch: configPatchMock,
  configLlmDefaultproviderPut: configLlmDefaultproviderPutMock,
  identityGet: identityGetMock,
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
  configLlmDefaultproviderPutMock.mockClear();
  identityGetMock.mockClear();
  identityGetMock.mockImplementation(async () => ({
    data: { version: "0.11.1" },
    error: undefined,
    response: { ok: true, status: 200 },
  }));
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

  test("API-key providers rely on the code-defined defaults: key, personal connection, default provider — no profile writes", async () => {
    // GIVEN an OpenAI provider key
    setPendingProviderKey({ provider: "openai", key: "sk-proj-test" });

    // WHEN the pending key is applied
    await applyPendingProviderKey("local-2");

    // THEN the API key is stored
    expect(secretsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-2" },
      body: { type: "api_key", name: "openai", value: "sk-proj-test" },
      throwOnError: false,
    });
    // AND the `<provider>-personal` connection the default profiles dispatch
    // through is created
    expect(inferenceProviderconnectionsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-2" },
      body: {
        name: "openai-personal",
        provider: "openai",
        auth: {
          type: "api_key",
          credential: "credential/openai/api_key",
        },
        label: "OpenAI (Personal)",
      },
      throwOnError: false,
    });
    // AND the default provider reflects the pick
    expect(configLlmDefaultproviderPutMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-2" },
      body: { provider: "openai" },
      throwOnError: false,
    });
    // AND no profile is authored or activated — the hatch-activated
    // `balanced` default stays in charge
    expect(configLlmProfilesByNamePutMock).not.toHaveBeenCalled();
    expect(configPatchMock).not.toHaveBeenCalled();
    expect(peekPendingProviderKey()).toBeNull();
  });

  test("a selected model on an API-key provider is ignored — defaults resolve models via the daemon matrix", async () => {
    setPendingProviderKey({
      provider: "vercel-ai-gateway",
      key: "vck_test",
      model: "anthropic/claude-sonnet-4.6",
    });

    await applyPendingProviderKey("local-3");

    expect(inferenceProviderconnectionsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-3" },
      body: {
        name: "vercel-ai-gateway-personal",
        provider: "vercel-ai-gateway",
        auth: {
          type: "api_key",
          credential: "credential/vercel-ai-gateway/api_key",
        },
        label: "Vercel AI Gateway (Personal)",
      },
      throwOnError: false,
    });
    expect(configLlmDefaultproviderPutMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-3" },
      body: { provider: "vercel-ai-gateway" },
      throwOnError: false,
    });
    expect(configLlmProfilesByNamePutMock).not.toHaveBeenCalled();
    expect(configPatchMock).not.toHaveBeenCalled();
  });

  test("Ollama authors a provider-named profile and activates it (no matrix column for keyless providers)", async () => {
    setPendingProviderKey({ provider: "ollama", key: "", model: "mistral" });

    await applyPendingProviderKey("local-1");

    expect(secretsPostMock).not.toHaveBeenCalled();
    expect(configLlmDefaultproviderPutMock).not.toHaveBeenCalled();
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
      path: { assistant_id: "local-1", name: "ollama" },
      body: {
        provider: "ollama",
        model: "mistral",
        provider_connection: "ollama",
        source: "user",
        label: "Ollama",
        maxTokens: 4096,
        contextWindow: { maxInputTokens: 32768 },
        effort: "none",
        thinking: { enabled: false, streamThinking: false },
      },
      throwOnError: false,
    });
    expect(configPatchMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-1" },
      body: { llm: { activeProfile: "ollama" } },
      throwOnError: false,
    });
    expect(peekPendingProviderKey()).toBeNull();
  });

  test("openai-compatible authors a provider-named profile from the custom base URL + models", async () => {
    setPendingProviderKey({
      provider: "openai-compatible",
      key: "sk-custom",
      baseUrl: "https://llm.example.com/v1",
      customModels: "model-a, model-b",
    });

    await applyPendingProviderKey("local-4");

    expect(secretsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-4" },
      body: {
        type: "api_key",
        name: "openai-compatible",
        value: "sk-custom",
      },
      throwOnError: false,
    });
    expect(configLlmDefaultproviderPutMock).not.toHaveBeenCalled();
    expect(inferenceProviderconnectionsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-4" },
      body: {
        name: "openai-compatible",
        provider: "openai-compatible",
        auth: {
          type: "api_key",
          credential: "credential/openai-compatible/api_key",
        },
        base_url: "https://llm.example.com/v1",
        models: [{ id: "model-a" }, { id: "model-b" }],
      },
      throwOnError: false,
    });
    expect(configLlmProfilesByNamePutMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-4", name: "openai-compatible" },
      body: {
        provider: "openai-compatible",
        model: "model-a",
        provider_connection: "openai-compatible",
        source: "user",
        label: "OpenAI-compatible",
        maxTokens: 16_000,
        contextWindow: { maxInputTokens: 200_000 },
        effort: "high",
        thinking: { enabled: true, streamThinking: true },
      },
      throwOnError: false,
    });
    expect(configPatchMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-4" },
      body: { llm: { activeProfile: "openai-compatible" } },
      throwOnError: false,
    });
  });

  test("an assistant below the gate gets the legacy custom-balanced flow instead of the default-provider write", async () => {
    // 0.11.0 has the PUT endpoint but not the code-defined BYOK defaults —
    // the new path would leave `balanced` resolving through the vellum
    // column with the entered key unused.
    identityGetMock.mockImplementation(async () => ({
      data: { version: "0.11.0" },
      error: undefined,
      response: { ok: true, status: 200 },
    }));
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });

    await applyPendingProviderKey("local-5");

    expect(secretsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-5" },
      body: { type: "api_key", name: "anthropic", value: "sk-ant-test" },
      throwOnError: false,
    });
    expect(configLlmDefaultproviderPutMock).not.toHaveBeenCalled();
    // Legacy shape: provider-named connection, not `<provider>-personal`
    expect(inferenceProviderconnectionsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-5" },
      body: {
        name: "anthropic",
        provider: "anthropic",
        auth: {
          type: "api_key",
          credential: "credential/anthropic/api_key",
        },
      },
      throwOnError: false,
    });
    expect(configLlmProfilesByNamePutMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-5", name: "custom-balanced" },
      body: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        provider_connection: "anthropic",
        source: "user",
        label: "Balanced",
        description: "Good balance of quality, cost, and speed",
        maxTokens: 16_000,
        contextWindow: { maxInputTokens: 200_000 },
        effort: "high",
        thinking: { enabled: true, streamThinking: true },
      },
      throwOnError: false,
    });
    expect(configPatchMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-5" },
      body: { llm: { activeProfile: "custom-balanced" } },
      throwOnError: false,
    });
    expect(peekPendingProviderKey()).toBeNull();
  });

  test("an unresolvable assistant version falls back to the legacy flow", async () => {
    identityGetMock.mockImplementation(async () => ({
      data: null,
      error: undefined,
      response: { ok: false, status: 503 },
    }));
    setPendingProviderKey({ provider: "openai", key: "sk-proj-test" });

    await applyPendingProviderKey("local-6");

    expect(configLlmDefaultproviderPutMock).not.toHaveBeenCalled();
    expect(configLlmProfilesByNamePutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { assistant_id: "local-6", name: "custom-balanced" },
      }),
    );
    expect(configPatchMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-6" },
      body: { llm: { activeProfile: "custom-balanced" } },
      throwOnError: false,
    });
  });

  test("a dev build on the gate's base version takes the new path", async () => {
    identityGetMock.mockImplementation(async () => ({
      data: { version: "0.11.1-dev.202607290000.abc1234" },
      error: undefined,
      response: { ok: true, status: 200 },
    }));
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });

    await applyPendingProviderKey("local-7");

    expect(configLlmDefaultproviderPutMock).toHaveBeenCalledWith({
      path: { assistant_id: "local-7" },
      body: { provider: "anthropic" },
      throwOnError: false,
    });
    expect(configLlmProfilesByNamePutMock).not.toHaveBeenCalled();
    expect(configPatchMock).not.toHaveBeenCalled();
  });
});

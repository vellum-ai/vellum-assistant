import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createTestHandlerContext,
  noopLogger,
} from "./handlers/handler-test-helpers.js";

// ── Mock state ──────────────────────────────────────────────────────────────

const MOCK_PROVIDER_CATALOG = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    defaultModel: "claude-sonnet-4-20250514",
    models: [
      { id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
    ],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    defaultModel: "gpt-4o",
    models: [
      { id: "gpt-4o", displayName: "GPT-4o" },
      { id: "gpt-4o-mini", displayName: "GPT-4o Mini" },
    ],
  },
];

let currentConfig = {
  services: {
    inference: { model: "claude-sonnet-4-20250514", provider: "anthropic" },
  },
};

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

const mockSaveRawConfig = mock();
mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
  loadRawConfig: () => ({}),
  saveRawConfig: mockSaveRawConfig,
}));

const mockSetServiceField = mock();
mock.module("../config/raw-config-utils.js", () => ({
  setServiceField: mockSetServiceField,
}));

mock.module("../config/schemas/services.js", () => ({
  VALID_INFERENCE_PROVIDERS: [
    "anthropic",
    "openai",
    "gemini",
    "ollama",
    "fireworks",
    "openrouter",
  ],
}));

const mockIsModelInCatalog = mock(() => false);
mock.module("../providers/model-catalog.js", () => ({
  PROVIDER_CATALOG: MOCK_PROVIDER_CATALOG,
  isModelInCatalog: mockIsModelInCatalog,
}));

const mockGetProviderDefaultModel = mock(() => "gpt-4o");
mock.module("../providers/model-intents.js", () => ({
  getProviderDefaultModel: mockGetProviderDefaultModel,
}));

const mockGetConfiguredProviders = mock(async () => ["anthropic"]);
const mockIsProviderAvailable = mock(async () => true);
mock.module("../providers/provider-availability.js", () => ({
  getConfiguredProviders: mockGetConfiguredProviders,
  isProviderAvailable: mockIsProviderAvailable,
}));

const mockInitializeProviders = mock(async () => {});
mock.module("../providers/registry.js", () => ({
  initializeProviders: mockInitializeProviders,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import type { ModelSetContext } from "../daemon/handlers/config-model.js";
import {
  getModelInfo,
  handleImageGenModelSet,
  handleModelGet,
  handleModelSet,
  setImageGenModel,
  setModel,
} from "../daemon/handlers/config-model.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createModelSetContext(
  conversations?: Map<
    string,
    { isProcessing(): boolean; dispose(): void; markStale(): void }
  >,
): ModelSetContext & {
  setSuppressConfigReload: ReturnType<typeof mock>;
  updateConfigFingerprint: ReturnType<typeof mock>;
} {
  return {
    conversations: conversations ?? new Map(),
    suppressConfigReload: false,
    setSuppressConfigReload: mock(() => {}),
    updateConfigFingerprint: mock(() => {}),
    debounceTimers: { schedule: mock(() => {}) },
  };
}

function resetConfig() {
  currentConfig = {
    services: {
      inference: { model: "claude-sonnet-4-20250514", provider: "anthropic" },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("getModelInfo", () => {
  beforeEach(() => {
    resetConfig();
    mockGetConfiguredProviders.mockReset();
    mockGetConfiguredProviders.mockResolvedValue(["anthropic"]);
  });

  test("returns current model, provider, configured providers, available models, and all providers", async () => {
    const info = await getModelInfo();

    expect(info.model).toBe("claude-sonnet-4-20250514");
    expect(info.provider).toBe("anthropic");
    expect(info.configuredProviders).toEqual(["anthropic"]);
    expect(info.availableModels).toEqual(MOCK_PROVIDER_CATALOG[0].models);
    expect(info.allProviders).toBe(MOCK_PROVIDER_CATALOG);
  });
});

describe("setModel", () => {
  beforeEach(() => {
    resetConfig();
    mockSaveRawConfig.mockReset();
    mockSetServiceField.mockReset();
    mockInitializeProviders.mockReset();
    mockIsProviderAvailable.mockReset();
    mockIsProviderAvailable.mockResolvedValue(true);
    mockIsModelInCatalog.mockReset();
    mockIsModelInCatalog.mockReturnValue(false);
    mockGetProviderDefaultModel.mockReset();
    mockGetProviderDefaultModel.mockReturnValue("gpt-4o");
    mockGetConfiguredProviders.mockReset();
    mockGetConfiguredProviders.mockResolvedValue(["anthropic"]);
  });

  test("sets model successfully — saves config, reinitializes providers", async () => {
    const ctx = createModelSetContext();

    await setModel("gpt-4o", ctx, "openai");

    expect(mockSetServiceField).toHaveBeenCalledWith(
      expect.any(Object),
      "inference",
      "model",
      "gpt-4o",
    );
    expect(mockSetServiceField).toHaveBeenCalledWith(
      expect.any(Object),
      "inference",
      "provider",
      "openai",
    );
    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
    expect(mockInitializeProviders).toHaveBeenCalledTimes(1);
    expect(ctx.updateConfigFingerprint).toHaveBeenCalledTimes(1);
  });

  test("explicit provider takes precedence over auto-detection", async () => {
    const ctx = createModelSetContext();

    // gpt-4o would auto-resolve to openai via MODEL_TO_PROVIDER,
    // but explicit "gemini" should override
    mockIsModelInCatalog.mockReturnValue(true);
    await setModel("gpt-4o", ctx, "gemini");

    expect(mockSetServiceField).toHaveBeenCalledWith(
      expect.any(Object),
      "inference",
      "provider",
      "gemini",
    );
  });

  test("invalid explicit provider throws", async () => {
    const ctx = createModelSetContext();

    await expect(
      setModel("any-model", ctx, "invalid-provider"),
    ).rejects.toThrow('Invalid provider "invalid-provider"');

    expect(mockSaveRawConfig).not.toHaveBeenCalled();
  });

  test("provider change auto-resets model when current model not in new catalog", async () => {
    const ctx = createModelSetContext();
    mockIsModelInCatalog.mockReturnValue(false);
    mockGetProviderDefaultModel.mockReturnValue("gemini-2.0-flash");

    await setModel("claude-sonnet-4-20250514", ctx, "gemini");

    // Model should be reset to gemini's default
    expect(mockGetProviderDefaultModel).toHaveBeenCalledWith("gemini");
    expect(mockSetServiceField).toHaveBeenCalledWith(
      expect.any(Object),
      "inference",
      "model",
      "gemini-2.0-flash",
    );
  });

  test("unavailable provider returns current info without changing config", async () => {
    mockIsProviderAvailable.mockResolvedValue(false);
    const ctx = createModelSetContext();

    const info = await setModel("gpt-4o", ctx, "openai");

    // Should return current config, not the requested model
    expect(info.model).toBe("claude-sonnet-4-20250514");
    expect(info.provider).toBe("anthropic");
    expect(mockSaveRawConfig).not.toHaveBeenCalled();
    expect(mockInitializeProviders).not.toHaveBeenCalled();
  });

  test("no-op when model and provider are unchanged", async () => {
    const ctx = createModelSetContext();

    // Request the same model+provider as current
    const info = await setModel("claude-sonnet-4-20250514", ctx, "anthropic");

    expect(info.model).toBe("claude-sonnet-4-20250514");
    expect(mockSaveRawConfig).not.toHaveBeenCalled();
    expect(mockInitializeProviders).not.toHaveBeenCalled();
  });

  test("evicts idle conversations after model change", async () => {
    const disposeMock = mock(() => {});
    const conversations = new Map<
      string,
      { isProcessing(): boolean; dispose(): void; markStale(): void }
    >();
    conversations.set("idle-conv", {
      isProcessing: () => false,
      dispose: disposeMock,
      markStale: mock(() => {}),
    });
    const ctx = createModelSetContext(conversations);

    await setModel("gpt-4o", ctx, "openai");

    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(conversations.has("idle-conv")).toBe(false);
  });

  test("marks busy conversations as stale after model change", async () => {
    const markStaleMock = mock(() => {});
    const conversations = new Map<
      string,
      { isProcessing(): boolean; dispose(): void; markStale(): void }
    >();
    conversations.set("busy-conv", {
      isProcessing: () => true,
      dispose: mock(() => {}),
      markStale: markStaleMock,
    });
    const ctx = createModelSetContext(conversations);

    await setModel("gpt-4o", ctx, "openai");

    expect(markStaleMock).toHaveBeenCalledTimes(1);
    // Busy conversation should NOT be removed from the map
    expect(conversations.has("busy-conv")).toBe(true);
  });

  test("suppresses config reload during save", async () => {
    const ctx = createModelSetContext();

    await setModel("gpt-4o", ctx, "openai");

    expect(ctx.setSuppressConfigReload).toHaveBeenCalledWith(true);
  });
});

describe("setImageGenModel", () => {
  beforeEach(() => {
    mockSaveRawConfig.mockReset();
    mockSetServiceField.mockReset();
  });

  test("saves image-generation model to config", () => {
    const ctx = createModelSetContext();

    setImageGenModel("gemini-2.0-flash", ctx);

    expect(mockSetServiceField).toHaveBeenCalledWith(
      expect.any(Object),
      "image-generation",
      "model",
      "gemini-2.0-flash",
    );
    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
    expect(ctx.updateConfigFingerprint).toHaveBeenCalledTimes(1);
  });

  test("suppresses config reload during save", () => {
    const ctx = createModelSetContext();

    setImageGenModel("dall-e-3", ctx);

    expect(ctx.setSuppressConfigReload).toHaveBeenCalledWith(true);
  });
});

describe("handleModelGet", () => {
  beforeEach(() => {
    resetConfig();
    mockGetConfiguredProviders.mockReset();
    mockGetConfiguredProviders.mockResolvedValue(["anthropic"]);
  });

  test("sends model_info via ctx.send", async () => {
    const { ctx, sent } = createTestHandlerContext();

    await handleModelGet(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("model_info");
    expect(sent[0].model).toBe("claude-sonnet-4-20250514");
    expect(sent[0].provider).toBe("anthropic");
  });
});

describe("handleModelSet", () => {
  beforeEach(() => {
    resetConfig();
    mockSaveRawConfig.mockReset();
    mockSetServiceField.mockReset();
    mockInitializeProviders.mockReset();
    mockIsProviderAvailable.mockReset();
    mockIsProviderAvailable.mockResolvedValue(true);
    mockIsModelInCatalog.mockReset();
    mockGetConfiguredProviders.mockReset();
    mockGetConfiguredProviders.mockResolvedValue(["anthropic"]);
  });

  test("success sends model_info", async () => {
    const { ctx, sent } = createTestHandlerContext();

    await handleModelSet(
      { type: "model_set", model: "gpt-4o", provider: "openai" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("model_info");
  });

  test("failure sends error", async () => {
    const { ctx, sent } = createTestHandlerContext();

    await handleModelSet(
      { type: "model_set", model: "x", provider: "invalid" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(sent[0].message).toContain("Failed to set model");
  });
});

describe("handleImageGenModelSet", () => {
  beforeEach(() => {
    mockSaveRawConfig.mockReset();
    mockSetServiceField.mockReset();
  });

  test("delegates to setImageGenModel", () => {
    const { ctx } = createTestHandlerContext();

    handleImageGenModelSet(
      { type: "image_gen_model_set", model: "dall-e-3" },
      ctx,
    );

    expect(mockSetServiceField).toHaveBeenCalledWith(
      expect.any(Object),
      "image-generation",
      "model",
      "dall-e-3",
    );
  });
});

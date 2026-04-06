import { beforeEach, describe, expect, mock, test } from "bun:test";

import { noopLogger } from "./handlers/handler-test-helpers.js";

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

let currentConfig: Record<string, unknown> = {};
let rawConfig: Record<string, unknown> = {};
const mockSaveRawConfig = mock();

mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: mockSaveRawConfig,
}));

const mockSetMemoryEmbeddingField = mock();
const mockDeleteMemoryEmbeddingField = mock();

mock.module("../config/raw-config-utils.js", () => ({
  setMemoryEmbeddingField: mockSetMemoryEmbeddingField,
  deleteMemoryEmbeddingField: mockDeleteMemoryEmbeddingField,
}));

const mockClearEmbeddingBackendCache = mock();
const mockGetMemoryBackendStatus = mock();

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: mockClearEmbeddingBackendCache,
  getMemoryBackendStatus: mockGetMemoryBackendStatus,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  getEmbeddingConfigInfo,
  setEmbeddingConfig,
} from "../daemon/handlers/config-embeddings.js";
import type { ModelSetContext } from "../daemon/handlers/config-model.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createModelSetContext(): ModelSetContext {
  return {
    conversations: new Map(),
    suppressConfigReload: false,
    setSuppressConfigReload: mock(() => {}),
    updateConfigFingerprint: mock(() => {}),
    debounceTimers: { schedule: mock(() => {}) },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("getEmbeddingConfigInfo", () => {
  beforeEach(() => {
    mockGetMemoryBackendStatus.mockReset();
    currentConfig = {
      memory: {
        embeddings: {
          provider: "openai",
          openaiModel: "text-embedding-3-small",
        },
      },
    };
  });

  test("returns current provider, model, active backend status, and available providers", async () => {
    mockGetMemoryBackendStatus.mockResolvedValue({
      provider: "openai",
      model: "text-embedding-3-small",
      enabled: true,
      degraded: false,
      reason: null,
    });

    const result = await getEmbeddingConfigInfo();

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.activeProvider).toBe("openai");
    expect(result.activeModel).toBe("text-embedding-3-small");
    expect(result.status.enabled).toBe(true);
    expect(result.status.degraded).toBe(false);
    expect(result.status.reason).toBeNull();
    expect(result.availableProviders).toBeArray();
    expect(result.availableProviders.length).toBeGreaterThan(0);
    expect(result.availableProviders.map((p) => p.id)).toContain("openai");
    expect(result.availableProviders.map((p) => p.id)).toContain("local");
    expect(result.availableProviders.map((p) => p.id)).toContain("auto");
  });

  test("returns model: null when provider has no model field", async () => {
    currentConfig = {
      memory: {
        embeddings: {
          provider: "auto",
        },
      },
    };
    mockGetMemoryBackendStatus.mockResolvedValue({
      provider: "local",
      model: "Xenova/bge-small-en-v1.5",
      enabled: true,
      degraded: false,
      reason: null,
    });

    const result = await getEmbeddingConfigInfo();

    expect(result.provider).toBe("auto");
    // "auto" has no entry in PROVIDER_MODEL_FIELD → model is null
    expect(result.model).toBeNull();
  });

  test("reflects degraded backend status", async () => {
    mockGetMemoryBackendStatus.mockResolvedValue({
      provider: null,
      model: null,
      enabled: false,
      degraded: true,
      reason: "Qdrant unavailable",
    });

    const result = await getEmbeddingConfigInfo();

    expect(result.status.enabled).toBe(false);
    expect(result.status.degraded).toBe(true);
    expect(result.status.reason).toBe("Qdrant unavailable");
  });
});

describe("setEmbeddingConfig", () => {
  beforeEach(() => {
    mockSaveRawConfig.mockReset();
    mockSetMemoryEmbeddingField.mockReset();
    mockDeleteMemoryEmbeddingField.mockReset();
    mockClearEmbeddingBackendCache.mockReset();
    mockGetMemoryBackendStatus.mockReset();
    rawConfig = {};
    currentConfig = {
      memory: {
        embeddings: {
          provider: "auto",
        },
      },
    };
    mockGetMemoryBackendStatus.mockResolvedValue({
      provider: "auto",
      model: null,
      enabled: true,
      degraded: false,
      reason: null,
    });
  });

  test("valid provider saves config, clears cache, updates fingerprint", async () => {
    const ctx = createModelSetContext();

    await setEmbeddingConfig("openai", undefined, ctx);

    expect(mockSetMemoryEmbeddingField).toHaveBeenCalledWith(
      expect.any(Object),
      "provider",
      "openai",
    );
    expect(mockSaveRawConfig).toHaveBeenCalledTimes(1);
    expect(mockClearEmbeddingBackendCache).toHaveBeenCalledTimes(1);
    expect(ctx.updateConfigFingerprint).toHaveBeenCalledTimes(1);
  });

  test("invalid provider throws with valid provider list", async () => {
    const ctx = createModelSetContext();

    await expect(
      setEmbeddingConfig("invalid-provider", undefined, ctx),
    ).rejects.toThrow("Invalid embedding provider");

    expect(mockSaveRawConfig).not.toHaveBeenCalled();
    expect(mockClearEmbeddingBackendCache).not.toHaveBeenCalled();
  });

  test("sets provider-specific model field when model is provided", async () => {
    const ctx = createModelSetContext();

    await setEmbeddingConfig("openai", "text-embedding-3-large", ctx);

    // Should set provider first, then model
    expect(mockSetMemoryEmbeddingField).toHaveBeenCalledWith(
      expect.any(Object),
      "provider",
      "openai",
    );
    expect(mockSetMemoryEmbeddingField).toHaveBeenCalledWith(
      expect.any(Object),
      "openaiModel",
      "text-embedding-3-large",
    );
  });

  test("empty model string deletes model field override", async () => {
    const ctx = createModelSetContext();

    await setEmbeddingConfig("openai", "", ctx);

    expect(mockDeleteMemoryEmbeddingField).toHaveBeenCalledWith(
      expect.any(Object),
      "openaiModel",
    );
    expect(mockSetMemoryEmbeddingField).not.toHaveBeenCalledWith(
      expect.any(Object),
      "openaiModel",
      expect.anything(),
    );
  });

  test("undefined model only sets provider, skips model field", async () => {
    const ctx = createModelSetContext();

    await setEmbeddingConfig("gemini", undefined, ctx);

    // Should only set provider, not model
    expect(mockSetMemoryEmbeddingField).toHaveBeenCalledTimes(1);
    expect(mockSetMemoryEmbeddingField).toHaveBeenCalledWith(
      expect.any(Object),
      "provider",
      "gemini",
    );
    expect(mockDeleteMemoryEmbeddingField).not.toHaveBeenCalled();
  });
});

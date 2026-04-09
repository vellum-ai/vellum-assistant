import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "memory", "knowledge"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

// ---------------------------------------------------------------------------
// Feature flag mock — controls whether managed-gemini-embeddings-enabled is on
// ---------------------------------------------------------------------------

let featureFlagEnabled = false;

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    if (key === "managed-gemini-embeddings-enabled") return featureFlagEnabled;
    return true;
  },
  _setOverridesForTesting: () => {},
  clearFeatureFlagOverridesCache: () => {},
  initFeatureFlagOverrides: async () => {},
  getAssistantFeatureFlagDefaults: () => ({}),
}));

// ---------------------------------------------------------------------------
// Managed proxy context mock — controls whether proxy prereqs are satisfied
// ---------------------------------------------------------------------------

let proxyEnabled = false;

mock.module("../providers/managed-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: proxyEnabled,
    platformBaseUrl: proxyEnabled ? "https://api.vellum.ai" : "",
    assistantApiKey: proxyEnabled ? "test-api-key" : "",
  }),
  hasManagedProxyPrereqs: async () => proxyEnabled,
  buildManagedBaseUrl: async () =>
    proxyEnabled ? "https://api.vellum.ai/v1/runtime-proxy/gemini" : undefined,
  managedFallbackEnabledFor: async () => proxyEnabled,
  isManagedProxyEnabledSync: () => proxyEnabled,
  _resetManagedProxyEnabledCache: () => {},
}));

// Restore all mocked modules after this file's tests complete to prevent
// cross-test contamination when running grouped with other test files.
afterAll(() => {
  mock.restore();
});

import {
  applyManagedGeminiDefaults,
  invalidateConfigCache,
  loadConfig,
} from "../config/loader.js";
import { _setStorePath } from "../security/encrypted-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyManagedGeminiDefaults", () => {
  beforeEach(() => {
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
      join(WORKSPACE_DIR, "keys.enc"),
      join(WORKSPACE_DIR, "data"),
      join(WORKSPACE_DIR, "data", "memory"),
    ];
    for (const path of resetPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    ensureTestDir();
    _setStorePath(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();

    // Reset mock state
    featureFlagEnabled = false;
    proxyEnabled = false;
  });

  afterEach(() => {
    _setStorePath(null);
    invalidateConfigCache();
  });

  test("applies managed Gemini defaults when FF on + proxy available + provider auto", async () => {
    // Config with default provider=auto (no explicit provider)
    writeConfig({});

    featureFlagEnabled = true;
    proxyEnabled = true;

    const config = loadConfig();
    expect(config.memory.embeddings.provider).toBe("auto");

    const updated = await applyManagedGeminiDefaults(config);

    // In-memory config should be updated
    expect(updated.memory.embeddings.provider).toBe("gemini");
    expect(updated.memory.embeddings.geminiModel).toBe(
      "gemini-embedding-2-preview",
    );
    expect(updated.memory.embeddings.geminiDimensions).toBe(3072);
    expect(updated.memory.qdrant.vectorSize).toBe(3072);

    // Config file on disk should also be updated
    const raw = readConfig();
    const memoryRaw = raw.memory as Record<string, unknown>;
    const embeddingsRaw = memoryRaw.embeddings as Record<string, unknown>;
    const qdrantRaw = memoryRaw.qdrant as Record<string, unknown>;
    expect(embeddingsRaw.provider).toBe("gemini");
    expect(embeddingsRaw.geminiModel).toBe("gemini-embedding-2-preview");
    expect(embeddingsRaw.geminiDimensions).toBe(3072);
    expect(qdrantRaw.vectorSize).toBe(3072);
  });

  test("does NOT apply when feature flag is OFF", async () => {
    writeConfig({});

    featureFlagEnabled = false;
    proxyEnabled = true;

    const config = loadConfig();
    const updated = await applyManagedGeminiDefaults(config);

    expect(updated.memory.embeddings.provider).toBe("auto");
    expect(updated.memory.qdrant.vectorSize).toBe(384);
  });

  test("does NOT apply when proxy context is unavailable", async () => {
    writeConfig({});

    featureFlagEnabled = true;
    proxyEnabled = false;

    const config = loadConfig();
    const updated = await applyManagedGeminiDefaults(config);

    expect(updated.memory.embeddings.provider).toBe("auto");
    expect(updated.memory.qdrant.vectorSize).toBe(384);
  });

  test("does NOT apply when provider is explicitly set to local", async () => {
    writeConfig({
      memory: { embeddings: { provider: "local" } },
    });

    featureFlagEnabled = true;
    proxyEnabled = true;

    const config = loadConfig();
    expect(config.memory.embeddings.provider).toBe("local");

    const updated = await applyManagedGeminiDefaults(config);

    expect(updated.memory.embeddings.provider).toBe("local");
    expect(updated.memory.qdrant.vectorSize).toBe(384);
  });

  test("does NOT apply when provider is explicitly set to openai", async () => {
    writeConfig({
      memory: { embeddings: { provider: "openai" } },
    });

    featureFlagEnabled = true;
    proxyEnabled = true;

    const config = loadConfig();
    const updated = await applyManagedGeminiDefaults(config);

    expect(updated.memory.embeddings.provider).toBe("openai");
  });

  test("does NOT apply when provider is explicitly set to gemini", async () => {
    writeConfig({
      memory: {
        embeddings: { provider: "gemini", geminiDimensions: 768 },
        qdrant: { vectorSize: 768 },
      },
    });

    featureFlagEnabled = true;
    proxyEnabled = true;

    const config = loadConfig();
    const updated = await applyManagedGeminiDefaults(config);

    // Already gemini — should not overwrite user's custom dimensions
    expect(updated.memory.embeddings.provider).toBe("gemini");
    expect(updated.memory.embeddings.geminiDimensions).toBe(768);
    expect(updated.memory.qdrant.vectorSize).toBe(768);
  });

  test("does NOT apply when provider is explicitly set to ollama", async () => {
    writeConfig({
      memory: { embeddings: { provider: "ollama" } },
    });

    featureFlagEnabled = true;
    proxyEnabled = true;

    const config = loadConfig();
    const updated = await applyManagedGeminiDefaults(config);

    expect(updated.memory.embeddings.provider).toBe("ollama");
  });

  test("is idempotent — second call is a no-op after migration", async () => {
    writeConfig({});

    featureFlagEnabled = true;
    proxyEnabled = true;

    const config = loadConfig();
    const updated = await applyManagedGeminiDefaults(config);
    expect(updated.memory.embeddings.provider).toBe("gemini");

    // Read file content after first migration
    const contentAfterFirst = readFileSync(CONFIG_PATH, "utf-8");

    // Second call — provider is now "gemini", not "auto", so no-op
    invalidateConfigCache();
    const config2 = loadConfig();
    expect(config2.memory.embeddings.provider).toBe("gemini");

    const updated2 = await applyManagedGeminiDefaults(config2);
    expect(updated2.memory.embeddings.provider).toBe("gemini");

    // File on disk should not have changed
    const contentAfterSecond = readFileSync(CONFIG_PATH, "utf-8");
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  test("preserves existing config values while setting managed defaults", async () => {
    writeConfig({
      provider: "anthropic",
      model: "claude-opus-4-6",
      memory: {
        enabled: true,
        qdrant: { collection: "my-collection", onDisk: false },
      },
    });

    featureFlagEnabled = true;
    proxyEnabled = true;

    const config = loadConfig();
    const updated = await applyManagedGeminiDefaults(config);

    // Managed defaults applied
    expect(updated.memory.embeddings.provider).toBe("gemini");
    expect(updated.memory.embeddings.geminiModel).toBe(
      "gemini-embedding-2-preview",
    );
    expect(updated.memory.qdrant.vectorSize).toBe(3072);

    // Existing values preserved
    const raw = readConfig();
    expect(raw.provider).toBe("anthropic");
    expect(raw.model).toBe("claude-opus-4-6");
    const memoryRaw = raw.memory as Record<string, unknown>;
    expect(memoryRaw.enabled).toBe(true);
    const qdrantRaw = memoryRaw.qdrant as Record<string, unknown>;
    expect(qdrantRaw.collection).toBe("my-collection");
    expect(qdrantRaw.onDisk).toBe(false);
  });

  test("does NOT apply when both FF off and proxy unavailable", async () => {
    writeConfig({});

    featureFlagEnabled = false;
    proxyEnabled = false;

    const config = loadConfig();
    const updated = await applyManagedGeminiDefaults(config);

    expect(updated.memory.embeddings.provider).toBe("auto");
    expect(updated.memory.qdrant.vectorSize).toBe(384);
  });
});

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

// Restore all mocked modules after this file's tests complete to prevent
// cross-test contamination when running grouped with other test files.
afterAll(() => {
  mock.restore();
});

import { invalidateConfigCache, loadConfig } from "../config/loader.js";
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

/** Stash and restore IS_PLATFORM across each test. */
let originalIsPlatform: string | undefined;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("managed Gemini embedding defaults (via loadConfig)", () => {
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
    originalIsPlatform = process.env.IS_PLATFORM;
    delete process.env.IS_PLATFORM;
  });

  afterEach(() => {
    _setStorePath(null);
    invalidateConfigCache();

    // Restore IS_PLATFORM
    if (originalIsPlatform !== undefined) {
      process.env.IS_PLATFORM = originalIsPlatform;
    } else {
      delete process.env.IS_PLATFORM;
    }
  });

  test("applies managed Gemini defaults when FF on + IS_PLATFORM + provider auto", () => {
    writeConfig({});

    featureFlagEnabled = true;
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();

    // In-memory config should have managed Gemini defaults
    expect(config.memory.embeddings.provider).toBe("gemini");
    expect(config.memory.embeddings.geminiModel).toBe(
      "gemini-embedding-2-preview",
    );
    expect(config.memory.embeddings.geminiDimensions).toBe(3072);
    expect(config.memory.qdrant.vectorSize).toBe(3072);

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

  test("does NOT apply when feature flag is OFF", () => {
    writeConfig({});

    featureFlagEnabled = false;
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();

    expect(config.memory.embeddings.provider).toBe("auto");
    expect(config.memory.qdrant.vectorSize).toBe(384);
  });

  test("does NOT apply when IS_PLATFORM is not set", () => {
    writeConfig({});

    featureFlagEnabled = true;
    delete process.env.IS_PLATFORM;

    const config = loadConfig();

    expect(config.memory.embeddings.provider).toBe("auto");
    expect(config.memory.qdrant.vectorSize).toBe(384);
  });

  test("does NOT apply when provider is explicitly set to local", () => {
    writeConfig({
      memory: { embeddings: { provider: "local" } },
    });

    featureFlagEnabled = true;
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();
    expect(config.memory.embeddings.provider).toBe("local");
    expect(config.memory.qdrant.vectorSize).toBe(384);
  });

  test("does NOT apply when provider is explicitly set to openai", () => {
    writeConfig({
      memory: { embeddings: { provider: "openai" } },
    });

    featureFlagEnabled = true;
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();
    expect(config.memory.embeddings.provider).toBe("openai");
  });

  test("does NOT apply when provider is explicitly set to gemini", () => {
    writeConfig({
      memory: {
        embeddings: { provider: "gemini", geminiDimensions: 768 },
        qdrant: { vectorSize: 768 },
      },
    });

    featureFlagEnabled = true;
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();

    // Already gemini — should not overwrite user's custom dimensions
    expect(config.memory.embeddings.provider).toBe("gemini");
    expect(config.memory.embeddings.geminiDimensions).toBe(768);
    expect(config.memory.qdrant.vectorSize).toBe(768);
  });

  test("does NOT apply when provider is explicitly set to ollama", () => {
    writeConfig({
      memory: { embeddings: { provider: "ollama" } },
    });

    featureFlagEnabled = true;
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();
    expect(config.memory.embeddings.provider).toBe("ollama");
  });

  test("is idempotent — second loadConfig is a no-op after migration", () => {
    writeConfig({});

    featureFlagEnabled = true;
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();
    expect(config.memory.embeddings.provider).toBe("gemini");

    // Read file content after first migration
    const contentAfterFirst = readFileSync(CONFIG_PATH, "utf-8");

    // Second call — provider is now "gemini", not "auto", so migration skipped
    invalidateConfigCache();
    const config2 = loadConfig();
    expect(config2.memory.embeddings.provider).toBe("gemini");

    // File on disk should not have changed
    const contentAfterSecond = readFileSync(CONFIG_PATH, "utf-8");
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  test("preserves existing config values while setting managed defaults", () => {
    writeConfig({
      provider: "anthropic",
      model: "claude-opus-4-6",
      memory: {
        enabled: true,
        qdrant: { collection: "my-collection", onDisk: false },
      },
    });

    featureFlagEnabled = true;
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();

    // Managed defaults applied
    expect(config.memory.embeddings.provider).toBe("gemini");
    expect(config.memory.embeddings.geminiModel).toBe(
      "gemini-embedding-2-preview",
    );
    expect(config.memory.qdrant.vectorSize).toBe(3072);

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

  test("does NOT apply when both FF off and IS_PLATFORM not set", () => {
    writeConfig({});

    featureFlagEnabled = false;
    delete process.env.IS_PLATFORM;

    const config = loadConfig();

    expect(config.memory.embeddings.provider).toBe("auto");
    expect(config.memory.qdrant.vectorSize).toBe(384);
  });

  test("applies when IS_PLATFORM is '1'", () => {
    writeConfig({});

    featureFlagEnabled = true;
    process.env.IS_PLATFORM = "1";

    const config = loadConfig();

    expect(config.memory.embeddings.provider).toBe("gemini");
    expect(config.memory.embeddings.geminiDimensions).toBe(3072);
  });
});

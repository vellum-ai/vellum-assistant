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

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

mock.module("../assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
  clearFeatureFlagOverridesCache: () => {},
  initFeatureFlagOverrides: async () => {},
  getAssistantFeatureFlagDefaults: () => ({}),
}));

// Restore all mocked modules after this file's tests complete to prevent
// cross-test contamination when running grouped with other test files.
afterAll(() => {
  mock.restore();
});

import { setStorePathForTesting } from "../../__tests__/encrypted-store-test-helpers.js";
import { invalidateConfigCache, loadConfig } from "../loader.js";

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

describe("deployment-context embedding-provider default (via loadConfig)", () => {
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
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();

    originalIsPlatform = process.env.IS_PLATFORM;
    delete process.env.IS_PLATFORM;
  });

  afterEach(() => {
    setStorePathForTesting(null);
    invalidateConfigCache();

    if (originalIsPlatform !== undefined) {
      process.env.IS_PLATFORM = originalIsPlatform;
    } else {
      delete process.env.IS_PLATFORM;
    }
  });

  test("IS_PLATFORM=true fills provider=gemini in memory without persisting it", () => {
    writeConfig({});
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();

    // In-memory effective config reflects the platform intent.
    expect(config.memory.embeddings.provider).toBe("gemini");
    // geminiModel carries its own schema default — not forced here.
    expect(config.memory.embeddings.geminiModel).toBe("gemini-embedding-2");

    // config.json on disk is NOT mutated: no persisted provider / vectorSize /
    // geminiDimensions under memory. The fill is in-memory only.
    const raw = readConfig();
    const memoryRaw = (raw.memory ?? {}) as Record<string, unknown>;
    const embeddingsRaw = (memoryRaw.embeddings ?? {}) as Record<
      string,
      unknown
    >;
    const qdrantRaw = (memoryRaw.qdrant ?? {}) as Record<string, unknown>;
    expect(embeddingsRaw.provider).toBeUndefined();
    expect(embeddingsRaw.geminiDimensions).toBeUndefined();
    expect(qdrantRaw.vectorSize).toBeUndefined();
  });

  test("IS_PLATFORM='1' also fills provider=gemini in memory", () => {
    writeConfig({});
    process.env.IS_PLATFORM = "1";

    const config = loadConfig();

    expect(config.memory.embeddings.provider).toBe("gemini");
  });

  test("explicit provider on disk wins over the platform default", () => {
    writeConfig({
      memory: { embeddings: { provider: "local" } },
    });
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();

    expect(config.memory.embeddings.provider).toBe("local");
    expect(config.memory.qdrant.vectorSize).toBe(384);

    // On-disk value is preserved exactly; the platform default does not bleed in.
    const raw = readConfig();
    const memoryRaw = raw.memory as Record<string, unknown>;
    const embeddingsRaw = memoryRaw.embeddings as Record<string, unknown>;
    expect(embeddingsRaw.provider).toBe("local");
  });

  test("provider stays auto when IS_PLATFORM is unset", () => {
    writeConfig({});
    delete process.env.IS_PLATFORM;

    const config = loadConfig();

    expect(config.memory.embeddings.provider).toBe("auto");
    expect(config.memory.qdrant.vectorSize).toBe(384);
  });
});

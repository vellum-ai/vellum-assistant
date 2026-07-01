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

  test("first launch (no config.json) persists managed service modes but not the platform embedding provider", () => {
    // No config.json on disk: this is the first-launch SEED path that writes a
    // default config so the file exists for users to edit.
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH, { force: true });
    process.env.IS_PLATFORM = "true";

    const config = loadConfig();

    // In-memory effective config still reflects the platform intent.
    expect(config.memory.embeddings.provider).toBe("gemini");

    // The seeded config.json persists the managed service modes (for
    // discoverability) but OMITS the embedding provider entirely — not even the
    // schema default "auto". Persisting any value would be read back on the next
    // load as an explicit user choice and permanently suppress re-applying the
    // platform "gemini" default.
    const raw = readConfig();
    const memoryRaw = (raw.memory ?? {}) as Record<string, unknown>;
    const embeddingsRaw = (memoryRaw.embeddings ?? {}) as Record<
      string,
      unknown
    >;
    expect(embeddingsRaw.provider).toBeUndefined();

    // Managed service modes ARE persisted on first launch (existing behavior).
    const servicesRaw = (raw.services ?? {}) as Record<string, unknown>;
    const webSearchRaw = (servicesRaw["web-search"] ?? {}) as Record<
      string,
      unknown
    >;
    expect(webSearchRaw.mode).toBe("managed");

    // Regression guard: on the NEXT load (config.json now exists with the
    // provider leaf absent), the platform default re-applies in memory rather
    // than being lost to a persisted "auto" read back as an explicit choice.
    invalidateConfigCache();
    expect(loadConfig().memory.embeddings.provider).toBe("gemini");
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

  test("first launch seeds memory.v3 with only `live` — tuning knobs resolve from the schema, not disk", () => {
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH, { force: true });
    delete process.env.IS_PLATFORM;

    const config = loadConfig();

    // In-memory effective config still carries the full tuning (schema defaults).
    expect(config.memory.v3.gate.denseThreshold).toBe(0.66);
    expect(config.memory.v3.needleK).toBe(100);

    // Persisted config.json carries ONLY `live` under memory.v3 — no tuning knob
    // is frozen to disk, so a shipped schema-default change reaches this
    // assistant on its next load (mirrors the embedding-provider strip above).
    const raw = readConfig();
    const v3Raw = ((raw.memory as Record<string, unknown>).v3 ?? {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(v3Raw)).toEqual(["live"]);
    expect(v3Raw.gate).toBeUndefined();
    expect(v3Raw.needleK).toBeUndefined();
  });
});

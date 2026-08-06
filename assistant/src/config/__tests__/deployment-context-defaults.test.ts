import {
  existsSync,
  mkdirSync,
  readdirSync,
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
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

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
import { enableMemoryV3LiveForNewWorkspacesMigration } from "../../workspace/migrations/105-enable-memory-v3-live-for-new-workspaces.js";
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
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
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

    // Managed service modes ARE persisted on first launch, but web-search is
    // exempt: `provider` is its only axis, and a context-filled `mode` would
    // override BYOK configs on every load. The persisted value is the schema
    // default rather than an injected "managed".
    const servicesRaw = (raw.services ?? {}) as Record<string, unknown>;
    const webSearchRaw = (servicesRaw["web-search"] ?? {}) as Record<
      string,
      unknown
    >;
    expect(webSearchRaw.mode).not.toBe("managed");

    // image-generation's managed axis is its provider: the seeded value is
    // the platform fill "vellum", never an injected managed mode.
    const imageGenRaw = (servicesRaw["image-generation"] ?? {}) as Record<
      string,
      unknown
    >;
    expect(imageGenRaw.provider).toBe("vellum");
    expect(imageGenRaw.mode).not.toBe("managed");

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

  test("first launch persists nothing under memory.v3, not even `live`", () => {
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    delete process.env.IS_PLATFORM;

    const config = loadConfig();

    // In-memory effective config still carries the full tuning (schema defaults).
    expect(config.memory.v3.gate.denseThreshold).toBe(0.66);
    expect(config.memory.v3.needleK).toBe(100);

    // Nothing under memory.v3 is frozen to disk. Tuning knobs stay absent so a
    // shipped schema-default change reaches this assistant on its next load
    // (mirrors the embedding-provider strip above), and `live` stays absent so
    // migration 105 can record the initial choice: 105 bails on any value
    // already present, and this seed runs before workspace migrations.
    const raw = readConfig();
    const v3Raw = ((raw.memory as Record<string, unknown>).v3 ?? {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(v3Raw)).toEqual([]);
    expect(v3Raw.gate).toBeUndefined();
    expect(v3Raw.needleK).toBeUndefined();
  });

  test("migration 105 turns v3 on for a workspace this seed just created", () => {
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    delete process.env.IS_PLATFORM;

    loadConfig();
    enableMemoryV3LiveForNewWorkspacesMigration.run(WORKSPACE_DIR, {
      isNewWorkspace: true,
    });

    const raw = readConfig();
    const v3Raw = ((raw.memory as Record<string, unknown>).v3 ?? {}) as Record<
      string,
      unknown
    >;
    expect(v3Raw.live).toBe(true);
  });

  describe("quarantine-reseed carries memory.v3.live forward", () => {
    function removeQuarantineFiles(): void {
      for (const name of readdirSync(WORKSPACE_DIR)) {
        if (name.startsWith("config.json.corrupt-")) {
          rmSync(join(WORKSPACE_DIR, name), { force: true });
        }
      }
    }

    function readV3Raw(): Record<string, unknown> {
      const raw = readConfig();
      return ((raw.memory as Record<string, unknown>).v3 ?? {}) as Record<
        string,
        unknown
      >;
    }

    afterEach(() => {
      removeQuarantineFiles();
    });

    test("a corrupt live-v3 config is quarantined and the reseed keeps live=true", () => {
      // Truncated mid-write JSON from a memory-v3 assistant: unparseable,
      // but the live flag survives in the raw text.
      writeFileSync(
        CONFIG_PATH,
        `{\n  "memory": {\n    "v3": {\n      "live": true\n    }\n  },\n  "llm": {\n    "activeProf`,
      );

      const config = loadConfig();

      // The corrupt file was quarantined and the reseeded config carries the
      // tier forward, both in-memory (this boot runs v3) and on disk
      // (migration 105 is checkpointed on existing workspaces and never
      // re-runs, so the persisted value is the only durable record).
      expect(config.memory.v3.live).toBe(true);
      expect(readV3Raw()).toEqual({ live: true });
    });

    test("a corrupt config without live=true reseeds with the leaf absent", () => {
      writeFileSync(
        CONFIG_PATH,
        `{\n  "memory": {\n    "v3": {\n      "live": false\n    }\n  },\n  "llm": {\n    "activeProf`,
      );

      const config = loadConfig();

      // Never carry `false` forward: an absent leaf is the only way to keep
      // "no decision recorded" representable for migration 105.
      expect(config.memory.v3.live).toBe(false);
      expect(readV3Raw()).toEqual({});
    });

    test("a deleted config with an earlier live-v3 quarantine still carries live=true", () => {
      if (existsSync(CONFIG_PATH)) {
        rmSync(CONFIG_PATH, { force: true });
      }
      writeFileSync(
        join(
          WORKSPACE_DIR,
          "config.json.corrupt-2026-08-01T10-00-00.000Z.json",
        ),
        JSON.stringify({ memory: { v3: { live: true } } }, null, 2),
      );

      const config = loadConfig();

      expect(config.memory.v3.live).toBe(true);
      expect(readV3Raw()).toEqual({ live: true });
    });
  });
});

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-simplified-mem-test-${randomBytes(4).toString("hex")}`,
);
const WORKSPACE_DIR = join(TEST_DIR, "workspace");
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    TEST_DIR,
    WORKSPACE_DIR,
    join(TEST_DIR, "data"),
    join(TEST_DIR, "memory"),
    join(TEST_DIR, "memory", "knowledge"),
    join(TEST_DIR, "logs"),
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

mock.module("../util/platform.js", () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceDir: () => WORKSPACE_DIR,
  getWorkspaceConfigPath: () => CONFIG_PATH,
  getDataDir: () => join(TEST_DIR, "data"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  ensureDataDir: () => ensureTestDir(),
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
}));

import { invalidateConfigCache, loadConfig } from "../config/loader.js";
import { AssistantConfigSchema } from "../config/schema.js";
import { MemorySimplifiedConfigSchema } from "../config/schemas/memory-simplified.js";
import { _setStorePath } from "../security/encrypted-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Tests: MemorySimplifiedConfigSchema (unit)
// ---------------------------------------------------------------------------

describe("MemorySimplifiedConfigSchema", () => {
  test("parses empty object with all defaults", () => {
    const result = MemorySimplifiedConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      brief: { maxTokens: 4000 },
      reducer: { idleDelayMs: 30_000, switchWaitMs: 5_000 },
      archiveRecall: { maxSnippets: 10 },
    });
  });

  test("accepts explicit enabled=true", () => {
    const result = MemorySimplifiedConfigSchema.parse({ enabled: true });
    expect(result.enabled).toBe(true);
  });

  test("accepts custom brief.maxTokens", () => {
    const result = MemorySimplifiedConfigSchema.parse({
      brief: { maxTokens: 8000 },
    });
    expect(result.brief.maxTokens).toBe(8000);
  });

  test("accepts custom reducer values", () => {
    const result = MemorySimplifiedConfigSchema.parse({
      reducer: { idleDelayMs: 60_000, switchWaitMs: 10_000 },
    });
    expect(result.reducer.idleDelayMs).toBe(60_000);
    expect(result.reducer.switchWaitMs).toBe(10_000);
  });

  test("accepts custom archiveRecall.maxSnippets", () => {
    const result = MemorySimplifiedConfigSchema.parse({
      archiveRecall: { maxSnippets: 20 },
    });
    expect(result.archiveRecall.maxSnippets).toBe(20);
  });

  test("rejects non-boolean enabled", () => {
    const result = MemorySimplifiedConfigSchema.safeParse({
      enabled: "yes",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-positive brief.maxTokens", () => {
    const result = MemorySimplifiedConfigSchema.safeParse({
      brief: { maxTokens: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer brief.maxTokens", () => {
    const result = MemorySimplifiedConfigSchema.safeParse({
      brief: { maxTokens: 3.5 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-positive reducer.idleDelayMs", () => {
    const result = MemorySimplifiedConfigSchema.safeParse({
      reducer: { idleDelayMs: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-positive reducer.switchWaitMs", () => {
    const result = MemorySimplifiedConfigSchema.safeParse({
      reducer: { switchWaitMs: -1 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-positive archiveRecall.maxSnippets", () => {
    const result = MemorySimplifiedConfigSchema.safeParse({
      archiveRecall: { maxSnippets: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer archiveRecall.maxSnippets", () => {
    const result = MemorySimplifiedConfigSchema.safeParse({
      archiveRecall: { maxSnippets: 2.5 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Wired into AssistantConfigSchema
// ---------------------------------------------------------------------------

describe("AssistantConfigSchema memory.simplified", () => {
  test("empty config exposes memory.simplified with defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.memory.simplified).toEqual({
      enabled: true,
      brief: { maxTokens: 4000 },
      reducer: { idleDelayMs: 30_000, switchWaitMs: 5_000 },
      archiveRecall: { maxSnippets: 10 },
    });
  });

  test("memory.simplified does not disturb legacy memory config", () => {
    const result = AssistantConfigSchema.parse({});
    // Legacy fields still present with their defaults
    expect(result.memory.enabled).toBe(true);
    expect(result.memory.retrieval).toBeDefined();
    expect(result.memory.jobs).toBeDefined();
    expect(result.memory.cleanup).toBeDefined();
    expect(result.memory.extraction).toBeDefined();
    expect(result.memory.summarization).toBeDefined();
    expect(result.memory.segmentation).toBeDefined();
    expect(result.memory.embeddings).toBeDefined();
    expect(result.memory.qdrant).toBeDefined();
    expect(result.memory.retention).toBeDefined();
  });

  test("accepts memory.simplified overrides alongside legacy config", () => {
    const result = AssistantConfigSchema.parse({
      memory: {
        enabled: true,
        simplified: {
          enabled: true,
          brief: { maxTokens: 6000 },
        },
      },
    });
    expect(result.memory.enabled).toBe(true);
    expect(result.memory.simplified.enabled).toBe(true);
    expect(result.memory.simplified.brief.maxTokens).toBe(6000);
    // Defaults preserved for unset simplified fields
    expect(result.memory.simplified.reducer.idleDelayMs).toBe(30_000);
    expect(result.memory.simplified.archiveRecall.maxSnippets).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadConfig integration (empty config file loads cleanly)
// ---------------------------------------------------------------------------

describe("loadConfig with memory.simplified", () => {
  beforeEach(() => {
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
      join(TEST_DIR, "keys.enc"),
      join(TEST_DIR, "data"),
      join(TEST_DIR, "memory"),
    ];
    for (const path of resetPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    ensureTestDir();
    _setStorePath(join(TEST_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    invalidateConfigCache();
  });

  test("empty config file loads cleanly with simplified defaults", () => {
    writeConfig({});
    const config = loadConfig();
    expect(config.memory.simplified).toEqual({
      enabled: true,
      brief: { maxTokens: 4000 },
      reducer: { idleDelayMs: 30_000, switchWaitMs: 5_000 },
      archiveRecall: { maxSnippets: 10 },
    });
  });

  test("no config file loads cleanly with simplified defaults", () => {
    const config = loadConfig();
    expect(config.memory.simplified).toEqual({
      enabled: true,
      brief: { maxTokens: 4000 },
      reducer: { idleDelayMs: 30_000, switchWaitMs: 5_000 },
      archiveRecall: { maxSnippets: 10 },
    });
  });

  test("existing memory config with simplified addition loads cleanly", () => {
    writeConfig({
      memory: {
        enabled: true,
        simplified: { enabled: true, brief: { maxTokens: 2000 } },
      },
    });
    const config = loadConfig();
    expect(config.memory.enabled).toBe(true);
    expect(config.memory.simplified.enabled).toBe(true);
    expect(config.memory.simplified.brief.maxTokens).toBe(2000);
    expect(config.memory.simplified.reducer.idleDelayMs).toBe(30_000);
  });
});

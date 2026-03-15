import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const TEST_DIR = join(
  tmpdir(),
  `vellum-backfill-test-${randomBytes(4).toString("hex")}`,
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

// Restore all mocked modules after this file's tests complete to prevent
// cross-test contamination when running grouped with other test files.
afterAll(() => {
  mock.restore();
});

import {
  deepMergeMissing,
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
// Tests: deepMergeMissing (unit)
// ---------------------------------------------------------------------------

describe("deepMergeMissing", () => {
  test("adds missing top-level keys", () => {
    const target: Record<string, unknown> = { a: 1 };
    const defaults: Record<string, unknown> = { a: 99, b: 2 };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(true);
    expect(target).toEqual({ a: 1, b: 2 });
  });

  test("does not overwrite existing values", () => {
    const target: Record<string, unknown> = { a: 1, b: "user" };
    const defaults: Record<string, unknown> = { a: 99, b: "default" };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(false);
    expect(target).toEqual({ a: 1, b: "user" });
  });

  test("recursively fills nested objects", () => {
    const target: Record<string, unknown> = {
      nested: { existingKey: "keep" },
    };
    const defaults: Record<string, unknown> = {
      nested: { existingKey: "default", newKey: 42 },
    };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(true);
    expect(target).toEqual({
      nested: { existingKey: "keep", newKey: 42 },
    });
  });

  test("returns false when no changes needed", () => {
    const target: Record<string, unknown> = { a: 1, b: { c: 3 } };
    const defaults: Record<string, unknown> = { a: 99, b: { c: 100 } };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(false);
  });

  test("does not merge arrays", () => {
    const target: Record<string, unknown> = { items: [1, 2] };
    const defaults: Record<string, unknown> = { items: [3, 4, 5] };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(false);
    expect(target).toEqual({ items: [1, 2] });
  });

  test("adds entire missing nested section", () => {
    const target: Record<string, unknown> = {};
    const defaults: Record<string, unknown> = {
      slack: { deliverAuthBypass: false },
    };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(true);
    expect(target).toEqual({ slack: { deliverAuthBypass: false } });
  });
});

// ---------------------------------------------------------------------------
// Tests: startup backfill integration
// ---------------------------------------------------------------------------

describe("config loader backfill", () => {
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

  test("backfills missing schema keys into existing config.json", () => {
    // Write a minimal config that is missing many sections
    writeConfig({ provider: "anthropic", model: "claude-opus-4-6" });

    loadConfig();

    // Re-read the file from disk — it should have been backfilled
    const raw = readConfig();
    // New fields from this PR should be present
    expect(raw.telegram).toBeDefined();
    expect((raw.telegram as Record<string, unknown>).apiBaseUrl).toBe(
      "https://api.telegram.org",
    );
    expect((raw.telegram as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
    expect((raw.telegram as Record<string, unknown>).timeoutMs).toBe(15_000);
    expect((raw.telegram as Record<string, unknown>).maxRetries).toBe(3);
    expect((raw.telegram as Record<string, unknown>).initialBackoffMs).toBe(
      1_000,
    );

    expect(raw.whatsapp).toBeDefined();
    expect((raw.whatsapp as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
    expect((raw.whatsapp as Record<string, unknown>).timeoutMs).toBe(15_000);
    expect((raw.whatsapp as Record<string, unknown>).maxRetries).toBe(3);
    expect((raw.whatsapp as Record<string, unknown>).initialBackoffMs).toBe(
      1_000,
    );

    expect(raw.slack).toBeDefined();
    expect((raw.slack as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
  });

  test("preserves existing user-defined values during backfill", () => {
    writeConfig({
      provider: "openai",
      model: "gpt-4",
      telegram: { botUsername: "mybot", timeoutMs: 30_000 },
      whatsapp: { phoneNumber: "+1234567890" },
    });

    loadConfig();

    const raw = readConfig();
    // User values preserved
    expect(raw.provider).toBe("openai");
    expect(raw.model).toBe("gpt-4");
    expect((raw.telegram as Record<string, unknown>).botUsername).toBe("mybot");
    expect((raw.telegram as Record<string, unknown>).timeoutMs).toBe(30_000);
    expect((raw.whatsapp as Record<string, unknown>).phoneNumber).toBe(
      "+1234567890",
    );

    // Missing fields backfilled
    expect((raw.telegram as Record<string, unknown>).apiBaseUrl).toBe(
      "https://api.telegram.org",
    );
    expect((raw.telegram as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
    expect((raw.whatsapp as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
  });

  test("does not rewrite config.json when no effective change exists", () => {
    // First load: creates config from scratch with all defaults
    loadConfig();
    invalidateConfigCache();

    // Read file and record its content
    const contentBefore = readFileSync(CONFIG_PATH, "utf-8");

    // Second load: file already has all keys — no write expected
    loadConfig();

    const contentAfter = readFileSync(CONFIG_PATH, "utf-8");
    expect(contentAfter).toBe(contentBefore);
  });

  test("does not write dataDir during backfill", () => {
    writeConfig({ provider: "anthropic" });

    loadConfig();

    const raw = readConfig();
    expect(raw.dataDir).toBeUndefined();
  });

  test("backfills new nested fields into existing sections", () => {
    // Config with only the old telegram.botUsername field
    writeConfig({
      telegram: { botUsername: "oldbot" },
    });

    loadConfig();

    const raw = readConfig();
    const telegram = raw.telegram as Record<string, unknown>;
    // Old field preserved
    expect(telegram.botUsername).toBe("oldbot");
    // New fields backfilled
    expect(telegram.apiBaseUrl).toBe("https://api.telegram.org");
    expect(telegram.deliverAuthBypass).toBe(false);
    expect(telegram.timeoutMs).toBe(15_000);
    expect(telegram.maxRetries).toBe(3);
    expect(telegram.initialBackoffMs).toBe(1_000);
  });
});

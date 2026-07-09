/**
 * Recovery ladder for a config.json that fails schema validation even after
 * per-key cleanup. Rather than discarding the user's entire configuration and
 * loading schema defaults, the loader keeps the last-known-good config from
 * this process, or (on first load) salvages the config section-by-section.
 *
 * The invalid configs here use a cleanup-resistant vector: an invalid element
 * inside a schema array field (`tools.exclude`). Per-key cleanup deletes the
 * offending array index, leaving a sparse hole that re-validates as
 * `undefined` and fails again — reliably reaching the recovery ladder.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
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

afterAll(() => {
  mock.restore();
});

import {
  _resetLastKnownGoodConfigForTests,
  invalidateConfigCache,
  loadConfig,
} from "../loader.js";

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * A config whose only defect is a non-string element inside the `tools.exclude`
 * array. Per-key cleanup (`delete arr[i]`) leaves a sparse hole that re-parses
 * as `undefined`, so the strip-and-retry cannot repair it — the recovery ladder
 * is the only way out.
 */
function cleanupResistantToolsSection(): { exclude: unknown[] } {
  return { exclude: ["valid-tool", 123] };
}

describe("config recovery ladder for cleanup-resistant invalid config", () => {
  beforeEach(() => {
    ensureTestDir();
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
    _resetLastKnownGoodConfigForTests();
  });

  afterEach(() => {
    delete process.env.IS_PLATFORM;
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    invalidateConfigCache();
    _resetLastKnownGoodConfigForTests();
  });

  test("keeps the last-known-good config when a later load fails cleanup", () => {
    // First load: a valid config with a distinctive non-default value captures
    // the last-known-good snapshot for this process.
    writeConfig({ maxStepsPerSession: 123 });
    const good = loadConfig();
    expect(good.maxStepsPerSession).toBe(123);

    // Overwrite with a config that survives per-key cleanup poorly and re-load.
    writeConfig({ tools: cleanupResistantToolsSection() });
    invalidateConfigCache();
    const recovered = loadConfig();

    // The distinctive value from the last-known-good config is preserved — the
    // whole config was NOT reset to schema defaults (which would be 50).
    expect(recovered.maxStepsPerSession).toBe(123);
  });

  test("salvages valid sections on first load and defaults only the invalid one", () => {
    // No last-known-good config exists (fresh process). One section is valid
    // and distinctive; another is cleanup-resistant-invalid.
    writeConfig({
      maxStepsPerSession: 123,
      tools: cleanupResistantToolsSection(),
    });

    const config = loadConfig();

    // The valid section survives untouched...
    expect(config.maxStepsPerSession).toBe(123);
    // ...while only the invalid section is reset to its schema default.
    expect(config.tools.exclude).toEqual([]);
  });

  test("a single invalid leaf key falls back to default for that key only", () => {
    // `maxStepsPerSession` is out of range (max 200) but `tools.exclude` is a
    // valid distinctive value. Per-key cleanup strips only the invalid leaf, so
    // the sibling value is preserved and the recovery ladder is never reached.
    writeConfig({ maxStepsPerSession: 9999, tools: { exclude: ["keep-me"] } });

    const config = loadConfig();

    expect(config.maxStepsPerSession).toBe(50);
    expect(config.tools.exclude).toEqual(["keep-me"]);
  });

  test("invalidateConfigCache does not clear the last-known-good safety net", () => {
    writeConfig({ maxStepsPerSession: 77 });
    expect(loadConfig().maxStepsPerSession).toBe(77);

    // A bare cache invalidation must not drop the safety net.
    invalidateConfigCache();
    writeConfig({ tools: cleanupResistantToolsSection() });
    invalidateConfigCache();

    expect(loadConfig().maxStepsPerSession).toBe(77);
  });
});

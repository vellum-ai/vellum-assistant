/**
 * Recovery ladder for a config.json that fails schema validation even after
 * per-key cleanup. Rather than discarding the user's entire configuration and
 * loading schema defaults, the loader keeps the last-known-good config from
 * this process, or (on first load) salvages the config section-by-section.
 *
 * The strip-and-reparse cleanup (including sparse-array compaction) repairs
 * every known real-world config shape, so no config.json fixture reliably
 * reaches the ladder through `loadConfig` — the ladder is defense-in-depth
 * for schema shapes the cleanup does not anticipate. The ladder tests here
 * therefore drive `_recoverFromInvalidConfigForTests` directly, while the
 * file-based tests assert the cleanup's healing behavior end-to-end.
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

afterAll(() => {
  mock.restore();
});

import {
  _recoverFromInvalidConfigForTests,
  _resetLastKnownGoodConfigForTests,
  getConfigReadOnly,
  invalidateConfigCache,
  loadConfig,
} from "../loader.js";

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

/** Write raw bytes to config.json without JSON-stringifying them. */
function writeRawConfig(contents: string): void {
  writeFileSync(CONFIG_PATH, contents);
}

/** A synthetic irreparable-issue set for driving the ladder directly. */
const IRREPARABLE_ISSUES = [
  { path: [] as PropertyKey[], message: "synthetic irreparable issue" },
];

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

  test("keeps the last-known-good config when recovery runs after a good load", () => {
    // A valid load captures the last-known-good snapshot for this process.
    writeConfig({ maxStepsPerSession: 123 });
    expect(loadConfig().maxStepsPerSession).toBe(123);

    // Recovery for an irreparable config returns the snapshot — the whole
    // config is NOT reset to schema defaults (which would be 50).
    const recovered = _recoverFromInvalidConfigForTests(
      {},
      IRREPARABLE_ISSUES,
      [""],
    );
    expect(recovered.maxStepsPerSession).toBe(123);
  });

  test("salvages valid sections on first load and defaults only the invalid one", () => {
    // No last-known-good config exists (fresh process). One section is valid
    // and distinctive; another cannot validate on its own.
    const recovered = _recoverFromInvalidConfigForTests(
      { maxStepsPerSession: 123, tools: "not-an-object" },
      IRREPARABLE_ISSUES,
      ["tools"],
    );

    // The valid section survives untouched...
    expect(recovered.maxStepsPerSession).toBe(123);
    // ...while only the invalid section is reset to its schema default.
    expect(recovered.tools.exclude).toEqual([]);
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

  test("an invalid array element heals in place across a reload — valid siblings and sections survive", () => {
    // A non-string element inside `tools.exclude` is stripped and the array
    // compacted, so the cleaned config re-parses successfully: no recovery
    // rung runs, the valid element survives, and sibling sections keep their
    // values from the file (not from the last-known-good snapshot).
    writeConfig({ maxStepsPerSession: 42 });
    expect(loadConfig().maxStepsPerSession).toBe(42);

    writeConfig({
      maxStepsPerSession: 123,
      tools: { exclude: ["valid-tool", 456] },
    });
    invalidateConfigCache();
    const healed = loadConfig();

    expect(healed.maxStepsPerSession).toBe(123);
    expect(healed.tools.exclude).toEqual(["valid-tool"]);
  });

  test("invalidateConfigCache does not clear the last-known-good safety net", () => {
    writeConfig({ maxStepsPerSession: 77 });
    expect(loadConfig().maxStepsPerSession).toBe(77);

    // A bare cache invalidation must not drop the safety net.
    invalidateConfigCache();

    const recovered = _recoverFromInvalidConfigForTests(
      {},
      IRREPARABLE_ISSUES,
      [""],
    );
    expect(recovered.maxStepsPerSession).toBe(77);
  });

  test("getConfigReadOnly returns schema defaults for a top-level `null` config without throwing", () => {
    // `JSON.parse("null")` is valid JSON, so it reaches validateWithSchema as a
    // non-object top-level value. `loadConfig` quarantines non-object files
    // before validation, so `getConfigReadOnly` (which validates the parsed
    // value directly) is the path that exercises the recovery ladder's
    // non-object guard. It must degrade to schema defaults, not throw on
    // `Object.entries(null)`.
    writeRawConfig("null");

    const config = getConfigReadOnly();

    expect(config.maxStepsPerSession).toBe(50);
    expect(config.tools.exclude).toEqual([]);
  });

  test("getConfigReadOnly returns schema defaults for a top-level array config without throwing", () => {
    writeRawConfig("[]");

    const config = getConfigReadOnly();

    expect(config.maxStepsPerSession).toBe(50);
    expect(config.tools.exclude).toEqual([]);
  });

  test("recovery on a platform daemon returns the context-filled effective config", () => {
    process.env.IS_PLATFORM = "true";

    // First load with no config.json seeds the file and fills the
    // deployment-context managed OAuth service modes in memory; the
    // last-known-good snapshot is refreshed AFTER that fill.
    const seeded = loadConfig();
    expect(seeded.services["outlook-oauth"].mode).toBe("managed");

    // Recovery keeps the last-known-good EFFECTIVE config, so the managed mode
    // survives rather than reverting to the schema default ("your-own").
    const recovered = _recoverFromInvalidConfigForTests(
      {},
      IRREPARABLE_ISSUES,
      [""],
    );
    expect(recovered.services["outlook-oauth"].mode).toBe("managed");
  });
});

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

import { invalidateConfigCache, loadConfig } from "../loader.js";

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

describe("config recovery compacts arrays after stripping invalid elements", () => {
  beforeEach(() => {
    ensureTestDir();
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.IS_PLATFORM;
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    invalidateConfigCache();
  });

  test("one invalid array element is dropped and the valid elements survive", () => {
    // `tools.exclude` is z.array(z.string()); the numeric element is invalid.
    // Stripping it leaves a sparse hole, which re-parse reads as `undefined`
    // and rejects unless the array is compacted first.
    writeConfig({
      tools: { exclude: ["tool-a", 123, "tool-b"] },
      maxStepsPerSession: 77,
    });

    const config = loadConfig();

    expect(config.tools.exclude).toEqual(["tool-a", "tool-b"]);
    // The rest of the config survives — cleanup succeeded, so recovery never
    // reaches the drop-everything fallbacks.
    expect(config.maxStepsPerSession).toBe(77);
  });

  test("multiple invalid elements in one array are all dropped", () => {
    writeConfig({
      tools: { exclude: [1, "tool-a", 2, "tool-b", 3] },
    });

    const config = loadConfig();

    expect(config.tools.exclude).toEqual(["tool-a", "tool-b"]);
  });

  test("an array emptied by stripping all invalid elements reverts to its schema default", () => {
    // `tools.exclude` defaults to `[]`, so a fully-invalid array reverting to
    // the default still resolves to `[]` — but it must not parse-fail, and the
    // rest of the config must survive.
    writeConfig({
      tools: { exclude: [1, 2] },
      maxStepsPerSession: 66,
    });

    const config = loadConfig();

    expect(config.tools.exclude).toEqual([]);
    expect(config.maxStepsPerSession).toBe(66);
  });

  test("emptied-by-compaction array reverts to a non-empty schema default (backup.offsite.destinations)", () => {
    // `backup.offsite.destinations` defaults to `null`, where `null` means "use
    // the iCloud default destination" and `[]` means "no offsite destinations".
    // Stripping the sole invalid element must NOT leave an explicit `[]` that
    // overrides the default — it must fall back to the schema default `null`.
    writeConfig({
      backup: { offsite: { destinations: [123] } },
      maxStepsPerSession: 66,
    });

    const config = loadConfig();

    expect(config.backup.offsite.destinations).toBeNull();
    expect(config.maxStepsPerSession).toBe(66);
  });

  test("emptied-by-compaction array reverts to a non-empty schema default (skills.allowBundled)", () => {
    // `skills.allowBundled` defaults to `null` (load all bundled skills); an
    // explicit `[]` would exclude ALL bundled skills. Stripping every invalid
    // element must revert to the default, not silently disable all skills.
    writeConfig({
      skills: { allowBundled: [1, 2] },
      maxStepsPerSession: 66,
    });

    const config = loadConfig();

    expect(config.skills.allowBundled).toBeNull();
    expect(config.maxStepsPerSession).toBe(66);
  });

  test("an explicitly-empty array on disk is preserved as the user's choice", () => {
    // `backup.offsite.destinations: []` has no invalid elements to strip, so it
    // is never touched by compaction. An unrelated invalid field forces the
    // cleanup path to run over the whole tree; the empty array must survive as
    // the user's explicit "no offsite destinations" choice.
    writeConfig({
      backup: { offsite: { destinations: [] } },
      maxStepsPerSession: "not-a-number",
    });

    const config = loadConfig();

    expect(config.backup.offsite.destinations).toEqual([]);
  });
});

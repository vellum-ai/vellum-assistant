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

  test("a fully-invalid array collapses to empty, not to a parse failure", () => {
    writeConfig({
      tools: { exclude: [1, 2] },
      maxStepsPerSession: 66,
    });

    const config = loadConfig();

    expect(config.tools.exclude).toEqual([]);
    expect(config.maxStepsPerSession).toBe(66);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const existsSyncFn = mock((_path: string): boolean => false);
const readFileSyncFn = mock((_path: string, _encoding: string): string => "");
const writeFileSyncFn = mock((_path: string, _data: string): void => undefined);

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("node:fs", () => ({
  existsSync: existsSyncFn,
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
}));

// Import after mocking
import { extractCollectUsageDataMigration } from "../workspace/migrations/004-extract-collect-usage-data.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/tmp/test-workspace";
const CONFIG_PATH = `${WORKSPACE_DIR}/config.json`;
const FLAG_KEY = "feature_flags.collect-usage-data.enabled";

function setupConfigExists(config: unknown) {
  existsSyncFn.mockImplementation((path: string) => path === CONFIG_PATH);
  readFileSyncFn.mockImplementation(() => JSON.stringify(config));
}

function getWrittenConfig(): Record<string, unknown> {
  expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
  const [path, data] = writeFileSyncFn.mock.calls[0] as [string, string];
  expect(path).toBe(CONFIG_PATH);
  return JSON.parse(data) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("004-extract-collect-usage-data migration", () => {
  beforeEach(() => {
    existsSyncFn.mockClear();
    readFileSyncFn.mockClear();
    writeFileSyncFn.mockClear();
  });

  test("no-op when config.json is absent", () => {
    existsSyncFn.mockImplementation(() => false);

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(readFileSyncFn).not.toHaveBeenCalled();
    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when flag not present in assistantFeatureFlagValues", () => {
    setupConfigExists({
      assistantFeatureFlagValues: {
        "feature_flags.some-other-flag.enabled": true,
      },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("false flag writes collectUsageData: false and removes flag entry", () => {
    setupConfigExists({
      assistantFeatureFlagValues: {
        [FLAG_KEY]: false,
      },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.collectUsageData).toBe(false);
    expect(written.assistantFeatureFlagValues).toBeUndefined();
  });

  test("true flag only removes the flag entry (does not write collectUsageData)", () => {
    setupConfigExists({
      assistantFeatureFlagValues: {
        [FLAG_KEY]: true,
      },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.collectUsageData).toBeUndefined();
    expect(written.assistantFeatureFlagValues).toBeUndefined();
  });

  test("empty assistantFeatureFlagValues is cleaned up after removing flag", () => {
    setupConfigExists({
      someSetting: "value",
      assistantFeatureFlagValues: {
        [FLAG_KEY]: true,
      },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.assistantFeatureFlagValues).toBeUndefined();
    expect(written.someSetting).toBe("value");
  });

  test("other flags in assistantFeatureFlagValues are preserved", () => {
    setupConfigExists({
      assistantFeatureFlagValues: {
        [FLAG_KEY]: false,
        "feature_flags.some-other-flag.enabled": true,
      },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.collectUsageData).toBe(false);
    const remaining = written.assistantFeatureFlagValues as Record<
      string,
      unknown
    >;
    expect(remaining).toEqual({
      "feature_flags.some-other-flag.enabled": true,
    });
    expect(remaining[FLAG_KEY]).toBeUndefined();
  });

  test("malformed config is handled gracefully", () => {
    existsSyncFn.mockImplementation((path: string) => path === CONFIG_PATH);
    readFileSyncFn.mockImplementation(() => "not valid json {{{");

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when config is an array", () => {
    setupConfigExists([1, 2, 3]);

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when assistantFeatureFlagValues is not an object", () => {
    setupConfigExists({
      assistantFeatureFlagValues: "not-an-object",
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when flag value is not a boolean", () => {
    setupConfigExists({
      assistantFeatureFlagValues: {
        [FLAG_KEY]: "string-value",
      },
    });

    extractCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });
});

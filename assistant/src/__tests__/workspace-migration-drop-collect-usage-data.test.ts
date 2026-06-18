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
import { dropCollectUsageDataMigration } from "../workspace/migrations/106-drop-collect-usage-data.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/tmp/test-workspace";
const CONFIG_PATH = `${WORKSPACE_DIR}/config.json`;

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

describe("106-drop-collect-usage-data migration", () => {
  beforeEach(() => {
    existsSyncFn.mockClear();
    readFileSyncFn.mockClear();
    writeFileSyncFn.mockClear();
  });

  test("no-op when config.json is absent", () => {
    existsSyncFn.mockImplementation(() => false);

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(readFileSyncFn).not.toHaveBeenCalled();
    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("explicit opt-out is preserved as legacyTelemetryOptOut", () => {
    setupConfigExists({ collectUsageData: false, someSetting: "value" });

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.collectUsageData).toBeUndefined();
    expect(written.legacyTelemetryOptOut).toBe(true);
    expect(written.someSetting).toBe("value");
  });

  test("collectUsageData: true is removed without setting the marker", () => {
    setupConfigExists({ collectUsageData: true });

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.collectUsageData).toBeUndefined();
    expect(written.legacyTelemetryOptOut).toBeUndefined();
  });

  test("non-false value is removed without setting the marker", () => {
    setupConfigExists({ collectUsageData: "yes" });

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.collectUsageData).toBeUndefined();
    expect(written.legacyTelemetryOptOut).toBeUndefined();
  });

  test("no-op when collectUsageData is absent (no marker)", () => {
    setupConfigExists({ someSetting: "value" });

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("malformed config is handled gracefully", () => {
    existsSyncFn.mockImplementation((path: string) => path === CONFIG_PATH);
    readFileSyncFn.mockImplementation(() => "not valid json {{{");

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when config is an array", () => {
    setupConfigExists([1, 2, 3]);

    dropCollectUsageDataMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });
});

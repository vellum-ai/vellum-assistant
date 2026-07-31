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
import { dropSendDiagnosticsMigration } from "../workspace/migrations/107-drop-send-diagnostics.js";

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

describe("107-drop-send-diagnostics migration", () => {
  beforeEach(() => {
    existsSyncFn.mockClear();
    readFileSyncFn.mockClear();
    writeFileSyncFn.mockClear();
  });

  test("no-op when config.json is absent", () => {
    existsSyncFn.mockImplementation(() => false);

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(readFileSyncFn).not.toHaveBeenCalled();
    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("explicit opt-out is preserved as legacyDiagnosticsOptOut", () => {
    setupConfigExists({ sendDiagnostics: false, someSetting: "value" });

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.sendDiagnostics).toBeUndefined();
    expect(written.legacyDiagnosticsOptOut).toBe(true);
    expect(written.someSetting).toBe("value");
  });

  test("sendDiagnostics: true is removed without setting the marker", () => {
    setupConfigExists({ sendDiagnostics: true });

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.sendDiagnostics).toBeUndefined();
    expect(written.legacyDiagnosticsOptOut).toBeUndefined();
  });

  test("non-false value is removed without setting the marker", () => {
    setupConfigExists({ sendDiagnostics: "yes" });

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    const written = getWrittenConfig();
    expect(written.sendDiagnostics).toBeUndefined();
    expect(written.legacyDiagnosticsOptOut).toBeUndefined();
  });

  test("no-op when sendDiagnostics is absent (no marker)", () => {
    setupConfigExists({ someSetting: "value" });

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("malformed config is handled gracefully", () => {
    existsSyncFn.mockImplementation((path: string) => path === CONFIG_PATH);
    readFileSyncFn.mockImplementation(() => "not valid json {{{");

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when config is an array", () => {
    setupConfigExists([1, 2, 3]);

    dropSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });
});

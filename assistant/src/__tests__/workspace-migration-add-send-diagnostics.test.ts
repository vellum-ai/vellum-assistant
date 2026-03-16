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
import { addSendDiagnosticsMigration } from "../workspace/migrations/005-add-send-diagnostics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/tmp/test-workspace";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("005-add-send-diagnostics migration", () => {
  beforeEach(() => {
    existsSyncFn.mockClear();
    readFileSyncFn.mockClear();
    writeFileSyncFn.mockClear();
  });

  test("runs without error when config.json is absent", () => {
    existsSyncFn.mockImplementation(() => false);

    addSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("runs without error on existing config (no-op)", () => {
    existsSyncFn.mockImplementation(() => true);
    readFileSyncFn.mockImplementation(() =>
      JSON.stringify({ collectUsageData: true }),
    );

    addSendDiagnosticsMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });
});

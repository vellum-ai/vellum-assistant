import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const existsSyncFn = mock((_path: string): boolean => false);
const readFileSyncFn = mock((_path: string, _enc: string): string => "");
const writeFileSyncFn = mock((_path: string, _data: string): void => undefined);
const randomUUIDFn = mock((): string => "generated-uuid-1234");
const getMemoryCheckpointFn = mock((_key: string): string | null => null);
const deleteMemoryCheckpointFn = mock((_key: string): void => undefined);
const getExternalAssistantIdFn = mock((): string | undefined => "my-assistant");
const homedirFn = mock((): string => "/mock-home");

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("node:fs", () => ({
  existsSync: existsSyncFn,
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
}));

mock.module("node:crypto", () => ({
  randomUUID: randomUUIDFn,
}));

mock.module("node:os", () => ({
  homedir: homedirFn,
}));

mock.module("../memory/checkpoints.js", () => ({
  getMemoryCheckpoint: getMemoryCheckpointFn,
  deleteMemoryCheckpoint: deleteMemoryCheckpointFn,
}));

mock.module("../runtime/auth/external-assistant-id.js", () => ({
  getExternalAssistantId: getExternalAssistantIdFn,
}));

// Import after mocking
import { backfillInstallationIdMigration } from "../workspace/migrations/011-backfill-installation-id.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "/mock-home";
const LOCK_PATH = `${BASE}/.vellum.lock.json`;
const LEGACY_LOCK_PATH = `${BASE}/.vellum.lockfile.json`;
const WORKSPACE_DIR = `${BASE}/.vellum/workspace`;

function makeLockfile(assistants: Array<Record<string, unknown>>): string {
  return JSON.stringify({ assistants });
}

function setupFs(fileContents: Record<string, string>): void {
  existsSyncFn.mockImplementation((path: string) => path in fileContents);
  readFileSyncFn.mockImplementation((path: string, _enc: string) => {
    if (path in fileContents) return fileContents[path];
    throw new Error(`ENOENT: ${path}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("011-backfill-installation-id migration", () => {
  beforeEach(() => {
    existsSyncFn.mockClear();
    readFileSyncFn.mockClear();
    writeFileSyncFn.mockClear();
    randomUUIDFn.mockClear();
    getMemoryCheckpointFn.mockClear();
    deleteMemoryCheckpointFn.mockClear();
    getExternalAssistantIdFn.mockClear();
    homedirFn.mockClear();

    // Defaults
    homedirFn.mockReturnValue("/mock-home");
    getExternalAssistantIdFn.mockReturnValue("my-assistant");
    getMemoryCheckpointFn.mockReturnValue(null);
    randomUUIDFn.mockReturnValue("generated-uuid-1234");
    delete process.env.BASE_DATA_DIR;
  });

  test("no-op when no lockfile exists", () => {
    setupFs({});

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when lockfile has no assistants array", () => {
    setupFs({
      [LOCK_PATH]: JSON.stringify({ version: 1 }),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when lockfile is malformed JSON", () => {
    setupFs({
      [LOCK_PATH]: "{{not json",
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when lockfile is an array", () => {
    setupFs({
      [LOCK_PATH]: JSON.stringify([1, 2, 3]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when no matching assistant entry found", () => {
    getExternalAssistantIdFn.mockReturnValue("my-assistant");
    setupFs({
      [LOCK_PATH]: makeLockfile([
        { assistantId: "other-assistant", installationId: undefined },
      ]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("backfills installationId from SQLite checkpoint", () => {
    getMemoryCheckpointFn.mockReturnValue("sqlite-install-id");
    setupFs({
      [LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [path, data] = writeFileSyncFn.mock.calls[0] as [string, string];
    expect(path).toBe(LOCK_PATH);
    const parsed = JSON.parse(data);
    expect(parsed.assistants[0].installationId).toBe("sqlite-install-id");
  });

  test("generates new UUID when no SQLite checkpoint exists", () => {
    getMemoryCheckpointFn.mockReturnValue(null);
    randomUUIDFn.mockReturnValue("new-uuid-5678");
    setupFs({
      [LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string];
    const parsed = JSON.parse(data);
    expect(parsed.assistants[0].installationId).toBe("new-uuid-5678");
  });

  test("generates new UUID when SQLite table does not exist", () => {
    getMemoryCheckpointFn.mockImplementation(() => {
      throw new Error("no such table: memory_checkpoints");
    });
    randomUUIDFn.mockReturnValue("fallback-uuid");
    setupFs({
      [LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string];
    const parsed = JSON.parse(data);
    expect(parsed.assistants[0].installationId).toBe("fallback-uuid");
  });

  test("skips lockfile write when entry already has installationId", () => {
    setupFs({
      [LOCK_PATH]: makeLockfile([
        { assistantId: "my-assistant", installationId: "existing-id" },
      ]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("cleans up SQLite checkpoint when entry already has installationId", () => {
    setupFs({
      [LOCK_PATH]: makeLockfile([
        { assistantId: "my-assistant", installationId: "existing-id" },
      ]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(deleteMemoryCheckpointFn).toHaveBeenCalledWith(
      "telemetry:installation_id",
    );
  });

  test("cleans up SQLite checkpoint after writing lockfile", () => {
    getMemoryCheckpointFn.mockReturnValue("sqlite-id");
    setupFs({
      [LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    expect(deleteMemoryCheckpointFn).toHaveBeenCalledWith(
      "telemetry:installation_id",
    );
  });

  test("handles deleteMemoryCheckpoint throwing gracefully", () => {
    deleteMemoryCheckpointFn.mockImplementation(() => {
      throw new Error("no such table");
    });
    setupFs({
      [LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    // Should not throw
    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
  });

  test("reads from legacy .vellum.lockfile.json when primary is absent", () => {
    getMemoryCheckpointFn.mockReturnValue("sqlite-id");
    setupFs({
      [LEGACY_LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [path, data] = writeFileSyncFn.mock.calls[0] as [string, string];
    expect(path).toBe(LEGACY_LOCK_PATH);
    const parsed = JSON.parse(data);
    expect(parsed.assistants[0].installationId).toBe("sqlite-id");
  });

  test("prefers primary lockfile over legacy when both exist", () => {
    getMemoryCheckpointFn.mockReturnValue("sqlite-id");
    setupFs({
      [LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
      [LEGACY_LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [path] = writeFileSyncFn.mock.calls[0] as [string, string];
    expect(path).toBe(LOCK_PATH);
  });

  test("falls through to legacy lockfile when primary is malformed", () => {
    getMemoryCheckpointFn.mockReturnValue("sqlite-id");
    setupFs({
      [LOCK_PATH]: "{{not json",
      [LEGACY_LOCK_PATH]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [path, data] = writeFileSyncFn.mock.calls[0] as [string, string];
    expect(path).toBe(LEGACY_LOCK_PATH);
    const parsed = JSON.parse(data);
    expect(parsed.assistants[0].installationId).toBe("sqlite-id");
  });

  test("respects BASE_DATA_DIR environment variable", () => {
    process.env.BASE_DATA_DIR = "/custom-base";
    getMemoryCheckpointFn.mockReturnValue("sqlite-id");

    const customLockPath = "/custom-base/.vellum.lock.json";
    setupFs({
      [customLockPath]: makeLockfile([{ assistantId: "my-assistant" }]),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [path] = writeFileSyncFn.mock.calls[0] as [string, string];
    expect(path).toBe(customLockPath);
  });

  test("preserves other assistants in lockfile when writing", () => {
    getMemoryCheckpointFn.mockReturnValue("sqlite-id");
    setupFs({
      [LOCK_PATH]: JSON.stringify({
        assistants: [
          { assistantId: "other-assistant", installationId: "other-id" },
          { assistantId: "my-assistant" },
        ],
      }),
    });

    backfillInstallationIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string];
    const parsed = JSON.parse(data);
    expect(parsed.assistants[0].installationId).toBe("other-id");
    expect(parsed.assistants[1].installationId).toBe("sqlite-id");
  });

  test("has migration id 011-backfill-installation-id", () => {
    expect(backfillInstallationIdMigration.id).toBe(
      "011-backfill-installation-id",
    );
  });
});

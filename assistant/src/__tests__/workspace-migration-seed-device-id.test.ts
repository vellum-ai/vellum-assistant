import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const existsSyncFn = mock((_path: string): boolean => false);
const readFileSyncFn = mock((_path: string, _enc: string): string => "");
const writeFileSyncFn = mock(
  (_path: string, _data: string, _opts?: object) => {},
);
const mkdirSyncFn = mock((_path: string, _opts?: object) => {});
const getDeviceIdBaseDirFn = mock((): string => "/mock-home");

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("node:fs", () => ({
  existsSync: existsSyncFn,
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  mkdirSync: mkdirSyncFn,
}));

mock.module("../util/device-id.js", () => ({
  getDeviceIdBaseDir: getDeviceIdBaseDirFn,
}));

// Import after mocking
import { seedDeviceIdMigration } from "../workspace/migrations/003-seed-device-id.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "/mock-home";
const VELLUM_DIR = `${BASE}/.vellum`;
const DEVICE_PATH = `${VELLUM_DIR}/device.json`;
const LOCK_PATH = `${BASE}/.vellum.lock.json`;
const LEGACY_LOCK_PATH = `${BASE}/.vellum.lockfile.json`;
const WORKSPACE_DIR = `${VELLUM_DIR}/workspace`;

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

describe("003-seed-device-id migration", () => {
  beforeEach(() => {
    existsSyncFn.mockClear();
    readFileSyncFn.mockClear();
    writeFileSyncFn.mockClear();
    mkdirSyncFn.mockClear();
    getDeviceIdBaseDirFn.mockReturnValue("/mock-home");
  });

  test("no-op when device.json already has a deviceId", () => {
    setupFs({
      [DEVICE_PATH]: JSON.stringify({ deviceId: "existing-id" }),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when no lockfile exists", () => {
    setupFs({});

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when lockfile has no assistants array", () => {
    setupFs({
      [LOCK_PATH]: JSON.stringify({ version: 1 }),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when assistants have no installationId", () => {
    setupFs({
      [LOCK_PATH]: makeLockfile([
        { name: "alice", hatchedAt: "2025-01-01T00:00:00Z" },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).not.toHaveBeenCalled();
  });

  test("seeds deviceId from lockfile installationId", () => {
    setupFs({
      [LOCK_PATH]: makeLockfile([
        {
          name: "alice",
          installationId: "install-abc",
          hatchedAt: "2025-01-01T00:00:00Z",
        },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [path, data] = writeFileSyncFn.mock.calls[0] as [
      string,
      string,
      object,
    ];
    expect(path).toBe(DEVICE_PATH);
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-abc");
  });

  test("picks the most recently hatched installationId", () => {
    setupFs({
      [LOCK_PATH]: makeLockfile([
        {
          name: "old",
          installationId: "install-old",
          hatchedAt: "2024-06-01T00:00:00Z",
        },
        {
          name: "new",
          installationId: "install-new",
          hatchedAt: "2025-03-01T00:00:00Z",
        },
        {
          name: "mid",
          installationId: "install-mid",
          hatchedAt: "2025-01-01T00:00:00Z",
        },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string, object];
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-new");
  });

  test("reads from legacy .vellum.lockfile.json when primary is absent", () => {
    setupFs({
      [LEGACY_LOCK_PATH]: makeLockfile([
        {
          name: "legacy",
          installationId: "install-legacy",
          hatchedAt: "2025-01-01T00:00:00Z",
        },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string, object];
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-legacy");
  });

  test("prefers primary lockfile over legacy when both exist", () => {
    setupFs({
      [LOCK_PATH]: makeLockfile([
        {
          name: "primary",
          installationId: "install-primary",
          hatchedAt: "2025-01-01T00:00:00Z",
        },
      ]),
      [LEGACY_LOCK_PATH]: makeLockfile([
        {
          name: "legacy",
          installationId: "install-legacy",
          hatchedAt: "2025-06-01T00:00:00Z",
        },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string, object];
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-primary");
  });

  test("preserves existing fields in device.json when seeding", () => {
    setupFs({
      [DEVICE_PATH]: JSON.stringify({ someOtherField: "keep-me" }),
      [LOCK_PATH]: makeLockfile([
        {
          name: "alice",
          installationId: "install-abc",
          hatchedAt: "2025-01-01T00:00:00Z",
        },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string, object];
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-abc");
    expect(parsed.someOtherField).toBe("keep-me");
  });

  test("falls through when device.json is malformed", () => {
    setupFs({
      [DEVICE_PATH]: "{{not json",
      [LOCK_PATH]: makeLockfile([
        {
          name: "alice",
          installationId: "install-abc",
          hatchedAt: "2025-01-01T00:00:00Z",
        },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string, object];
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-abc");
  });

  test("falls through to legacy lockfile when primary is malformed", () => {
    setupFs({
      [LOCK_PATH]: "{{not json",
      [LEGACY_LOCK_PATH]: makeLockfile([
        {
          name: "legacy",
          installationId: "install-legacy",
          hatchedAt: "2025-01-01T00:00:00Z",
        },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string, object];
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-legacy");
  });

  test("respects BASE_DATA_DIR override via getDeviceIdBaseDir", () => {
    const customBase = "/custom-base";
    getDeviceIdBaseDirFn.mockReturnValue(customBase);

    const customLockPath = `${customBase}/.vellum.lock.json`;
    const customDevicePath = `${customBase}/.vellum/device.json`;

    existsSyncFn.mockImplementation((path: string) => path === customLockPath);
    readFileSyncFn.mockImplementation((path: string, _enc: string) => {
      if (path === customLockPath) {
        return makeLockfile([
          {
            name: "custom",
            installationId: "install-custom",
            hatchedAt: "2025-01-01T00:00:00Z",
          },
        ]);
      }
      throw new Error(`ENOENT: ${path}`);
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [path, data] = writeFileSyncFn.mock.calls[0] as [
      string,
      string,
      object,
    ];
    expect(path).toBe(customDevicePath);
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-custom");
  });

  test("entries without hatchedAt are treated as oldest", () => {
    setupFs({
      [LOCK_PATH]: makeLockfile([
        {
          name: "no-date",
          installationId: "install-no-date",
        },
        {
          name: "with-date",
          installationId: "install-dated",
          hatchedAt: "2025-01-01T00:00:00Z",
        },
      ]),
    });

    seedDeviceIdMigration.run(WORKSPACE_DIR);

    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const [, data] = writeFileSyncFn.mock.calls[0] as [string, string, object];
    const parsed = JSON.parse(data);
    expect(parsed.deviceId).toBe("install-dated");
  });
});

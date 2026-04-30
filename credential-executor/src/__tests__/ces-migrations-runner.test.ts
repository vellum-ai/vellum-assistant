import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import type { CesMigration } from "../migrations/types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockFileExists = false;
let mockFileContents: string | null = null;
let useMocks = true;

const existsSyncFn = mock((_path: string): boolean => mockFileExists);
const mkdirSyncFn = mock((): void => {});
const readFileSyncFn = mock((): string => {
  if (mockFileContents === null) {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }
  return mockFileContents;
});
const writeFileSyncFn = mock((): void => {});
const renameSyncFn = mock((): void => {});
const logWarnFn = mock((): void => {});
const logInfoFn = mock((): void => {});
const logErrorFn = mock((..._args: unknown[]): void => {});

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
//
// mock.module is process-global in bun. To avoid poisoning other test files,
// each overridden function delegates to a real implementation (captured via
// require() before mocking) once `useMocks` is flipped false in afterAll.
// All other node:fs exports are forwarded unchanged.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const _realFs = require("node:fs");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

mock.module("node:fs", () => {
  const proxy: Record<string, unknown> = {};
  // Forward every export from the real module.
  for (const key of Object.keys(_realFs)) {
    proxy[key] = _realFs[key];
  }
  // Override only the five functions the migration runner uses.
  proxy.existsSync = (...a: unknown[]) =>
    useMocks ? existsSyncFn(a[0] as string) : _realFs.existsSync(...a);
  proxy.mkdirSync = (...a: unknown[]) =>
    useMocks ? mkdirSyncFn(...a) : _realFs.mkdirSync(...a);
  proxy.readFileSync = (...a: unknown[]) =>
    useMocks ? readFileSyncFn(...a) : _realFs.readFileSync(...a);
  proxy.writeFileSync = (...a: unknown[]) =>
    useMocks ? writeFileSyncFn(...a) : _realFs.writeFileSync(...a);
  proxy.renameSync = (...a: unknown[]) =>
    useMocks ? renameSyncFn(...a) : _realFs.renameSync(...a);
  return proxy;
});

// Intercept pino at the package level (same technique as workspace-migrations-runner.test.ts)
// so that the lazy proxy in getLogger() returns our mock child logger.
const mockChildLogger = {
  debug: (): void => {},
  info: logInfoFn,
  warn: logWarnFn,
  error: logErrorFn,
  child: () => mockChildLogger,
};
const mockPinoLogger = Object.assign(() => mockChildLogger, {
  destination: () => ({}),
  multistream: () => ({}),
});
mock.module("pino", () => ({ default: mockPinoLogger }));
mock.module("pino-pretty", () => ({ default: (): object => ({}) }));

// Import after mocking
import { runCesMigrations } from "../migrations/runner.js";

// ---------------------------------------------------------------------------
// Restore real behavior after all tests so other files aren't poisoned.
// ---------------------------------------------------------------------------
afterAll(() => {
  useMocks = false;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CES_DATA_ROOT = "/tmp/test-ces";

function makeBackend(): SecureKeyBackend {
  return {
    get: mock(() => Promise.resolve(undefined)),
    set: mock(() => Promise.resolve(true)),
    delete: mock(() => Promise.resolve({ deleted: true })),
    list: mock(() => Promise.resolve([])),
  } as unknown as SecureKeyBackend;
}

function makeMigration(id: string): CesMigration {
  return {
    id,
    description: `Migration ${id}`,
    run: mock((): void => {}),
    down: mock((): void => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCesMigrations", () => {
  beforeEach(() => {
    mockFileExists = false;
    mockFileContents = null;
    existsSyncFn.mockClear();
    mkdirSyncFn.mockClear();
    readFileSyncFn.mockClear();
    writeFileSyncFn.mockClear();
    renameSyncFn.mockClear();
    logWarnFn.mockClear();
    logInfoFn.mockClear();
    logErrorFn.mockClear();
  });

  test("fresh install — no checkpoint file — runs all migrations", async () => {
    const backend = makeBackend();
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    await runCesMigrations(CES_DATA_ROOT, backend, [m1, m2]);

    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(m2.run).toHaveBeenCalledTimes(1);
    expect(m1.run).toHaveBeenCalledWith(backend);
  });

  test("already-completed migration is skipped", async () => {
    mockFileExists = true;
    mockFileContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z", status: "completed" },
      },
    });
    const backend = makeBackend();
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");

    await runCesMigrations(CES_DATA_ROOT, backend, [m1, m2]);

    expect(m1.run).not.toHaveBeenCalled();
    expect(m2.run).toHaveBeenCalledTimes(1);
  });

  test("interrupted migration (started status) is re-run", async () => {
    mockFileExists = true;
    mockFileContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z", status: "started" },
      },
    });
    const backend = makeBackend();
    const m1 = makeMigration("001");

    await runCesMigrations(CES_DATA_ROOT, backend, [m1]);

    expect(m1.run).toHaveBeenCalledTimes(1);
    expect(logWarnFn).toHaveBeenCalled();
  });

  test("failed migration is NOT re-run", async () => {
    mockFileExists = true;
    mockFileContents = JSON.stringify({
      applied: {
        "001": { appliedAt: "2025-01-01T00:00:00.000Z", status: "failed" },
      },
    });
    const backend = makeBackend();
    const m1 = makeMigration("001");

    await runCesMigrations(CES_DATA_ROOT, backend, [m1]);

    expect(m1.run).not.toHaveBeenCalled();
  });

  test("duplicate migration IDs throw at startup", async () => {
    const backend = makeBackend();
    const m1 = makeMigration("001");
    const m2 = makeMigration("001");

    await expect(
      runCesMigrations(CES_DATA_ROOT, backend, [m1, m2]),
    ).rejects.toThrow('Duplicate CES migration id: "001"');

    expect(m1.run).not.toHaveBeenCalled();
  });

  test("migration that throws is marked failed and startup continues", async () => {
    const backend = makeBackend();
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    (m1.run as ReturnType<typeof mock>).mockImplementation((): never => {
      throw new Error("m1 blew up");
    });

    await runCesMigrations(CES_DATA_ROOT, backend, [m1, m2]);

    // m2 should still run after m1's failure
    expect(m2.run).toHaveBeenCalledTimes(1);
    // error was logged
    expect(logErrorFn).toHaveBeenCalled();

    // Checkpoint writes: started m1, failed m1, started m2, completed m2 = 4
    expect(writeFileSyncFn).toHaveBeenCalledTimes(4);
    const failedWrite = (writeFileSyncFn.mock.calls[1] as unknown[])[1] as string;
    const failedParsed = JSON.parse(failedWrite);
    expect(failedParsed.applied["001"].status).toBe("failed");
  });
});

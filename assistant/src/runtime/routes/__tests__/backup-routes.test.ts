/**
 * Unit tests for the /v1/backups HTTP route handlers.
 *
 * These tests drive the handler functions directly (bypassing the router)
 * so they exercise the handler logic — input validation, path containment,
 * key-loading, and error mapping — without needing a live HTTP server.
 *
 * Module-level mocks replace the real `config/loader`, `memory/checkpoints`,
 * `backup/backup-worker`, `backup/restore`, and `backup/backup-key` modules
 * with test doubles. Each test shapes the doubles through the `setMockXxx`
 * helpers in the setup/teardown block.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { BackupRunResult } from "../../../backup/backup-worker.js";
import type { SnapshotEntry } from "../../../backup/list-snapshots.js";
import type { RestoreResult, VerifyResult } from "../../../backup/restore.js";
import type { BackupConfig } from "../../../config/schema.js";
import { BackupConfigSchema } from "../../../config/schema.js";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the module under test
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// -- listSnapshotsInDir spy ------------------------------------------------
// Wraps the real implementation so tests can assert on which directories
// were enumerated. Needed to verify handleBackupList skips offsite
// enumeration when backup.offsite.enabled is false.

const listSnapshotsCallLog: string[] = [];
const { listSnapshotsInDir: realListSnapshotsInDir } = await import(
  "../../../backup/list-snapshots.js"
);
mock.module("../../../backup/list-snapshots.js", () => ({
  listSnapshotsInDir: async (dir: string) => {
    listSnapshotsCallLog.push(dir);
    return realListSnapshotsInDir(dir);
  },
}));

// -- Config mock -----------------------------------------------------------
// Built in `beforeEach` from BackupConfigSchema defaults, with overrides
// applied per test via `setMockBackupConfig`.

let mockBackupConfig: BackupConfig = BackupConfigSchema.parse({});
let mockWorkspaceDir = "/tmp/mock-workspace-unused";

let mockInvalidateConfigCacheCalls = 0;

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    backup: mockBackupConfig,
    // The handlers only touch `.backup`, but getConfig() is typed as returning
    // the full AssistantConfig. Cast through `unknown` so the partial shape is
    // accepted without pulling in the full config schema.
  }),
  invalidateConfigCache: () => {
    mockInvalidateConfigCacheCalls += 1;
    recoveryCallOrder.push("invalidateConfigCache");
  },
}));

// -- DB + trust-cache mocks ------------------------------------------------
// handleBackupRestore must call `resetDb()` BEFORE `restoreFromSnapshot` and
// `invalidateConfigCache()` + `clearTrustCache()` AFTER (matching the
// migration importer). Tests record the call sequence via
// `recoveryCallOrder` and assert on the relative ordering.

let mockResetDbCalls = 0;
let mockClearTrustCacheCalls = 0;
const recoveryCallOrder: string[] = [];

mock.module("../../../memory/db-connection.js", () => ({
  resetDb: () => {
    mockResetDbCalls += 1;
    recoveryCallOrder.push("resetDb");
  },
}));

mock.module("../../../permissions/trust-store.js", () => ({
  clearCache: () => {
    mockClearTrustCacheCalls += 1;
    recoveryCallOrder.push("clearTrustCache");
  },
}));

// -- Platform paths mock ---------------------------------------------------
// `getWorkspaceDir` / `getWorkspaceHooksDir` are used inside the restore
// handler to build a DefaultPathResolver. Return test-friendly paths so
// restore tests don't pollute the real workspace.

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
  getWorkspaceHooksDir: () => join(mockWorkspaceDir, "hooks"),
  // Passed through when tests need the protected dir (e.g. via paths.ts).
  getProtectedDir: () => join(mockWorkspaceDir, "protected"),
  getDbPath: () => join(mockWorkspaceDir, "data", "db", "assistant.db"),
}));

// -- Memory checkpoint mock ------------------------------------------------

const mockCheckpointStore: Record<string, string | null> = {};

mock.module("../../../memory/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => mockCheckpointStore[key] ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    mockCheckpointStore[key] = value;
  },
}));

// -- Backup key mock -------------------------------------------------------
// Tests override this via `setMockBackupKey` / `setMockBackupKeyMissing`.
// The mock also records how many times the key was read so tests can assert
// "key file was never touched" for plaintext-only code paths.

let mockBackupKey: Buffer | null = Buffer.alloc(32, 0xaa);
let mockReadBackupKeyCalls = 0;

mock.module("../../../backup/backup-key.js", () => ({
  readBackupKey: async (_path: string) => {
    mockReadBackupKeyCalls += 1;
    return mockBackupKey;
  },
  ensureBackupKey: async (_path: string) => mockBackupKey ?? Buffer.alloc(32),
}));

// -- Backup worker mock ----------------------------------------------------
// `createSnapshotNow` is replaced so tests can control success / 409
// behavior without touching the real export pipeline.

let mockCreateSnapshotResult: BackupRunResult | null = null;
let mockCreateSnapshotError: Error | null = null;
let mockCreateSnapshotCalls = 0;

mock.module("../../../backup/backup-worker.js", () => ({
  createSnapshotNow: async (_config: BackupConfig, _now: Date) => {
    mockCreateSnapshotCalls += 1;
    if (mockCreateSnapshotError) throw mockCreateSnapshotError;
    if (mockCreateSnapshotResult == null) {
      throw new Error("Test forgot to set mockCreateSnapshotResult");
    }
    return mockCreateSnapshotResult;
  },
}));

// -- Restore module mock ---------------------------------------------------
// Both `restoreFromSnapshot` and `verifySnapshot` are replaced. Tests
// inspect `lastRestoreArgs` / `lastVerifyArgs` to assert the handler
// forwarded the correct key and options.

interface RestoreCall {
  path: string;
  hasKey: boolean;
  workspaceDir: string | undefined;
}
interface VerifyCall {
  path: string;
  hasKey: boolean;
}

let lastRestoreArgs: RestoreCall | null = null;
let lastVerifyArgs: VerifyCall | null = null;
let mockRestoreResult: RestoreResult = {
  manifest: {
    schema_version: "1.0",
    created_at: "2026-04-11T10:00:00.000Z",
    files: [],
    manifest_sha256: "0".repeat(64),
  } as unknown as RestoreResult["manifest"],
  restoredFiles: 0,
};
let mockRestoreError: Error | null = null;
let mockVerifyResult: VerifyResult = { valid: true };

mock.module("../../../backup/restore.js", () => ({
  restoreFromSnapshot: async (
    path: string,
    opts: {
      key?: Buffer;
      workspaceDir?: string;
    },
  ) => {
    recoveryCallOrder.push("restoreFromSnapshot");
    lastRestoreArgs = {
      path,
      hasKey: opts.key != null,
      workspaceDir: opts.workspaceDir,
    };
    if (mockRestoreError) throw mockRestoreError;
    return mockRestoreResult;
  },
  verifySnapshot: async (path: string, opts: { key?: Buffer }) => {
    lastVerifyArgs = { path, hasKey: opts.key != null };
    return mockVerifyResult;
  },
}));

// ---------------------------------------------------------------------------
// Import under test — after mocks
// ---------------------------------------------------------------------------

import {
  backupRouteDefinitions,
  handleBackupCreate,
  handleBackupList,
  handleBackupRestore,
  handleBackupVerify,
} from "../backup-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ROOT: string;
let LOCAL_DIR: string;

/** Build a valid BackupConfig with overrides applied via spread. */
function makeConfig(overrides: Partial<BackupConfig> = {}): BackupConfig {
  const base = BackupConfigSchema.parse({});
  return { ...base, ...overrides };
}

/** Write a backup-shaped file to disk so `listSnapshotsInDir` picks it up. */
function writeBackupFile(
  dir: string,
  filename: string,
  payload: string = "fake-bundle",
): string {
  mkdirSync(dir, { recursive: true });
  const fullPath = join(dir, filename);
  writeFileSync(fullPath, payload);
  return fullPath;
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/v1/backups", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "vellum-backup-routes-"));
  LOCAL_DIR = join(ROOT, "local");
  // Reset mocks to defaults
  mockBackupConfig = makeConfig({ localDirectory: LOCAL_DIR });
  mockWorkspaceDir = join(ROOT, "workspace");
  for (const key of Object.keys(mockCheckpointStore)) {
    delete mockCheckpointStore[key];
  }
  mockBackupKey = Buffer.alloc(32, 0xaa);
  mockReadBackupKeyCalls = 0;
  mockCreateSnapshotResult = null;
  mockCreateSnapshotError = null;
  mockCreateSnapshotCalls = 0;
  lastRestoreArgs = null;
  lastVerifyArgs = null;
  mockRestoreError = null;
  mockRestoreResult = {
    manifest: {
      schema_version: "1.0",
      created_at: "2026-04-11T10:00:00.000Z",
      files: [],
      manifest_sha256: "0".repeat(64),
    } as unknown as RestoreResult["manifest"],
    restoredFiles: 0,
  };
  mockVerifyResult = { valid: true };
  mockResetDbCalls = 0;
  mockInvalidateConfigCacheCalls = 0;
  mockClearTrustCacheCalls = 0;
  recoveryCallOrder.length = 0;
  listSnapshotsCallLog.length = 0;
});

afterEach(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// handleBackupList
// ---------------------------------------------------------------------------

describe("handleBackupList", () => {
  test("empty workspace: returns empty local array and one unreachable iCloud default", async () => {
    // Use default offsite destinations (null) so the iCloud default kicks in.
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: {
        enabled: true,
        destinations: null,
      },
    });

    const res = await handleBackupList(new Request("http://localhost/v1/backups"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      local: SnapshotEntry[];
      offsite: Array<{
        destination: { path: string; encrypt: boolean };
        snapshots: SnapshotEntry[];
        reachable: boolean;
      }>;
      nextRunAt: string | null;
    };
    expect(body.local).toEqual([]);
    // iCloud default is present as a single destination. Whether it's
    // reachable depends on whether the CI agent has iCloud Drive enabled —
    // we only assert its presence and shape, not `reachable`.
    expect(body.offsite).toHaveLength(1);
    expect(body.offsite[0].destination.encrypt).toBe(true);
    expect(body.offsite[0].snapshots).toEqual([]);
    expect(typeof body.offsite[0].reachable).toBe("boolean");
    expect(body.nextRunAt).toBeNull();
  });

  test("two local files: returned newest-first", async () => {
    writeBackupFile(LOCAL_DIR, "backup-20260411-100000.vbundle");
    writeBackupFile(LOCAL_DIR, "backup-20260411-120000.vbundle");
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupList(new Request("http://localhost/v1/backups"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      local: SnapshotEntry[];
      offsite: Array<unknown>;
    };
    expect(body.local).toHaveLength(2);
    expect(body.local[0].filename).toBe("backup-20260411-120000.vbundle");
    expect(body.local[1].filename).toBe("backup-20260411-100000.vbundle");
    expect(body.offsite).toEqual([]);
  });

  test("two offsite destinations: reachable + unreachable reflected per-entry", async () => {
    const reachableDir = join(ROOT, "offsite-reachable");
    const unreachableDir = join(ROOT, "nope", "deeper", "backups");
    mkdirSync(reachableDir, { recursive: true });
    // Put a snapshot in the reachable one so the `snapshots` array is populated.
    writeBackupFile(reachableDir, "backup-20260411-100000.vbundle");

    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: {
        enabled: true,
        destinations: [
          { path: reachableDir, encrypt: false },
          { path: unreachableDir, encrypt: true },
        ],
      },
    });

    const res = await handleBackupList(new Request("http://localhost/v1/backups"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      offsite: Array<{
        destination: { path: string; encrypt: boolean };
        snapshots: SnapshotEntry[];
        reachable: boolean;
      }>;
    };
    expect(body.offsite).toHaveLength(2);
    expect(body.offsite[0].destination.path).toBe(reachableDir);
    expect(body.offsite[0].reachable).toBe(true);
    expect(body.offsite[0].snapshots).toHaveLength(1);
    expect(body.offsite[0].snapshots[0].filename).toBe(
      "backup-20260411-100000.vbundle",
    );
    expect(body.offsite[1].destination.path).toBe(unreachableDir);
    expect(body.offsite[1].reachable).toBe(false);
    expect(body.offsite[1].snapshots).toEqual([]);
  });

  test("encrypted files in a reachable offsite dir return with encrypted: true", async () => {
    const encryptedDir = join(ROOT, "offsite-enc");
    mkdirSync(encryptedDir, { recursive: true });
    writeBackupFile(encryptedDir, "backup-20260411-100000.vbundle.enc");
    writeBackupFile(encryptedDir, "backup-20260411-120000.vbundle.enc");

    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: {
        enabled: true,
        destinations: [{ path: encryptedDir, encrypt: true }],
      },
    });

    const res = await handleBackupList(new Request("http://localhost/v1/backups"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      offsite: Array<{
        snapshots: SnapshotEntry[];
        reachable: boolean;
      }>;
    };
    expect(body.offsite).toHaveLength(1);
    expect(body.offsite[0].reachable).toBe(true);
    expect(body.offsite[0].snapshots).toHaveLength(2);
    // Newest-first
    expect(body.offsite[0].snapshots[0].filename).toBe(
      "backup-20260411-120000.vbundle.enc",
    );
    expect(body.offsite[0].snapshots[0].encrypted).toBe(true);
    expect(body.offsite[0].snapshots[1].encrypted).toBe(true);
  });

  test("nextRunAt is computed from checkpoint + intervalHours when enabled", async () => {
    const lastRunMs = Date.parse("2026-04-11T10:00:00Z");
    mockCheckpointStore["backup:last_run_at"] = String(lastRunMs);
    mockBackupConfig = makeConfig({
      enabled: true,
      intervalHours: 6,
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupList(new Request("http://localhost/v1/backups"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextRunAt: string | null };
    // 6 hours after 10:00 UTC is 16:00 UTC
    expect(body.nextRunAt).toBe("2026-04-11T16:00:00.000Z");
  });

  test("nextRunAt is null when backup is disabled", async () => {
    mockCheckpointStore["backup:last_run_at"] = String(
      Date.parse("2026-04-11T10:00:00Z"),
    );
    mockBackupConfig = makeConfig({
      enabled: false,
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupList(new Request("http://localhost/v1/backups"));
    const body = (await res.json()) as { nextRunAt: string | null };
    expect(body.nextRunAt).toBeNull();
  });

  test("offsite.enabled=false returns offsite:[] and offsiteEnabled:false without probing destinations", async () => {
    // Regression test: when the user disables offsite backups, the HTTP
    // handler must mirror the worker's behavior and return an empty offsite
    // list without enumerating any destinations. Previously the handler
    // would still probe each configured destination, causing the macOS UI
    // to render offsite cards even after offsite was turned off.
    //
    // Even with destinations present in config, `offsite.enabled=false`
    // should short-circuit the enumeration loop.
    const configuredDestDir = join(ROOT, "offsite-still-configured");
    mkdirSync(configuredDestDir, { recursive: true });
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: {
        enabled: false,
        destinations: [
          { path: configuredDestDir, encrypt: true },
        ],
      },
    });

    const res = await handleBackupList(
      new Request("http://localhost/v1/backups"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      local: SnapshotEntry[];
      offsite: unknown[];
      offsiteEnabled: boolean;
    };
    expect(body.offsite).toEqual([]);
    expect(body.offsiteEnabled).toBe(false);
    // listSnapshotsInDir should only have been called for the local dir —
    // never for any offsite destination.
    expect(listSnapshotsCallLog).toEqual([LOCAL_DIR]);
  });

  test("offsite.enabled=true returns offsiteEnabled:true", async () => {
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupList(
      new Request("http://localhost/v1/backups"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offsiteEnabled: boolean };
    expect(body.offsiteEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleBackupCreate
// ---------------------------------------------------------------------------

describe("handleBackupCreate", () => {
  const fakeRunResult: BackupRunResult = {
    local: {
      path: "/tmp/fake/backup-20260411-100000.vbundle",
      filename: "backup-20260411-100000.vbundle",
      createdAt: new Date("2026-04-11T10:00:00Z"),
      sizeBytes: 100,
      encrypted: false,
    },
    offsite: [],
    durationMs: 42,
  };

  test("manual create bypasses enabled flag and succeeds with disabled config", async () => {
    mockBackupConfig = makeConfig({
      enabled: false,
      localDirectory: LOCAL_DIR,
      offsite: { enabled: false, destinations: null },
    });
    mockCreateSnapshotResult = fakeRunResult;

    const res = await handleBackupCreate(
      new Request("http://localhost/v1/backups/create", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as BackupRunResult;
    expect(body.durationMs).toBe(42);
    expect(body.offsite).toEqual([]);
    expect(mockCreateSnapshotCalls).toBe(1);
  });

  test("plaintext-only destinations do not create backup.key file", async () => {
    const plaintextDir = join(ROOT, "offsite-plain");
    mkdirSync(plaintextDir, { recursive: true });
    mockBackupConfig = makeConfig({
      enabled: true,
      localDirectory: LOCAL_DIR,
      offsite: {
        enabled: true,
        destinations: [{ path: plaintextDir, encrypt: false }],
      },
    });
    mockCreateSnapshotResult = fakeRunResult;

    // The mocked createSnapshotNow never touches the key file. We assert:
    // (a) the HTTP layer itself did not try to load readBackupKey, and
    // (b) no backup.key file exists under the protected dir (which is under
    //     our ROOT per the platform mock).
    mockReadBackupKeyCalls = 0;
    const res = await handleBackupCreate(
      new Request("http://localhost/v1/backups/create", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(mockReadBackupKeyCalls).toBe(0);
    // ROOT is a fresh temp dir — no protected/backup.key was ever written.
    const keyFileExists = await import("node:fs").then((m) =>
      m.existsSync(join(ROOT, "workspace", "protected", "backup.key")),
    );
    expect(keyFileExists).toBe(false);
  });

  test("concurrent call returns 409 when mock raises 'snapshot in progress'", async () => {
    mockBackupConfig = makeConfig({ localDirectory: LOCAL_DIR });
    mockCreateSnapshotError = new Error("snapshot in progress");

    const res = await handleBackupCreate(
      new Request("http://localhost/v1/backups/create", { method: "POST" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  test("cross-process conflict ('locked by pid N') is still mapped to 409", async () => {
    // Regression test for the startsWith matcher in handleBackupCreate: the
    // cross-process file lock in snapshot-lock.ts throws
    // "snapshot in progress (locked by pid N)" rather than the bare
    // "snapshot in progress" message the in-process flag emits. Both must
    // map to 409 / CONFLICT — pin the matcher against future drift.
    mockBackupConfig = makeConfig({ localDirectory: LOCAL_DIR });
    mockCreateSnapshotError = new Error(
      "snapshot in progress (locked by pid 12345)",
    );

    const res = await handleBackupCreate(
      new Request("http://localhost/v1/backups/create", { method: "POST" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  test("other errors are surfaced as 500", async () => {
    mockCreateSnapshotError = new Error("disk full");
    const res = await handleBackupCreate(
      new Request("http://localhost/v1/backups/create", { method: "POST" }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("disk full");
  });
});

// ---------------------------------------------------------------------------
// handleBackupRestore
// ---------------------------------------------------------------------------

describe("handleBackupRestore", () => {
  test("rejects path outside the allowed directories with 400", async () => {
    const outsidePath = join(ROOT, "elsewhere", "backup-20260411-100000.vbundle");
    mkdirSync(join(ROOT, "elsewhere"), { recursive: true });
    writeFileSync(outsidePath, "payload");
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupRestore(
      jsonRequest("POST", { path: outsidePath }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/outside/i);
    expect(lastRestoreArgs).toBeNull();
  });

  test("rejects symlink that escapes the allowed directories", async () => {
    // Create a valid-looking symlink inside LOCAL_DIR that points to a file
    // outside. realpath() follows the symlink, so containment check fails.
    const outsideTarget = join(ROOT, "evil-target.vbundle");
    writeFileSync(outsideTarget, "payload");
    mkdirSync(LOCAL_DIR, { recursive: true });
    const symlinkPath = join(LOCAL_DIR, "backup-20260411-100000.vbundle");
    symlinkSync(outsideTarget, symlinkPath);
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupRestore(
      jsonRequest("POST", { path: symlinkPath }),
    );
    expect(res.status).toBe(400);
    expect(lastRestoreArgs).toBeNull();
  });

  test("plaintext .vbundle inside local dir is restored without loading key", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });
    mockReadBackupKeyCalls = 0;

    const res = await handleBackupRestore(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(200);
    expect(mockReadBackupKeyCalls).toBe(0);
    expect(lastRestoreArgs).not.toBeNull();
    expect(lastRestoreArgs!.hasKey).toBe(false);
    // restoreFromSnapshot should be called with the realpath'd snapshot path.
    // On macOS, `/var/...` resolves to `/private/var/...`, so compare against
    // the realpath of the input rather than the raw string.
    const expectedRealpath = await (
      await import("node:fs/promises")
    ).realpath(snapshotPath);
    expect(lastRestoreArgs!.path).toBe(expectedRealpath);
  });

  test("encrypted .vbundle.enc inside local dir loads key and restores", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle.enc",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });
    mockBackupKey = Buffer.alloc(32, 0xbb);
    mockReadBackupKeyCalls = 0;

    const res = await handleBackupRestore(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(200);
    expect(mockReadBackupKeyCalls).toBe(1);
    expect(lastRestoreArgs).not.toBeNull();
    expect(lastRestoreArgs!.hasKey).toBe(true);
  });

  test("encrypted bundle with missing backup.key returns a clear 400", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle.enc",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });
    mockBackupKey = null; // readBackupKey returns null when the file is missing

    const res = await handleBackupRestore(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/backup.key is missing/);
    // restoreFromSnapshot must NOT have been called — we bail before handing
    // the path to the restore helper.
    expect(lastRestoreArgs).toBeNull();
  });

  test("successful restore runs the full recovery sequence in order", async () => {
    // Regression test for the restore-corrupts-daemon-state gap:
    // handleBackupRestore must call resetDb() BEFORE restoreFromSnapshot
    // (so the live SQLite handle is closed before the file is overwritten)
    // and invalidateConfigCache() + clearTrustCache() AFTER (so the daemon
    // re-reads the restored config/trust rules). The migration importer
    // already does this — the backup handler must match.
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupRestore(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(200);
    expect(mockResetDbCalls).toBe(1);
    expect(mockInvalidateConfigCacheCalls).toBe(1);
    expect(mockClearTrustCacheCalls).toBe(1);
    expect(recoveryCallOrder).toEqual([
      "resetDb",
      "restoreFromSnapshot",
      "invalidateConfigCache",
      "clearTrustCache",
    ]);
  });

  test("restore failure still closes the DB singleton before throwing", async () => {
    // Even on failure, resetDb must have been called — we don't want the
    // daemon to keep writing through an open handle to a file that's been
    // partially overwritten by a failed commit.
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });
    mockRestoreError = new Error("simulated restore failure");

    const res = await handleBackupRestore(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(500);
    expect(mockResetDbCalls).toBe(1);
    // Caches should NOT be invalidated on failure — the in-process caches
    // still reflect the pre-restore state on disk (the bundle write failed
    // so there's nothing new to re-read).
    expect(mockInvalidateConfigCacheCalls).toBe(0);
    expect(mockClearTrustCacheCalls).toBe(0);
  });

  test("response no longer exposes credentialsIncluded", async () => {
    // The dead credentials plumbing has been removed from the backup surface.
    // Credentials intentionally live in the OS keychain / CES and are not
    // part of the backup round trip.
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupRestore(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("credentialsIncluded" in body).toBe(false);
    expect(body.manifest).toBeDefined();
    expect(body.restoredFiles).toBeDefined();
  });

  test("missing path field returns 400", async () => {
    const res = await handleBackupRestore(jsonRequest("POST", {}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("malformed JSON body returns 400", async () => {
    const req = new Request("http://localhost/v1/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    const res = await handleBackupRestore(req);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// handleBackupVerify
// ---------------------------------------------------------------------------

describe("handleBackupVerify", () => {
  test("corrupted bundle returns { valid: false }", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
      "not-a-real-bundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });
    mockVerifyResult = { valid: false, error: "bad checksum" };

    const res = await handleBackupVerify(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as VerifyResult;
    expect(body.valid).toBe(false);
    expect(body.error).toBe("bad checksum");
    expect(lastVerifyArgs!.hasKey).toBe(false);
  });

  test("valid plaintext bundle returns { valid: true } without loading key", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });
    mockReadBackupKeyCalls = 0;
    mockVerifyResult = {
      valid: true,
      manifest: {
        schema_version: "1.0",
        created_at: "2026-04-11T10:00:00.000Z",
        files: [],
        manifest_sha256: "0".repeat(64),
      } as unknown as VerifyResult["manifest"],
    };

    const res = await handleBackupVerify(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(200);
    expect(mockReadBackupKeyCalls).toBe(0);
    const body = (await res.json()) as VerifyResult;
    expect(body.valid).toBe(true);
  });

  test("encrypted bundle with key loads key and forwards to verifySnapshot", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle.enc",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });
    mockBackupKey = Buffer.alloc(32, 0xcc);
    mockReadBackupKeyCalls = 0;

    const res = await handleBackupVerify(
      jsonRequest("POST", { path: snapshotPath }),
    );
    expect(res.status).toBe(200);
    expect(mockReadBackupKeyCalls).toBe(1);
    expect(lastVerifyArgs!.hasKey).toBe(true);
  });

  test("path outside allowed directories returns 400", async () => {
    const outsidePath = join(ROOT, "elsewhere", "backup-20260411-100000.vbundle");
    mkdirSync(join(ROOT, "elsewhere"), { recursive: true });
    writeFileSync(outsidePath, "payload");
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const res = await handleBackupVerify(
      jsonRequest("POST", { path: outsidePath }),
    );
    expect(res.status).toBe(400);
    expect(lastVerifyArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// backupRouteDefinitions
// ---------------------------------------------------------------------------

describe("backupRouteDefinitions", () => {
  test("registers four routes with the expected endpoint+method pairs", () => {
    const defs = backupRouteDefinitions();
    const pairs = defs.map((d) => `${d.method} ${d.endpoint}`).sort();
    expect(pairs).toEqual([
      "GET backups",
      "POST backups/create",
      "POST backups/restore",
      "POST backups/verify",
    ]);
  });
});

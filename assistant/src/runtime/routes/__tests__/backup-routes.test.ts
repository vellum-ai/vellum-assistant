/**
 * Unit tests for the /v1/backups route handlers.
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
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RestoreResult, VerifyResult } from "../../../backup/restore.js";
import type { BackupConfig } from "../../../config/schema.js";
import { BackupConfigSchema } from "../../../config/schema.js";
import type { ManifestType } from "../../migrations/vbundle-validator.js";

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
const { listSnapshotsInDir: realListSnapshotsInDir } =
  await import("../../../backup/list-snapshots.js");
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
  }),
  invalidateConfigCache: () => {
    mockInvalidateConfigCacheCalls += 1;
    recoveryCallOrder.push("invalidateConfigCache");
  },
}));

// -- Trust-cache mock ------------------------------------------------------

const recoveryCallOrder: string[] = [];

mock.module("../../../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

// -- Platform paths mock ---------------------------------------------------

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
  getWorkspaceHooksDir: () => join(mockWorkspaceDir, "hooks"),
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

let mockBackupKey: Buffer | null = Buffer.alloc(32, 0xaa);
let mockReadBackupKeyCalls = 0;

mock.module("../../../backup/backup-key.js", () => ({
  readBackupKey: async (_path: string) => {
    mockReadBackupKeyCalls += 1;
    return mockBackupKey;
  },
  ensureBackupKey: async (_path: string) => mockBackupKey ?? Buffer.alloc(32),
}));

// -- Restore module mock ---------------------------------------------------

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

function makeV1Manifest(): ManifestType {
  return {
    schema_version: 1,
    bundle_id: "00000000-0000-4000-8000-000000000000",
    created_at: "2026-04-11T10:00:00.000Z",
    assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
    origin: { mode: "self-hosted-local" },
    compatibility: {
      min_runtime_version: "0.0.0-test",
      max_runtime_version: null,
    },
    contents: [],
    checksum: "0".repeat(64),
    secrets_redacted: false,
    export_options: {
      include_logs: false,
      include_browser_state: false,
      include_memory_vectors: false,
    },
  };
}

let mockRestoreResult: RestoreResult = {
  manifest: makeV1Manifest(),
  restoredFiles: 0,
};
let mockRestoreError: Error | null = null;
let mockVerifyResult: VerifyResult = { valid: true };

mock.module("../../../backup/restore.js", () => ({
  restoreFromSnapshot: async (
    path: string,
    opts: {
      workspaceDir?: string;
    },
  ) => {
    recoveryCallOrder.push("restoreFromSnapshot");
    lastRestoreArgs = {
      path,
      hasKey: false,
      workspaceDir: opts.workspaceDir,
    };
    if (mockRestoreError) throw mockRestoreError;
    return mockRestoreResult;
  },
  verifySnapshot: async (path: string) => {
    lastVerifyArgs = { path, hasKey: false };
    return mockVerifyResult;
  },
}));

// ---------------------------------------------------------------------------
// Import under test — after mocks
// ---------------------------------------------------------------------------

import {
  handleBackupCreate,
  handleBackupList,
  handleBackupRestore,
  handleBackupVerify,
  ROUTES,
} from "../backup-routes.js";
import { RouteError } from "../errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ROOT: string;
let LOCAL_DIR: string;

function makeConfig(overrides: Partial<BackupConfig> = {}): BackupConfig {
  const base = BackupConfigSchema.parse({});
  return { ...base, ...overrides };
}

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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "vellum-backup-routes-"));
  LOCAL_DIR = join(ROOT, "local");
  mockBackupConfig = makeConfig({ localDirectory: LOCAL_DIR });
  mockWorkspaceDir = join(ROOT, "workspace");
  for (const key of Object.keys(mockCheckpointStore)) {
    delete mockCheckpointStore[key];
  }
  mockBackupKey = Buffer.alloc(32, 0xaa);
  mockReadBackupKeyCalls = 0;
  lastRestoreArgs = null;
  lastVerifyArgs = null;
  mockRestoreError = null;
  mockRestoreResult = {
    manifest: makeV1Manifest(),
    restoredFiles: 0,
  };
  mockVerifyResult = { valid: true };
  mockInvalidateConfigCacheCalls = 0;
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
    const origHome = process.env.HOME;
    process.env.HOME = ROOT;
    try {
      mockBackupConfig = makeConfig({
        localDirectory: LOCAL_DIR,
        offsite: {
          enabled: true,
          destinations: null,
        },
      });

      const result = await handleBackupList();
      expect(result.local).toEqual([]);
      expect(result.offsite).toHaveLength(1);
      expect(result.offsite[0].destination.encrypt).toBe(true);
      expect(result.offsite[0].snapshots).toEqual([]);
      expect(result.offsite[0].reachable).toBe(false);
      expect(result.nextRunAt).toBeNull();
    } finally {
      if (origHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = origHome;
      }
    }
  });

  test("two local files: returned newest-first", async () => {
    writeBackupFile(LOCAL_DIR, "backup-20260411-100000.vbundle");
    writeBackupFile(LOCAL_DIR, "backup-20260411-120000.vbundle");
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const result = await handleBackupList();
    expect(result.local).toHaveLength(2);
    expect(result.local[0].filename).toBe("backup-20260411-120000.vbundle");
    expect(result.local[1].filename).toBe("backup-20260411-100000.vbundle");
    expect(result.offsite).toEqual([]);
  });

  test("two offsite destinations: reachable + unreachable reflected per-entry", async () => {
    const reachableDir = join(ROOT, "offsite-reachable");
    const unreachableDir = join(ROOT, "nope", "deeper", "backups");
    mkdirSync(reachableDir, { recursive: true });
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

    const result = await handleBackupList();
    expect(result.offsite).toHaveLength(2);
    expect(result.offsite[0].destination.path).toBe(reachableDir);
    expect(result.offsite[0].reachable).toBe(true);
    expect(result.offsite[0].snapshots).toHaveLength(1);
    expect(result.offsite[0].snapshots[0].filename).toBe(
      "backup-20260411-100000.vbundle",
    );
    expect(result.offsite[1].destination.path).toBe(unreachableDir);
    expect(result.offsite[1].reachable).toBe(false);
    expect(result.offsite[1].snapshots).toEqual([]);
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

    const result = await handleBackupList();
    expect(result.offsite).toHaveLength(1);
    expect(result.offsite[0].reachable).toBe(true);
    expect(result.offsite[0].snapshots).toHaveLength(2);
    expect(result.offsite[0].snapshots[0].filename).toBe(
      "backup-20260411-120000.vbundle.enc",
    );
    expect(result.offsite[0].snapshots[0].encrypted).toBe(true);
    expect(result.offsite[0].snapshots[1].encrypted).toBe(true);
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

    const result = await handleBackupList();
    expect(result.nextRunAt).toBe("2026-04-11T16:00:00.000Z");
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

    const result = await handleBackupList();
    expect(result.nextRunAt).toBeNull();
  });

  test("offsite.enabled=false returns offsite:[] and offsiteEnabled:false without probing destinations", async () => {
    const configuredDestDir = join(ROOT, "offsite-still-configured");
    mkdirSync(configuredDestDir, { recursive: true });
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: {
        enabled: false,
        destinations: [{ path: configuredDestDir, encrypt: true }],
      },
    });

    const result = await handleBackupList();
    expect(result.offsite).toEqual([]);
    expect(result.offsiteEnabled).toBe(false);
    expect(listSnapshotsCallLog).toEqual([LOCAL_DIR]);
  });

  test("offsite.enabled=true returns offsiteEnabled:true", async () => {
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const result = await handleBackupList();
    expect(result.offsiteEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// handleBackupCreate
// ---------------------------------------------------------------------------

describe("handleBackupCreate", () => {
  test("always throws BadRequestError redirecting to gateway", async () => {
    await expect(handleBackupCreate()).rejects.toThrow(
      "Backup snapshot creation has moved to the gateway",
    );
  });
});

// handleBackupRestore
// ---------------------------------------------------------------------------

describe("handleBackupRestore", () => {
  test("rejects path outside the allowed directories with 400", async () => {
    const outsidePath = join(
      ROOT,
      "elsewhere",
      "backup-20260411-100000.vbundle",
    );
    mkdirSync(join(ROOT, "elsewhere"), { recursive: true });
    writeFileSync(outsidePath, "payload");
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    try {
      await handleBackupRestore({
        body: { path: outsidePath },
        pathParams: {},
        queryParams: {},
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
      expect((err as RouteError).message).toMatch(/outside/i);
    }
    expect(lastRestoreArgs).toBeNull();
  });

  test("rejects symlink that escapes the allowed directories", async () => {
    const outsideTarget = join(ROOT, "evil-target.vbundle");
    writeFileSync(outsideTarget, "payload");
    mkdirSync(LOCAL_DIR, { recursive: true });
    const symlinkPath = join(LOCAL_DIR, "backup-20260411-100000.vbundle");
    symlinkSync(outsideTarget, symlinkPath);
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    try {
      await handleBackupRestore({
        body: { path: symlinkPath },
        pathParams: {},
        queryParams: {},
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }
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

    const result = await handleBackupRestore({
      body: { path: snapshotPath },
      pathParams: {},
      queryParams: {},
    });
    expect(result).toBeDefined();
    expect(mockReadBackupKeyCalls).toBe(0);
    expect(lastRestoreArgs).not.toBeNull();
    expect(lastRestoreArgs!.hasKey).toBe(false);
    const expectedRealpath = await (
      await import("node:fs/promises")
    ).realpath(snapshotPath);
    expect(lastRestoreArgs!.path).toBe(expectedRealpath);
  });

  test("encrypted .vbundle.enc is rejected with gateway redirect error", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle.enc",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    try {
      await handleBackupRestore({
        body: { path: snapshotPath },
        pathParams: {},
        queryParams: {},
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
      expect((err as RouteError).message).toMatch(/gateway/i);
    }
    expect(lastRestoreArgs).toBeNull();
  });

  test("successful restore runs the full recovery sequence in order", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    await handleBackupRestore({
      body: { path: snapshotPath },
      pathParams: {},
      queryParams: {},
    });
    expect(mockInvalidateConfigCacheCalls).toBe(1);
    expect(recoveryCallOrder).toEqual([
      "restoreFromSnapshot",
      "invalidateConfigCache",
    ]);
  });

  test("restore failure leaves caches untouched", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });
    mockRestoreError = new Error("simulated restore failure");

    try {
      await handleBackupRestore({
        body: { path: snapshotPath },
        pathParams: {},
        queryParams: {},
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(500);
    }
    expect(mockInvalidateConfigCacheCalls).toBe(0);
  });

  test("response no longer exposes credentialsIncluded", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    const result = (await handleBackupRestore({
      body: { path: snapshotPath },
      pathParams: {},
      queryParams: {},
    })) as Record<string, unknown>;
    expect("credentialsIncluded" in result).toBe(false);
    expect(result.manifest).toBeDefined();
    expect(result.restoredFiles).toBeDefined();
  });

  test("missing path field throws BadRequestError", async () => {
    try {
      await handleBackupRestore({
        body: {},
        pathParams: {},
        queryParams: {},
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }
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

    const result = (await handleBackupVerify({
      body: { path: snapshotPath },
      pathParams: {},
      queryParams: {},
    })) as VerifyResult;
    expect(result.valid).toBe(false);
    expect(result.error).toBe("bad checksum");
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
      manifest: makeV1Manifest(),
    };

    const result = (await handleBackupVerify({
      body: { path: snapshotPath },
      pathParams: {},
      queryParams: {},
    })) as VerifyResult;
    expect(mockReadBackupKeyCalls).toBe(0);
    expect(result.valid).toBe(true);
  });

  test("encrypted bundle is rejected with gateway redirect error", async () => {
    const snapshotPath = writeBackupFile(
      LOCAL_DIR,
      "backup-20260411-100000.vbundle.enc",
    );
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    try {
      await handleBackupVerify({
        body: { path: snapshotPath },
        pathParams: {},
        queryParams: {},
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
      expect((err as RouteError).message).toMatch(/gateway/i);
    }
  });

  test("path outside allowed directories throws BadRequestError", async () => {
    const outsidePath = join(
      ROOT,
      "elsewhere",
      "backup-20260411-100000.vbundle",
    );
    mkdirSync(join(ROOT, "elsewhere"), { recursive: true });
    writeFileSync(outsidePath, "payload");
    mockBackupConfig = makeConfig({
      localDirectory: LOCAL_DIR,
      offsite: { enabled: true, destinations: [] },
    });

    try {
      await handleBackupVerify({
        body: { path: outsidePath },
        pathParams: {},
        queryParams: {},
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(400);
    }
    expect(lastVerifyArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ROUTES array
// ---------------------------------------------------------------------------

describe("ROUTES", () => {
  test("registers four routes with the expected endpoint+method pairs", () => {
    const pairs = ROUTES.map((d) => `${d.method} ${d.endpoint}`).sort();
    expect(pairs).toEqual([
      "GET backups",
      "POST backups/create",
      "POST backups/restore",
      "POST backups/verify",
    ]);
  });
});

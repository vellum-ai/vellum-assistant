/**
 * Tests for the periodic backup worker. Drives `runBackupTick` and
 * `createSnapshotNow` directly with fake dependencies so the whole pipeline
 * runs against a temp directory with an in-memory checkpoint store and
 * no real database.
 *
 * `streamExportVBundle` is stubbed to write a tiny byte blob to a temp
 * file — the worker never validates bundle contents, it just hands the
 * path to `writeLocalSnapshot` which renames it into place.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { BackupConfig, BackupDestination } from "../../config/schema.js";
import { BackupConfigSchema } from "../../config/schema.js";
import type { StreamExportVBundleResult } from "../../runtime/migrations/vbundle-builder.js";
import type { BackupDeps } from "../backup-worker.js";
import { createSnapshotNow, runBackupTick } from "../backup-worker.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let ROOT: string;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "vellum-backup-worker-"));
});

afterEach(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Build a valid BackupConfig with overrides. Starts from schema defaults. */
function makeConfig(overrides?: {
  enabled?: boolean;
  intervalHours?: number;
  retention?: number;
  localDirectory?: string | null;
  offsite?: {
    enabled?: boolean;
    destinations?: BackupDestination[] | null;
  };
}): BackupConfig {
  const base = BackupConfigSchema.parse({});
  return {
    ...base,
    enabled: overrides?.enabled ?? base.enabled,
    intervalHours: overrides?.intervalHours ?? base.intervalHours,
    retention: overrides?.retention ?? base.retention,
    localDirectory: overrides?.localDirectory ?? base.localDirectory,
    offsite: {
      enabled: overrides?.offsite?.enabled ?? base.offsite.enabled,
      destinations:
        overrides?.offsite?.destinations === undefined
          ? base.offsite.destinations
          : overrides.offsite.destinations,
    },
  };
}

/**
 * Build an in-memory checkpoint store. Returns fake getters/setters and a
 * plain object so tests can inspect or preload entries.
 */
function makeCheckpointStore(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    get: (key: string): string | null => store[key] ?? null,
    set: (key: string, value: string): void => {
      store[key] = value;
    },
  };
}

/**
 * Build a stub `streamExportVBundle` that writes a tiny payload to a fresh
 * temp file on every call. The worker only cares that `tempPath` exists and
 * can be renamed — the bundle content is never introspected.
 */
function makeStreamExportStub(): {
  fn: BackupDeps["streamExportVBundle"];
  calls: Array<Parameters<NonNullable<BackupDeps["streamExportVBundle"]>>[0]>;
} {
  const calls: Array<
    Parameters<NonNullable<BackupDeps["streamExportVBundle"]>>[0]
  > = [];
  let counter = 0;
  const fn: BackupDeps["streamExportVBundle"] = async (opts) => {
    calls.push(opts);
    // Deliberately do NOT fire opts.checkpoint?.() here — the real checkpoint
    // callback opens a fresh DB handle at `getDbPath()` which does not exist
    // in the test environment. Tests don't care about the WAL side-effect;
    // they just need the stub to return a valid temp bundle path.
    counter += 1;
    const tempPath = join(ROOT, `stub-bundle-${counter}.tmp`);
    await writeFile(tempPath, `fake bundle ${counter}`);
    const result: StreamExportVBundleResult = {
      tempPath,
      size: 16,
      manifest: {
        schema_version: 1,
        bundle_id: "00000000-0000-4000-8000-000000000000",
        created_at: new Date().toISOString(),
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
      },
      cleanup: async () => {
        try {
          await unlink(tempPath);
        } catch {
          // best-effort
        }
      },
    };
    return result;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// runBackupTick — gating
// ---------------------------------------------------------------------------

describe("runBackupTick — gating", () => {
  test("returns null when config.enabled is false", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const config = makeConfig({ enabled: false });
    const localDir = join(ROOT, "local");

    const result = await runBackupTick(config, new Date(), {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).toBeNull();
    expect(streamStub.calls).toHaveLength(0);
    expect(Object.keys(checkpoints.store)).toHaveLength(0);
    expect(existsSync(localDir)).toBe(false);
  });

  test("returns null when last_run_at is within the interval window", async () => {
    const now = new Date("2026-04-11T10:00:00Z");
    const oneHourAgoMs = now.getTime() - 1 * 3600 * 1000;
    const checkpoints = makeCheckpointStore({
      "backup:last_run_at": String(oneHourAgoMs),
    });
    const streamStub = makeStreamExportStub();
    const config = makeConfig({ enabled: true, intervalHours: 6 });
    const localDir = join(ROOT, "local");

    const result = await runBackupTick(config, now, {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).toBeNull();
    expect(streamStub.calls).toHaveLength(0);
    // Checkpoint unchanged
    expect(checkpoints.store["backup:last_run_at"]).toBe(String(oneHourAgoMs));
  });

  test("runs when last_run_at is older than the interval", async () => {
    const now = new Date("2026-04-11T10:00:00Z");
    const sevenHoursAgoMs = now.getTime() - 7 * 3600 * 1000;
    const checkpoints = makeCheckpointStore({
      "backup:last_run_at": String(sevenHoursAgoMs),
    });
    const streamStub = makeStreamExportStub();
    const config = makeConfig({
      enabled: true,
      intervalHours: 6,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");

    const result = await runBackupTick(config, now, {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(streamStub.calls).toHaveLength(1);
    expect(checkpoints.store["backup:last_run_at"]).toBe(String(now.getTime()));
    // Local snapshot file was created
    expect(result!.local.path).toContain("backup-20260411-100000-000.vbundle");
    expect(existsSync(result!.local.path)).toBe(true);
    expect(result!.offsite).toEqual([]);
  });

  test("runs when last_run_at checkpoint is missing (first-ever run)", async () => {
    const now = new Date("2026-04-11T10:00:00Z");
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const config = makeConfig({
      enabled: true,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");

    const result = await runBackupTick(config, now, {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(checkpoints.store["backup:last_run_at"]).toBe(String(now.getTime()));
  });
});

// ---------------------------------------------------------------------------
// runBackupTick — offsite destinations
// ---------------------------------------------------------------------------

describe("runBackupTick — offsite destinations", () => {
  test("config.offsite.enabled === false: offsite is empty and key is not loaded", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const ensureKey = mock(async () => Buffer.alloc(32, 1));
    const config = makeConfig({
      enabled: true,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");

    const result = await runBackupTick(config, new Date(), {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      ensureBackupKey: ensureKey,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(result!.offsite).toEqual([]);
    expect(ensureKey).not.toHaveBeenCalled();
  });

  test("single plaintext destination: key is not loaded, file has .vbundle extension", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const ensureKey = mock(async () => Buffer.alloc(32, 1));
    const offsiteDir = join(ROOT, "offsite", "plain");
    // Parent must exist — writer probes for parent before mkdir of dest.
    mkdirSync(join(ROOT, "offsite"), { recursive: true });
    const config = makeConfig({
      enabled: true,
      offsite: {
        enabled: true,
        destinations: [{ path: offsiteDir, encrypt: false }],
      },
    });
    const localDir = join(ROOT, "local");
    const now = new Date("2026-04-11T12:00:00Z");

    const result = await runBackupTick(config, now, {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      ensureBackupKey: ensureKey,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(ensureKey).not.toHaveBeenCalled();
    expect(result!.offsite).toHaveLength(1);
    expect(result!.offsite[0].entry).not.toBeNull();
    expect(result!.offsite[0].entry!.filename).toBe(
      "backup-20260411-120000-000.vbundle",
    );
    expect(result!.offsite[0].entry!.encrypted).toBe(false);
    expect(existsSync(result!.offsite[0].entry!.path)).toBe(true);
  });

  test("single encrypted destination: key is loaded, file has .vbundle.enc extension", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const ensureKey = mock(async () => Buffer.alloc(32, 0xab));
    const offsiteDir = join(ROOT, "offsite", "enc");
    mkdirSync(join(ROOT, "offsite"), { recursive: true });
    const keyPath = join(ROOT, "backup.key");
    const config = makeConfig({
      enabled: true,
      offsite: {
        enabled: true,
        destinations: [{ path: offsiteDir, encrypt: true }],
      },
    });
    const localDir = join(ROOT, "local");
    const now = new Date("2026-04-11T13:00:00Z");

    const result = await runBackupTick(config, now, {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      ensureBackupKey: ensureKey,
      backupKeyPath: keyPath,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(ensureKey).toHaveBeenCalledTimes(1);
    expect(ensureKey).toHaveBeenCalledWith(keyPath);
    expect(result!.offsite).toHaveLength(1);
    expect(result!.offsite[0].entry).not.toBeNull();
    expect(result!.offsite[0].entry!.filename).toBe(
      "backup-20260411-130000-000.vbundle.enc",
    );
    expect(result!.offsite[0].entry!.encrypted).toBe(true);
    expect(existsSync(result!.offsite[0].entry!.path)).toBe(true);
  });

  test("mixed destinations: key is loaded once (because A needs it), both files written", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const ensureKey = mock(async () => Buffer.alloc(32, 0xcd));
    const encDir = join(ROOT, "offsite", "enc");
    const plainDir = join(ROOT, "offsite", "plain");
    mkdirSync(join(ROOT, "offsite"), { recursive: true });
    const config = makeConfig({
      enabled: true,
      offsite: {
        enabled: true,
        destinations: [
          { path: encDir, encrypt: true },
          { path: plainDir, encrypt: false },
        ],
      },
    });
    const localDir = join(ROOT, "local");

    const result = await runBackupTick(config, new Date(), {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      ensureBackupKey: ensureKey,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(ensureKey).toHaveBeenCalledTimes(1);
    expect(result!.offsite).toHaveLength(2);
    expect(result!.offsite[0].entry).not.toBeNull();
    expect(result!.offsite[0].entry!.encrypted).toBe(true);
    expect(result!.offsite[1].entry).not.toBeNull();
    expect(result!.offsite[1].entry!.encrypted).toBe(false);
  });

  test("mixed reachability: one ok + one parent-missing skip, local succeeds, checkpoint updated", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const reachableDir = join(ROOT, "offsite", "reachable");
    // Nested parent-missing: the parent directory is /nope/deeper which is
    // unreachable because /nope itself does not exist.
    const unreachableDir = join(ROOT, "nope", "deeper", "backups");
    mkdirSync(join(ROOT, "offsite"), { recursive: true });
    const config = makeConfig({
      enabled: true,
      offsite: {
        enabled: true,
        destinations: [
          { path: reachableDir, encrypt: false },
          { path: unreachableDir, encrypt: false },
        ],
      },
    });
    const localDir = join(ROOT, "local");
    const now = new Date("2026-04-11T14:00:00Z");

    const result = await runBackupTick(config, now, {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(result!.offsite).toHaveLength(2);
    expect(result!.offsite[0].entry).not.toBeNull();
    expect(result!.offsite[1].entry).toBeNull();
    expect(result!.offsite[1].skipped).toBe("parent-missing");
    // Local still succeeded
    expect(existsSync(result!.local.path)).toBe(true);
    // Checkpoint updated because performBackup returned successfully
    expect(checkpoints.store["backup:last_run_at"]).toBe(String(now.getTime()));
  });
});

// ---------------------------------------------------------------------------
// runBackupTick — error propagation
// ---------------------------------------------------------------------------

describe("runBackupTick — error propagation", () => {
  test("throws when streamExportVBundle throws and leaves checkpoint untouched", async () => {
    const checkpoints = makeCheckpointStore();
    const throwingStream: BackupDeps["streamExportVBundle"] = async () => {
      throw new Error("boom");
    };
    const config = makeConfig({
      enabled: true,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");

    await expect(
      runBackupTick(config, new Date(), {
        streamExportVBundle: throwingStream,
        getMemoryCheckpoint: checkpoints.get,
        setMemoryCheckpoint: checkpoints.set,
        workspaceDir: ROOT,
        localDir,
        snapshotLockPath: join(ROOT, ".snapshot.lock"),
      }),
    ).rejects.toThrow("boom");
    expect(checkpoints.store["backup:last_run_at"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createSnapshotNow — manual trigger
// ---------------------------------------------------------------------------

describe("createSnapshotNow", () => {
  test("bypasses enabled check (snapshot created even when enabled is false)", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const config = makeConfig({
      enabled: false,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");

    const result = await createSnapshotNow(config, new Date(), {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(streamStub.calls).toHaveLength(1);
    // Manual runs do NOT update the automatic cadence checkpoint
    expect(checkpoints.store["backup:last_run_at"]).toBeUndefined();
  });

  test("bypasses interval check even when a recent run was recorded", async () => {
    const now = new Date("2026-04-11T10:00:00Z");
    const checkpoints = makeCheckpointStore({
      "backup:last_run_at": String(now.getTime() - 60_000),
    });
    const streamStub = makeStreamExportStub();
    const config = makeConfig({
      enabled: true,
      intervalHours: 6,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");

    const result = await createSnapshotNow(config, now, {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    expect(result).not.toBeNull();
    expect(streamStub.calls).toHaveLength(1);
    // The pre-existing checkpoint is preserved — manual runs do not touch it.
    expect(checkpoints.store["backup:last_run_at"]).toBe(
      String(now.getTime() - 60_000),
    );
  });

  test("two concurrent calls: second throws 'snapshot in progress'", async () => {
    const checkpoints = makeCheckpointStore();
    // Stub that holds the first caller indefinitely until we release it,
    // giving the test a clean window to observe the mutex from a second call.
    let release: () => void = () => {};
    const holdPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callCount = 0;
    const holdingStream: BackupDeps["streamExportVBundle"] = async (_opts) => {
      callCount += 1;
      if (callCount === 1) {
        await holdPromise;
      }
      const tempPath = join(ROOT, `hold-${callCount}.tmp`);
      writeFileSync(tempPath, "payload");
      return {
        tempPath,
        size: 7,
        manifest: {
          schema_version: 1,
          bundle_id: "00000000-0000-4000-8000-000000000000",
          created_at: new Date().toISOString(),
          assistant: {
            id: "self",
            name: "Test",
            runtime_version: "0.0.0-test",
          },
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
        },
        cleanup: async () => {
          try {
            await unlink(tempPath);
          } catch {
            // best-effort
          }
        },
      };
    };
    const config = makeConfig({
      enabled: true,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");

    // Start the first call — it will park inside `streamExportVBundle`
    // waiting on holdPromise.
    const first = createSnapshotNow(config, new Date(), {
      streamExportVBundle: holdingStream,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: join(ROOT, ".snapshot.lock"),
    });

    // Yield once so the first call has a chance to enter the mutex + the
    // stream stub before we kick off the second call.
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      createSnapshotNow(config, new Date(), {
        streamExportVBundle: holdingStream,
        getMemoryCheckpoint: checkpoints.get,
        setMemoryCheckpoint: checkpoints.set,
        workspaceDir: ROOT,
        localDir,
        snapshotLockPath: join(ROOT, ".snapshot.lock"),
      }),
    ).rejects.toThrow("snapshot in progress");

    release();
    await first;
    // Only the first call should have been executed by the stub.
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-process lock (simulates a second process holding the lock)
// ---------------------------------------------------------------------------

describe("cross-process snapshot lock", () => {
  test("after performBackup succeeds, the lock file no longer exists", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const config = makeConfig({
      enabled: true,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");
    const lockPath = join(ROOT, ".snapshot.lock");

    const result = await createSnapshotNow(config, new Date(), {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: lockPath,
    });

    expect(result).not.toBeNull();
    // Lock file released on the finally path — must not linger on disk.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("another process holds the lock: createSnapshotNow throws 'snapshot in progress'", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const config = makeConfig({
      enabled: true,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");
    const lockPath = join(ROOT, ".snapshot.lock");

    // Simulate a concurrent CLI invocation by writing a lock file with the
    // CURRENT pid (which is definitely alive — it's us). Because the lock
    // file pre-exists and the PID probes as alive, the in-process flag will
    // pass (it's reset after the previous test) but the cross-process lock
    // will reject with "snapshot in progress (locked by pid N)".
    writeFileSync(lockPath, `${process.pid} ${Date.now()}\n`, { mode: 0o600 });

    await expect(
      createSnapshotNow(config, new Date(), {
        streamExportVBundle: streamStub.fn,
        getMemoryCheckpoint: checkpoints.get,
        setMemoryCheckpoint: checkpoints.set,
        workspaceDir: ROOT,
        localDir,
        snapshotLockPath: lockPath,
      }),
    ).rejects.toThrow(/snapshot in progress/);

    // The stream stub must not have been invoked because acquisition failed
    // before performBackup ran.
    expect(streamStub.calls).toHaveLength(0);
    // The pre-existing lock file is preserved — we did not own it, so we
    // must not have removed it on the failed-acquisition path.
    expect(existsSync(lockPath)).toBe(true);
  });

  test("runBackupTick defers silently when another process holds the lock", async () => {
    const now = new Date("2026-04-11T10:00:00Z");
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const config = makeConfig({
      enabled: true,
      offsite: { enabled: false, destinations: null },
    });
    const localDir = join(ROOT, "local");
    const lockPath = join(ROOT, ".snapshot.lock");

    // Pre-seed the lock file with the live PID so the worker observes a
    // conflict on its cross-process check.
    writeFileSync(lockPath, `${process.pid} ${Date.now()}\n`, { mode: 0o600 });

    const result = await runBackupTick(config, now, {
      streamExportVBundle: streamStub.fn,
      getMemoryCheckpoint: checkpoints.get,
      setMemoryCheckpoint: checkpoints.set,
      workspaceDir: ROOT,
      localDir,
      snapshotLockPath: lockPath,
    });

    // Scheduled tick defers silently on conflict rather than throwing — the
    // next interval will retry.
    expect(result).toBeNull();
    expect(streamStub.calls).toHaveLength(0);
    // Checkpoint must not advance when the tick defers.
    expect(checkpoints.store["backup:last_run_at"]).toBeUndefined();
    // Pre-existing lock file is preserved.
    expect(existsSync(lockPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retention — integration across multiple ticks
// ---------------------------------------------------------------------------

describe("retention across successive ticks", () => {
  test("three ticks past the interval with retention=2 leaves 2 local + 2 offsite", async () => {
    const checkpoints = makeCheckpointStore();
    const streamStub = makeStreamExportStub();
    const offsiteDir = join(ROOT, "offsite", "plain");
    mkdirSync(join(ROOT, "offsite"), { recursive: true });
    const config = makeConfig({
      enabled: true,
      intervalHours: 1,
      retention: 2,
      offsite: {
        enabled: true,
        destinations: [{ path: offsiteDir, encrypt: false }],
      },
    });
    const localDir = join(ROOT, "local");

    // Three successive runs, each 2 hours apart (past the 1-hour interval).
    const t1 = new Date("2026-04-11T10:00:00Z");
    const t2 = new Date("2026-04-11T12:00:00Z");
    const t3 = new Date("2026-04-11T14:00:00Z");

    for (const t of [t1, t2, t3]) {
      const result = await runBackupTick(config, t, {
        streamExportVBundle: streamStub.fn,
        getMemoryCheckpoint: checkpoints.get,
        setMemoryCheckpoint: checkpoints.set,
        workspaceDir: ROOT,
        localDir,
        snapshotLockPath: join(ROOT, ".snapshot.lock"),
      });
      expect(result).not.toBeNull();
    }

    // After three runs with retention=2, only the two newest survive in
    // both local and offsite pools.
    const localFiles = readdirSync(localDir)
      .filter((f) => f.startsWith("backup-"))
      .sort();
    expect(localFiles).toHaveLength(2);
    expect(localFiles).toEqual([
      "backup-20260411-120000-000.vbundle",
      "backup-20260411-140000-000.vbundle",
    ]);

    const offsiteFiles = readdirSync(offsiteDir)
      .filter((f) => f.startsWith("backup-"))
      .sort();
    expect(offsiteFiles).toHaveLength(2);
    expect(offsiteFiles).toEqual([
      "backup-20260411-120000-000.vbundle",
      "backup-20260411-140000-000.vbundle",
    ]);
  });
});

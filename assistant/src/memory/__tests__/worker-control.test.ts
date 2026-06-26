/**
 * Tests for `spawnMemoryWorkerProcess` — the detached worker-process spawner.
 *
 * Focuses on the readiness wait, which gates whether `assistant memory worker
 * start` reports success and flips `memory.worker.enabled`:
 *   - succeeds when the worker writes its PID file (immediately or a little
 *     late — a cold `bun run` start takes seconds),
 *   - fails fast when the child exits during startup,
 *   - on timeout, terminates a still-alive child only when asked, so the CLI
 *     (which leaves the flag off on failure) cannot orphan a worker that would
 *     then drain the queue alongside the daemon's synchronous runner.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

let tmpDir: string;
let pidPath: string;
let markerPath: string;

mock.module("../../util/platform.js", () => ({
  getMemoryWorkerPidPath: () => pidPath,
  getMemorySyncRunnerMarkerPath: () => markerPath,
}));

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
mock.module("../../util/logger.js", () => ({
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  getCurrentLogFilePath: () => join(tmpDir, "worker-control-test.log"),
}));

const { spawnMemoryWorkerProcess, MemoryWorkerSpawnError } =
  await import("../worker-control.js");

/**
 * Install a stub `Bun.spawn`. The `onSpawn` callback receives the resolved PID
 * path so a test can simulate the worker writing its PID file (now or later),
 * and returns the fake child handle.
 */
function stubBunSpawn(
  makeChild: () => {
    unref: () => void;
    kill: () => void;
    pid: number;
    exited?: Promise<unknown>;
  },
): () => void {
  const original = Bun.spawn;
  (Bun as { spawn: typeof Bun.spawn }).spawn = (() =>
    makeChild()) as unknown as typeof Bun.spawn;
  return () => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = original;
  };
}

/** A promise that never resolves — stands in for a still-alive child. */
function neverExits(): Promise<unknown> {
  return new Promise(() => {});
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "worker-control-test-"));
  pidPath = join(tmpDir, "memory-worker.pid");
  markerPath = join(tmpDir, "memory-sync-runner.pid");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("spawnMemoryWorkerProcess", () => {
  test("returns the PID when the worker writes its file immediately", async () => {
    const restore = stubBunSpawn(() => {
      writeFileSync(pidPath, "4242");
      return {
        unref: () => {},
        kill: () => {},
        pid: 4242,
        exited: neverExits(),
      };
    });
    try {
      const result = await spawnMemoryWorkerProcess({
        pidWaitTimeoutMs: 1_000,
        pidPollIntervalMs: 10,
      });
      expect(result).toEqual({ pid: 4242, alreadyRunning: false });
    } finally {
      restore();
    }
  });

  test("succeeds when the worker writes its PID file slightly late", async () => {
    const restore = stubBunSpawn(() => {
      // Worker takes ~120ms to come up — would have failed under the old 1s/10x
      // loop's tight window only if shorter; here we prove the wait spans it.
      setTimeout(() => writeFileSync(pidPath, "777"), 120);
      return {
        unref: () => {},
        kill: () => {},
        pid: 777,
        exited: neverExits(),
      };
    });
    try {
      const result = await spawnMemoryWorkerProcess({
        pidWaitTimeoutMs: 2_000,
        pidPollIntervalMs: 20,
      });
      expect(result).toEqual({ pid: 777, alreadyRunning: false });
    } finally {
      restore();
    }
  });

  test("fails fast when the child exits during startup", async () => {
    let killed = false;
    const restore = stubBunSpawn(() => ({
      unref: () => {},
      kill: () => {
        killed = true;
      },
      pid: 99,
      // Never writes a PID file; exits immediately.
      exited: Promise.resolve(1),
    }));
    try {
      await expect(
        spawnMemoryWorkerProcess({
          // Long timeout so the test only passes if early-exit short-circuits it.
          pidWaitTimeoutMs: 10_000,
          pidPollIntervalMs: 10,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(MemoryWorkerSpawnError);
      // It exited on its own — nothing to terminate.
      expect(killed).toBe(false);
    } finally {
      restore();
    }
  });

  test("terminates a still-alive child on timeout when terminateOnTimeout is set", async () => {
    let killed = false;
    const restore = stubBunSpawn(() => ({
      unref: () => {},
      kill: () => {
        killed = true;
      },
      pid: 55,
      exited: neverExits(),
    }));
    try {
      await expect(
        spawnMemoryWorkerProcess({
          pidWaitTimeoutMs: 150,
          pidPollIntervalMs: 20,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(MemoryWorkerSpawnError);
      expect(killed).toBe(true);
    } finally {
      restore();
    }
  });

  test("does not terminate the child on timeout when terminateOnTimeout is false", async () => {
    let killed = false;
    const restore = stubBunSpawn(() => ({
      unref: () => {},
      kill: () => {
        killed = true;
      },
      pid: 55,
      exited: neverExits(),
    }));
    try {
      await expect(
        spawnMemoryWorkerProcess({
          pidWaitTimeoutMs: 150,
          pidPollIntervalMs: 20,
          terminateOnTimeout: false,
        }),
      ).rejects.toBeInstanceOf(MemoryWorkerSpawnError);
      expect(killed).toBe(false);
    } finally {
      restore();
    }
  });

  test("reuses an already-running worker without spawning", async () => {
    // A live PID file (this test process) makes the probe report running.
    writeFileSync(pidPath, String(process.pid));
    let spawned = false;
    const restore = stubBunSpawn(() => {
      spawned = true;
      return { unref: () => {}, kill: () => {}, pid: 1, exited: neverExits() };
    });
    try {
      const result = await spawnMemoryWorkerProcess({ pidWaitTimeoutMs: 100 });
      expect(result).toEqual({ pid: process.pid, alreadyRunning: true });
      expect(spawned).toBe(false);
    } finally {
      restore();
    }
  });
});

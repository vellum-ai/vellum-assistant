import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  cleanupWorkerPidFile,
  startWorkerPidFileGuard,
} from "../util/worker-process.js";

const GUARD_INTERVAL_MS = 20;
const SETTLE_MS = GUARD_INTERVAL_MS * 6;

let tempDirs: string[] = [];
let disposers: Array<() => void> = [];

function mkPidFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pid-guard-test-"));
  tempDirs.push(dir);
  const path = join(dir, "worker.pid");
  writeFileSync(path, contents, "utf-8");
  return path;
}

afterEach(() => {
  for (const dispose of disposers) {
    dispose();
  }
  disposers = [];
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("cleanupWorkerPidFile", () => {
  test("removes a file naming this process", () => {
    const path = mkPidFile(String(process.pid));
    cleanupWorkerPidFile(path);
    expect(existsSync(path)).toBe(false);
  });

  test("leaves a file naming another process", () => {
    const path = mkPidFile(String(process.pid + 1));
    cleanupWorkerPidFile(path);
    expect(existsSync(path)).toBe(true);
  });

  test("no-ops on a missing file", () => {
    const path = mkPidFile(String(process.pid));
    rmSync(path);
    expect(() => cleanupWorkerPidFile(path)).not.toThrow();
  });
});

describe("startWorkerPidFileGuard", () => {
  function startGuard(path: string): { evictions: string[] } {
    const evictions: string[] = [];
    const dispose = startWorkerPidFileGuard(path, {
      intervalMs: GUARD_INTERVAL_MS,
      onEvicted: (reason) => {
        evictions.push(reason);
      },
    });
    disposers.push(dispose);
    return { evictions };
  }

  test("does not evict while the file names this process", async () => {
    const path = mkPidFile(String(process.pid));
    const { evictions } = startGuard(path);
    await Bun.sleep(SETTLE_MS);
    expect(evictions).toEqual([]);
  });

  test("evicts exactly once when the file names a successor", async () => {
    const path = mkPidFile(String(process.pid));
    const { evictions } = startGuard(path);
    writeFileSync(path, String(process.pid + 1), "utf-8");
    await Bun.sleep(SETTLE_MS);
    expect(evictions.length).toBe(1);
    expect(evictions[0]).toContain(String(process.pid + 1));
  });

  test("evicts when the file is missing", async () => {
    const path = mkPidFile(String(process.pid));
    const { evictions } = startGuard(path);
    rmSync(path);
    await Bun.sleep(SETTLE_MS);
    expect(evictions.length).toBe(1);
  });

  test("the disposer stops the guard before it can evict", async () => {
    const path = mkPidFile(String(process.pid));
    const evictions: string[] = [];
    const dispose = startWorkerPidFileGuard(path, {
      intervalMs: GUARD_INTERVAL_MS,
      onEvicted: (reason) => {
        evictions.push(reason);
      },
    });
    dispose();
    rmSync(path);
    await Bun.sleep(SETTLE_MS);
    expect(evictions).toEqual([]);
  });
});

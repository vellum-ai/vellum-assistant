import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { withLocalHatchLock } from "../lib/local-hatch-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeLockPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "vellum-hatch-lock-test-"));
  tempDirs.push(tempDir);
  return join(tempDir, "local-hatch.lock");
}

describe("withLocalHatchLock", () => {
  test("serializes startup work that shares the machine-wide lock", async () => {
    const lockPath = makeLockPath();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstReleasePromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;

    const first = withLocalHatchLock(
      async () => {
        firstStarted();
        await firstReleasePromise;
      },
      { lockPath, timeoutMs: 1_000, retryMs: 5 },
    );
    await firstStartedPromise;

    const second = withLocalHatchLock(
      async () => {
        secondEntered = true;
      },
      { lockPath, timeoutMs: 1_000, retryMs: 5 },
    );
    await Bun.sleep(20);
    expect(secondEntered).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);

    expect(secondEntered).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("recovers a lock owned by a dead process", async () => {
    const lockPath = makeLockPath();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }) + "\n",
    );

    const result = await withLocalHatchLock(async () => "started", {
      lockPath,
      timeoutMs: 1_000,
      retryMs: 5,
    });

    expect(result).toBe("started");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releases the lock when startup fails", async () => {
    const lockPath = makeLockPath();

    await expect(
      withLocalHatchLock(
        async () => {
          throw new Error("startup failed");
        },
        { lockPath },
      ),
    ).rejects.toThrow("startup failed");

    expect(existsSync(lockPath)).toBe(false);
  });
});

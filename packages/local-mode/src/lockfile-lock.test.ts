import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withLockfileLock } from "./lockfile-lock";

let dir: string;
let lockfilePath: string;
let lockDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-lock-test-"));
  lockfilePath = path.join(dir, "lockfile.json");
  lockDir = `${lockfilePath}.lock`;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("withLockfileLock", () => {
  test("runs fn, propagates its result, and removes the lock dir", () => {
    const result = withLockfileLock([lockfilePath], () => {
      expect(fs.existsSync(lockDir)).toBe(true);
      return 42;
    });
    expect(result).toEqual({ ok: true, value: 42 });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test("keys the lock to the write path, ignoring fallback paths", () => {
    const fallback = path.join(dir, "legacy.json");
    withLockfileLock([lockfilePath, fallback], () => {
      expect(fs.existsSync(lockDir)).toBe(true);
      expect(fs.existsSync(`${fallback}.lock`)).toBe(false);
    });
  });

  test("releases the lock when fn throws, rethrowing", () => {
    expect(() =>
      withLockfileLock([lockfilePath], () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test("is reentrant within the process", () => {
    const result = withLockfileLock([lockfilePath], () => {
      const inner = withLockfileLock([lockfilePath], () => "inner");
      expect(inner).toEqual({ ok: true, value: "inner" });
      // Inner exit must not release the outer hold.
      expect(fs.existsSync(lockDir)).toBe(true);
      return "outer";
    });
    expect(result).toEqual({ ok: true, value: "outer" });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test("fails cleanly within budget when another holder is fresh", () => {
    fs.mkdirSync(lockDir);
    let ran = false;
    const start = Date.now();
    const result = withLockfileLock([lockfilePath], () => {
      ran = true;
    });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Timed out acquiring lockfile lock");
    }
    // The other holder's lock is untouched.
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  test("breaks a stale lock left by a crashed holder", () => {
    fs.mkdirSync(lockDir);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, past, past);

    const result = withLockfileLock([lockfilePath], () => "ran");
    expect(result).toEqual({ ok: true, value: "ran" });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test("breaks a stale lock whose recorded owner process is dead", () => {
    // A synchronously-spawned child has exited by the time spawnSync returns.
    const deadPid = spawnSync(process.execPath, ["--version"]).pid;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), String(deadPid));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, past, past);

    const result = withLockfileLock([lockfilePath], () => "ran");
    expect(result).toEqual({ ok: true, value: "ran" });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test("never steals a stale-aged lock whose owner is still alive", () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), String(process.pid));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, past, past);

    let ran = false;
    const result = withLockfileLock([lockfilePath], () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(path.join(lockDir, "owner"), "utf-8")).toBe(
      String(process.pid),
    );
  });

  test("breaks a hard-stale lock even when the recorded owner pid is alive", () => {
    // Models a crashed holder whose pid was recycled to a live process: past
    // the hard ceiling the pid check no longer keeps the lock alive.
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), String(process.pid));
    const past = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(lockDir, past, past);

    const result = withLockfileLock([lockfilePath], () => "ran");
    expect(result).toEqual({ ok: true, value: "ran" });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test("records this process as the owner while the lock is held", () => {
    withLockfileLock([lockfilePath], () => {
      expect(fs.readFileSync(path.join(lockDir, "owner"), "utf-8")).toBe(
        String(process.pid),
      );
    });
  });

  test("release leaves a lock re-acquired by another owner untouched", () => {
    const result = withLockfileLock([lockfilePath], () => {
      // Simulate a break-and-reacquire while suspended: another process now
      // records itself as the owner of the lock path.
      fs.writeFileSync(path.join(lockDir, "owner"), String(process.pid + 1));
      return "ran";
    });
    expect(result).toEqual({ ok: true, value: "ran" });
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(path.join(lockDir, "owner"), "utf-8")).toBe(
      String(process.pid + 1),
    );
  });

  test("creates a missing parent directory and acquires", () => {
    const nested = path.join(dir, "a", "b", "lockfile.json");
    const result = withLockfileLock([nested], () => "ran");
    expect(result).toEqual({ ok: true, value: "ran" });
    expect(fs.existsSync(`${nested}.lock`)).toBe(false);
  });

  test("refuses an empty path list", () => {
    expect(withLockfileLock([], () => "never").ok).toBe(false);
  });
});

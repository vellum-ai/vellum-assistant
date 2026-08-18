import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

/**
 * Tests for the cross-process snapshot lock helper. Each test gets a fresh
 * temp directory so runs never collide with the real `~/.vellum/backups`
 * directory and so parallel test workers never see each other's lock files.
 *
 * The interesting corners covered here are:
 *   - Acquire → release round-trip leaves the filesystem clean
 *   - A second acquire against a held lock throws with the expected prefix
 *   - A dead-PID lock file (simulated by writing a garbage PID that is not
 *     alive on this host) is taken over transparently
 *   - The release function is idempotent — calling it twice is a no-op
 *   - The lock file is created with mode `0o600` so an unprivileged
 *     peer on the same machine cannot read the holder PID
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { acquireSnapshotLock } from "../snapshot-lock.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let ROOT: string;
let LOCK: string;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "vellum-snapshot-lock-"));
  LOCK = join(ROOT, ".snapshot.lock");
});

afterEach(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — happy path", () => {
  test("acquire creates the lock file; release removes it", async () => {
    expect(existsSync(LOCK)).toBe(false);

    const release = await acquireSnapshotLock(LOCK);
    expect(existsSync(LOCK)).toBe(true);

    await release();
    expect(existsSync(LOCK)).toBe(false);
  });

  test("lock file is created with mode 0o600", async () => {
    const release = await acquireSnapshotLock(LOCK);
    try {
      const stats = statSync(LOCK);
      // mask to permission bits only
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await release();
    }
  });

  test("acquire creates the parent directory if missing", async () => {
    // Point the lock at a nested path whose parent does not exist yet so
    // we exercise the mkdir-on-demand code path.
    const nested = join(ROOT, "missing-parent", ".snapshot.lock");
    expect(existsSync(join(ROOT, "missing-parent"))).toBe(false);

    const release = await acquireSnapshotLock(nested);
    try {
      expect(existsSync(nested)).toBe(true);
    } finally {
      await release();
    }
  });
});

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — conflicts", () => {
  test("two acquires against a live holder: second throws 'snapshot in progress'", async () => {
    const release = await acquireSnapshotLock(LOCK);
    try {
      await expect(acquireSnapshotLock(LOCK)).rejects.toThrow(
        /snapshot in progress/,
      );
    } finally {
      await release();
    }
  });

  test("conflict error includes the holder PID", async () => {
    const release = await acquireSnapshotLock(LOCK);
    try {
      await expect(acquireSnapshotLock(LOCK)).rejects.toThrow(
        new RegExp(`snapshot in progress \\(locked by pid ${process.pid}\\)`),
      );
    } finally {
      await release();
    }
  });
});

// ---------------------------------------------------------------------------
// Stale-lock takeover
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — stale locks", () => {
  test("dead PID: acquire takes over and creates a fresh lock", async () => {
    // PID 2^31 - 1 is virtually guaranteed to be dead on any sane host —
    // the platform PID_MAX is typically much smaller. Writing it as the
    // lock holder simulates a crashed prior writer whose process has since
    // exited without releasing.
    const deadPid = 2_147_483_647;
    writeFileSync(LOCK, `${deadPid} ${Date.now()}\n`, { mode: 0o600 });
    expect(existsSync(LOCK)).toBe(true);

    const release = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release();
    }
    expect(existsSync(LOCK)).toBe(false);
  });

  test("unparseable lock file: acquire takes it over", async () => {
    // A lock file that contains garbage (no digits) has no recoverable
    // holder PID — treat it as stale and take over.
    writeFileSync(LOCK, "not a pid at all\n", { mode: 0o600 });

    const release = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release();
    }
    expect(existsSync(LOCK)).toBe(false);
  });

  test("empty lock file: acquire takes it over", async () => {
    writeFileSync(LOCK, "", { mode: 0o600 });

    const release = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release();
    }
    expect(existsSync(LOCK)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Release semantics
// ---------------------------------------------------------------------------

describe("acquireSnapshotLock — release", () => {
  test("release is idempotent: calling twice is safe", async () => {
    const release = await acquireSnapshotLock(LOCK);
    await release();
    // Second call must not throw, even though the file is already gone.
    await release();
    expect(existsSync(LOCK)).toBe(false);
  });

  test("release tolerates an externally-unlinked lock file", async () => {
    const release = await acquireSnapshotLock(LOCK);
    // Simulate another process (or a rogue admin) removing our lock file
    // out from under us. Release must still return without throwing.
    rmSync(LOCK, { force: true });
    await release();
  });

  test("after release, the lock can be acquired again", async () => {
    const release1 = await acquireSnapshotLock(LOCK);
    await release1();

    const release2 = await acquireSnapshotLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release2();
    }
  });
});
